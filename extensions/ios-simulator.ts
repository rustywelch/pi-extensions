/**
 * iOS Simulator extension - drive the iOS Simulator from Pi.
 *
 * Registers one `ios_simulator` tool. Lifecycle, screenshots, install, launch
 * and URLs go through `xcrun simctl`, which ships with Xcode. Touch input
 * (tap, swipe, type, hardware buttons, accessibility tree) is not part of
 * simctl, so those actions shell out to AXe (https://github.com/cameroncooke/AXe):
 *
 *   brew install cameroncooke/axe/axe
 *
 * Without AXe the lifecycle and screenshot actions still work and the input
 * actions return an install hint instead of failing obscurely.
 */

import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ACTIONS = [
	"list",
	"boot",
	"shutdown",
	"launch",
	"terminate",
	"screenshot",
	"describe_ui",
	"tap",
	"swipe",
	"type",
	"button",
	"open_url",
	"show",
] as const;
type Action = (typeof ACTIONS)[number];

const MAX_CHARS = 20000;

const Params = Type.Object({
	action: Type.String({
		description:
			"One of: list, boot, shutdown, launch, terminate, screenshot, describe_ui, tap, swipe, type, button, open_url, show. show opens the Simulator window so the user can see and drive the device themselves, for example to enter credentials. " +
			"launch installs the .app at app_path (if given) and starts bundle_id. describe_ui returns one line per labeled element with its tap-target center, prefer it to guessing coordinates.",
	}),
	device: Type.Optional(
		Type.String({ description: "Simulator name or UDID. Defaults to the booted simulator (boot picks the newest iPhone)" }),
	),
	app_path: Type.Optional(Type.String({ description: "launch: path to a built .app bundle to install first" })),
	bundle_id: Type.Optional(Type.String({ description: "launch/terminate: app bundle identifier" })),
	url: Type.Optional(Type.String({ description: "open_url: URL or deep link" })),
	x: Type.Optional(Type.Number({ description: "tap: x in device points. swipe: start x" })),
	y: Type.Optional(Type.Number({ description: "tap: y in device points. swipe: start y" })),
	x2: Type.Optional(Type.Number({ description: "swipe: end x" })),
	y2: Type.Optional(Type.Number({ description: "swipe: end y" })),
	label: Type.Optional(Type.String({ description: "tap: tap the element with this accessibility label instead of x/y" })),
	id: Type.Optional(Type.String({ description: "tap: tap the element with this accessibilityIdentifier instead of x/y" })),
	duration: Type.Optional(Type.Number({ description: "swipe: gesture seconds. button: seconds held" })),
	text: Type.Optional(Type.String({ description: "type: text to enter into the focused field" })),
	name: Type.Optional(Type.String({ description: "button: home, lock, side-button, siri, apple-pay" })),
});

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { signal, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
			if (err) {
				const detail = stderr?.trim() || stdout?.trim() || (err as Error).message;
				reject(new Error(`${cmd} ${args.join(" ")}: ${detail}`));
				return;
			}
			resolve(stdout);
		});
	});
}

/**
 * AXe's accessibility session is not ready for a while after boot and fails with
 * a timeout until it is. Retry only that error, a few times, before giving up.
 */
async function runAxe(args: string[], signal?: AbortSignal): Promise<string> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await run("axe", args, signal);
		} catch (e) {
			const warmingUp = /Timed out creating the simulator remote automation session/.test((e as Error).message);
			if (!warmingUp || attempt >= 4) throw e;
			await new Promise((r) => setTimeout(r, 3000));
		}
	}
}

async function hasAxe(): Promise<boolean> {
	try {
		await run("axe", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

interface SimDevice {
	name: string;
	udid: string;
	state: string;
	runtime: string;
}

async function listDevices(signal?: AbortSignal): Promise<SimDevice[]> {
	const raw = await run("xcrun", ["simctl", "list", "devices", "available", "--json"], signal);
	const parsed = JSON.parse(raw) as { devices: Record<string, { name: string; udid: string; state: string }[]> };
	const out: SimDevice[] = [];
	for (const [runtime, devs] of Object.entries(parsed.devices)) {
		for (const d of devs) out.push({ ...d, runtime: runtime.replace(/^.*SimRuntime\./, "") });
	}
	return out;
}

/** Resolve a name/UDID to a UDID, or fall back to the booted simulator. */
async function resolveDevice(device: string | undefined, signal?: AbortSignal): Promise<string> {
	const devices = await listDevices(signal);
	if (devices.length === 0) {
		throw new Error(
			"No simulator devices are available. Install an iOS runtime (Xcode > Settings > Components, or `xcodebuild -downloadPlatform iOS`).",
		);
	}
	if (device) {
		const hit = devices.find((d) => d.udid === device) ?? devices.find((d) => d.name === device);
		if (!hit) throw new Error(`No simulator named or with UDID ${JSON.stringify(device)}. Use action 'list'.`);
		return hit.udid;
	}
	const booted = devices.find((d) => d.state === "Booted");
	if (!booted) throw new Error("No simulator is booted. Use action 'boot' first.");
	return booted.udid;
}

interface ToolResult {
	content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
	details: Record<string, unknown>;
}

interface AxNode {
	type?: string;
	AXLabel?: string | null;
	AXUniqueId?: string | null;
	AXValue?: string | null;
	enabled?: boolean;
	frame?: { x: number; y: number; width: number; height: number };
	children?: AxNode[];
}

/**
 * AXe prints the accessibility tree as deeply indented JSON, about 1.5 KB per element.
 * Flatten it to one line per element that has a label, id or value, with the tap-target
 * center, so a whole screen fits in the model's context.
 */
function flattenTree(raw: string): string {
	let roots: AxNode[];
	try {
		const parsed = JSON.parse(raw);
		roots = Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return raw;
	}
	const lines: string[] = [];
	const walk = (n: AxNode) => {
		if (n.AXLabel || n.AXUniqueId || n.AXValue) {
			const f = n.frame;
			const pos = f
				? ` center=(${Math.round(f.x + f.width / 2)},${Math.round(f.y + f.height / 2)}) frame=${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.width)}x${Math.round(f.height)}`
				: "";
			const bits = [n.type ?? "Element"];
			if (n.AXLabel) bits.push(JSON.stringify(n.AXLabel));
			if (n.AXUniqueId) bits.push(`id=${n.AXUniqueId}`);
			if (n.AXValue) bits.push(`value=${JSON.stringify(n.AXValue)}`);
			if (n.enabled === false) bits.push("disabled");
			lines.push(bits.join(" ") + pos);
		}
		for (const c of n.children ?? []) walk(c);
	};
	roots.forEach(walk);
	return lines.length ? lines.join("\n") : "No labeled elements on screen.";
}

/**
 * Open the app that mirrors a booted simulator so the user can watch and drive it.
 * Xcode 27 replaced Simulator.app with Device Hub, so try Simulator first and fall
 * back to Device Hub inside the selected Xcode. Returns the app opened, or null.
 */
async function showWindow(udid: string, signal?: AbortSignal): Promise<string | null> {
	try {
		await run("open", ["-a", "Simulator", "--args", "-CurrentDeviceUDID", udid], signal);
		return "Simulator";
	} catch {
		// not installed, try Device Hub
	}
	try {
		const dev = (await run("xcode-select", ["-p"], signal)).trim();
		await run("open", ["-a", join(dev, "..", "Applications", "DeviceHub.app")], signal);
		return "Device Hub";
	} catch {
		return null;
	}
}

function text(t: string) {
	return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + "\n[truncated]" : t;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ios_simulator",
		label: "iOS Simulator",
		description:
			"Run and drive the iOS Simulator: boot a device, install and launch a built .app, take screenshots (returned as images), read the accessibility tree, tap, swipe, type, press hardware buttons, open URLs. Coordinates are device points with the origin at top-left. Typical loop: launch, screenshot or describe_ui, act, screenshot again to verify.",
		parameters: Params,

		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			const action = params.action as Action;
			if (!ACTIONS.includes(action)) {
				throw new Error(`Unknown action ${JSON.stringify(params.action)}. Valid: ${ACTIONS.join(", ")}`);
			}

			if (action === "list") {
				const devices = await listDevices(signal);
				const body = devices.length
					? devices.map((d) => `${d.state.padEnd(9)} ${d.udid}  ${d.name} (${d.runtime})`).join("\n")
					: "No available simulator devices. Install an iOS runtime with `xcodebuild -downloadPlatform iOS`.";
				return { content: [{ type: "text", text: text(body) }], details: { action, count: devices.length } };
			}

			if (action === "boot") {
				const devices = await listDevices(signal);
				let target = params.device
					? devices.find((d) => d.udid === params.device || d.name === params.device)
					: [...devices].reverse().find((d) => d.name.startsWith("iPhone"));
				if (!target) throw new Error("No matching simulator to boot. Use action 'list'.");
				if (target.state !== "Booted") await run("xcrun", ["simctl", "boot", target.udid], signal);
				await run("xcrun", ["simctl", "bootstatus", target.udid, "-b"], signal);
				const shown = await showWindow(target.udid, signal);
				// bootstatus returns before SpringBoard draws, so early screenshots come back black.
				await new Promise((r) => setTimeout(r, 3000));
				return {
					content: [
						{
							type: "text",
							text:
								`Booted ${target.name} (${target.udid}). ` +
								(shown === "Device Hub"
									? "Opened Device Hub; the user picks this device in its sidebar to see and drive it."
									: shown
										? `Opened ${shown}.`
										: "No window app found; the simulator is running headless."),
						},
					],
					details: { action, udid: target.udid },
				};
			}

			const udid = await resolveDevice(params.device, signal);

			switch (action) {
				case "show": {
					const shown = await showWindow(udid, signal);
					if (!shown) throw new Error("Neither Simulator.app nor Device Hub was found in the selected Xcode.");
					return {
						content: [
							{
								type: "text",
								text:
									shown === "Device Hub"
										? `Opened Device Hub. The user selects ${udid} in its sidebar to see and drive the device.`
										: `Opened ${shown} showing ${udid}.`,
							},
						],
						details: { action, udid, app: shown },
					};
				}

				case "shutdown": {
					await run("xcrun", ["simctl", "shutdown", udid], signal);
					return { content: [{ type: "text", text: `Shut down ${udid}` }], details: { action, udid } };
				}

				case "launch": {
					if (!params.bundle_id && !params.app_path) throw new Error("launch needs bundle_id or app_path");
					if (params.app_path) await run("xcrun", ["simctl", "install", udid, params.app_path], signal);
					let bundle = params.bundle_id;
					if (!bundle && params.app_path) {
						bundle = (
							await run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(params.app_path, "Info.plist")], signal)
						).trim();
					}
					const out = await run("xcrun", ["simctl", "launch", udid, bundle!], signal);
					return { content: [{ type: "text", text: out.trim() || `Launched ${bundle}` }], details: { action, udid, bundle } };
				}

				case "terminate": {
					if (!params.bundle_id) throw new Error("terminate needs bundle_id");
					await run("xcrun", ["simctl", "terminate", udid, params.bundle_id], signal);
					return { content: [{ type: "text", text: `Terminated ${params.bundle_id}` }], details: { action, udid } };
				}

				case "open_url": {
					if (!params.url) throw new Error("open_url needs url");
					await run("xcrun", ["simctl", "openurl", udid, params.url], signal);
					return { content: [{ type: "text", text: `Opened ${params.url}` }], details: { action, udid } };
				}

				case "screenshot": {
					const dir = await mkdtemp(join(tmpdir(), "pi-sim-"));
					try {
						const file = join(dir, "shot.png");
						await run("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", file], signal);
						const data = (await readFile(file)).toString("base64");
						return {
							content: [
								{ type: "image", data, mimeType: "image/png" },
								{ type: "text", text: `Screenshot of ${udid}` },
							],
							details: { action, udid },
						};
					} finally {
						await rm(dir, { recursive: true, force: true });
					}
				}
			}

			// Everything below is touch/keyboard input and needs AXe.
			if (!(await hasAxe())) {
				throw new Error(
					`'${action}' needs AXe for input injection (simctl cannot tap or type). Install: brew install cameroncooke/axe/axe`,
				);
			}

			switch (action) {
				case "describe_ui": {
					const out = await runAxe(["describe-ui", "--udid", udid], signal);
					return { content: [{ type: "text", text: text(flattenTree(out)) }], details: { action, udid } };
				}

				case "tap": {
					const args = ["tap", "--udid", udid];
					let what: string;
					if (params.x != null && params.y != null) {
						args.push("-x", String(params.x), "-y", String(params.y));
						what = `(${params.x}, ${params.y})`;
					} else if (params.id) {
						args.push("--id", params.id);
						what = `id ${params.id}`;
					} else if (params.label) {
						args.push("--label", params.label);
						what = `label ${JSON.stringify(params.label)}`;
					} else {
						throw new Error("tap needs x and y, or id, or label");
					}
					await runAxe(args, signal);
					return { content: [{ type: "text", text: `Tapped ${what}` }], details: { action, udid } };
				}

				case "swipe": {
					if (params.x == null || params.y == null || params.x2 == null || params.y2 == null) {
						throw new Error("swipe needs x, y, x2, y2");
					}
					const args = [
						"swipe",
						"--start-x", String(params.x),
						"--start-y", String(params.y),
						"--end-x", String(params.x2),
						"--end-y", String(params.y2),
						"--udid", udid,
					];
					if (params.duration) args.push("--duration", String(params.duration));
					await runAxe(args, signal);
					return {
						content: [{ type: "text", text: `Swiped (${params.x}, ${params.y}) to (${params.x2}, ${params.y2})` }],
						details: { action, udid },
					};
				}

				case "type": {
					if (!params.text) throw new Error("type needs text");
					await runAxe(["type", params.text, "--udid", udid], signal);
					return { content: [{ type: "text", text: `Typed ${params.text.length} characters` }], details: { action, udid } };
				}

				case "button": {
					if (!params.name) throw new Error("button needs name");
					const bargs = ["button", params.name, "--udid", udid];
					if (params.duration) bargs.push("--duration", String(params.duration));
					await runAxe(bargs, signal);
					return { content: [{ type: "text", text: `Pressed ${params.name}` }], details: { action, udid } };
				}
			}

			throw new Error(`Unhandled action ${action}`);
		},
	});
}
