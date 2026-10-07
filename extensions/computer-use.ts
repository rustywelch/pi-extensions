/**
 * Computer-use extension - drive the macOS desktop from Pi.
 *
 * Registers one `computer` tool. Screenshots use `screencapture`; mouse, keyboard,
 * window listing and the accessibility tree go through a small Swift helper
 * (computer-use/cu.swift) that is compiled once into ~/.cache/pi-computer-use/cu.
 *
 * Needs two macOS permissions for the app that runs Pi (Terminal, iTerm, the Claude desktop app):
 * Accessibility (input and the UI tree) and Screen Recording (screenshots).
 *
 * Coordinates are global screen points, origin top-left. After a screenshot the tool remembers the
 * capture's origin, so with `app` set (window capture) you pass coordinates as they appear in the image.
 * Corti One is the default target: `app` defaults to PI_COMPUTER_APP or "Corti One".
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const ACTIONS = [
	"open_app",
	"list_windows",
	"screenshot",
	"ui_tree",
	"click",
	"double_click",
	"right_click",
	"move",
	"drag",
	"scroll",
	"type",
	"key",
	"wait",
	"permissions",
] as const;
type Action = (typeof ACTIONS)[number];

const DEFAULT_APP = process.env.PI_COMPUTER_APP || "Corti One";
const MAX_CHARS = 20000;
const HELPER_DIR = join(homedir(), ".cache", "pi-computer-use");
const HELPER = join(HELPER_DIR, "cu");
const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "computer-use", "cu.swift");

const Params = Type.Object({
	action: Type.String({
		description:
			"One of: open_app, list_windows, screenshot, ui_tree, click, double_click, right_click, move, drag, scroll, type, key, wait, permissions. " +
			"open_app launches or focuses the app. screenshot captures the app window (or the whole screen with fullscreen=true). " +
			"ui_tree lists labeled elements with click centers, prefer it to guessing from pixels. " +
			"key takes combos like cmd+s, return, escape, cmd+shift+t. click/move/drag/scroll use screenshot-image coordinates.",
	}),
	app: Type.Optional(
		Type.String({ description: `App name. Defaults to "${DEFAULT_APP}". Used by open_app, screenshot, ui_tree and to focus before input.` }),
	),
	x: Type.Optional(Type.Number({ description: "click/move/scroll: x. drag: start x" })),
	y: Type.Optional(Type.Number({ description: "click/move/scroll: y. drag: start y" })),
	x2: Type.Optional(Type.Number({ description: "drag: end x" })),
	y2: Type.Optional(Type.Number({ description: "drag: end y" })),
	dx: Type.Optional(Type.Number({ description: "scroll: horizontal lines, positive is right" })),
	dy: Type.Optional(Type.Number({ description: "scroll: vertical lines, positive is down (reveals lower content)" })),
	text: Type.Optional(Type.String({ description: "type: text to enter at the focused field. key: combo, space-separate several" })),
	seconds: Type.Optional(Type.Number({ description: "wait: seconds, max 30" })),
	fullscreen: Type.Optional(Type.Boolean({ description: "screenshot: capture the whole main display instead of the app window" })),
	max_depth: Type.Optional(Type.Number({ description: "ui_tree: max nesting depth, default 14" })),
	limit: Type.Optional(Type.Number({ description: "ui_tree: max elements, default 400" })),
});

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { signal, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`${cmd} ${args.join(" ")}: ${stderr?.trim() || stdout?.trim() || (err as Error).message}`));
				return;
			}
			resolve(stdout);
		});
	});
}

/** Compile the Swift helper on first use, and again when the source is newer than the binary. */
async function ensureHelper(signal?: AbortSignal): Promise<void> {
	if (existsSync(HELPER)) {
		const [bin, src] = await Promise.all([stat(HELPER), stat(SOURCE).catch(() => null)]);
		if (!src || bin.mtimeMs >= src.mtimeMs) return;
	}
	if (!existsSync(SOURCE)) throw new Error(`Helper source missing at ${SOURCE}`);
	await mkdir(HELPER_DIR, { recursive: true });
	try {
		await run("swiftc", ["-O", SOURCE, "-o", HELPER], signal);
	} catch (e) {
		throw new Error(`Could not compile the desktop helper (needs Xcode command line tools: xcode-select --install). ${(e as Error).message}`);
	}
}

const cu = (args: string[], signal?: AbortSignal) => run(HELPER, args, signal);

interface Win {
	id: number;
	pid: number;
	app: string;
	title: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

async function windows(signal?: AbortSignal): Promise<Win[]> {
	return JSON.parse(await cu(["windows"], signal)) as Win[];
}

/** Frontmost window whose owner name matches, case-insensitive, exact before substring. */
function findWindow(list: Win[], app: string): Win | undefined {
	const q = app.toLowerCase();
	return list.find((w) => w.app.toLowerCase() === q) ?? list.find((w) => w.app.toLowerCase().includes(q));
}

async function openApp(app: string, signal?: AbortSignal): Promise<Win> {
	await run("open", ["-a", app], signal).catch((e) => {
		throw new Error(`Could not open "${app}". ${(e as Error).message}`);
	});
	for (let i = 0; i < 20; i++) {
		const w = findWindow(await windows(signal), app);
		if (w) return w;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`"${app}" launched but no window appeared. It may be minimized, on another Space, or showing a sign-in sheet.`);
}

interface ToolResult {
	content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
	details: Record<string, unknown>;
}

const ok = (t: string, details: Record<string, unknown> = {}): ToolResult => ({
	content: [{ type: "text", text: t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + "\n[truncated]" : t }],
	details,
});

export default function (pi: ExtensionAPI) {
	// Origin of the last capture in global points, so image coordinates map to screen coordinates.
	let origin = { x: 0, y: 0 };

	pi.registerTool({
		name: "computer",
		label: "Computer",
		description:
			`Use the Mac desktop like a person: open an app, screenshot it (returned as an image), read its accessibility tree, click, type, press keys, scroll, drag. Default app is "${DEFAULT_APP}". ` +
			"Loop: open_app, then ui_tree or screenshot, act, screenshot again to verify. Never type passwords or secrets: if a sign-in or credential prompt appears, stop and ask the user to complete it. " +
			"Confirm with the user before any irreversible click (submit, send, delete, approve).",
		parameters: Params,

		async execute(_id, params, signal): Promise<ToolResult> {
			const action = params.action as Action;
			if (!ACTIONS.includes(action)) throw new Error(`Unknown action ${JSON.stringify(params.action)}. Valid: ${ACTIONS.join(", ")}`);
			if (process.platform !== "darwin") throw new Error("The computer tool only supports macOS.");

			const app = params.app || DEFAULT_APP;

			if (action === "wait") {
				const s = Math.min(Math.max(params.seconds ?? 1, 0), 30);
				await new Promise((r) => setTimeout(r, s * 1000));
				return ok(`Waited ${s}s`);
			}

			await ensureHelper(signal);

			if (action === "permissions") return ok((await cu(["trusted", "--prompt"], signal)).trim());

			if (action === "list_windows") {
				const list = await windows(signal);
				return ok(
					list.length
						? list.map((w) => `${w.app} (pid ${w.pid}) ${JSON.stringify(w.title)} at ${w.x},${w.y} ${w.w}x${w.h}`).join("\n")
						: "No on-screen windows.",
				);
			}

			if (action === "open_app") {
				const w = await openApp(app, signal);
				origin = { x: w.x, y: w.y };
				return ok(`${w.app} is open: window ${JSON.stringify(w.title)} at ${w.x},${w.y} ${w.w}x${w.h}`, { pid: w.pid });
			}

			if (action === "screenshot") {
				const dir = await mkdtemp(join(tmpdir(), "pi-computer-"));
				try {
					const file = join(dir, "shot.png");
					let label: string;
					if (params.fullscreen) {
						await run("screencapture", ["-x", "-t", "png", file], signal);
						origin = { x: 0, y: 0 };
						label = "Full screen";
					} else {
						const w = findWindow(await windows(signal), app) ?? (await openApp(app, signal));
						await run("screencapture", ["-x", "-o", "-t", "png", "-l", String(w.id), file], signal);
						origin = { x: w.x, y: w.y };
						label = `${w.app} window ${w.w}x${w.h}`;
						// Retina captures are 2x pixels. Resize to points so image coordinates equal click coordinates.
						await run("sips", ["-z", String(Math.round(w.h)), String(Math.round(w.w)), file], signal).catch(() => {});
					}
					const data = (await readFile(file)).toString("base64");
					return {
						content: [
							{ type: "image", data, mimeType: "image/png" },
							{ type: "text", text: `${label}. Coordinates in this image are what click and move expect.` },
						],
						details: { action, origin },
					};
				} finally {
					await rm(dir, { recursive: true, force: true });
				}
			}

			if (action === "ui_tree") {
				const w = findWindow(await windows(signal), app) ?? (await openApp(app, signal));
				const out = await cu(["tree", String(w.pid), String(params.max_depth ?? 14), String(params.limit ?? 400)], signal);
				return ok(`Centers are global screen points; pass them straight to click.\n${out}`, { pid: w.pid });
			}

			// Everything below is input. Focus the target app first so events land in it.
			await run("open", ["-a", app], signal).catch(() => {});
			await new Promise((r) => setTimeout(r, 150));
			const gx = (v?: number) => String((v ?? NaN) + origin.x);
			const gy = (v?: number) => String((v ?? NaN) + origin.y);
			const need = (...vals: (number | undefined)[]) => {
				if (vals.some((v) => v == null)) throw new Error(`${action} needs ${action === "drag" ? "x, y, x2, y2" : "x and y"}`);
			};

			switch (action) {
				case "click":
				case "double_click":
				case "right_click": {
					need(params.x, params.y);
					const button = action === "right_click" ? "right" : "left";
					await cu(["click", gx(params.x), gy(params.y), button, action === "double_click" ? "2" : "1"], signal);
					return ok(`${action} at (${params.x}, ${params.y})`);
				}
				case "move":
					need(params.x, params.y);
					await cu(["move", gx(params.x), gy(params.y)], signal);
					return ok(`Moved to (${params.x}, ${params.y})`);
				case "drag":
					need(params.x, params.y, params.x2, params.y2);
					await cu(["drag", gx(params.x), gy(params.y), gx(params.x2), gy(params.y2)], signal);
					return ok(`Dragged (${params.x}, ${params.y}) to (${params.x2}, ${params.y2})`);
				case "scroll":
					need(params.x, params.y);
					await cu(["scroll", gx(params.x), gy(params.y), String(params.dx ?? 0), String(params.dy ?? 0)], signal);
					return ok(`Scrolled at (${params.x}, ${params.y}) by dx=${params.dx ?? 0} dy=${params.dy ?? 0}`);
				case "type":
					if (!params.text) throw new Error("type needs text");
					await cu(["type", params.text], signal);
					return ok(`Typed ${params.text.length} characters`);
				case "key":
					if (!params.text) throw new Error("key needs text, for example cmd+s");
					await cu(["key", ...params.text.split(/\s+/).filter(Boolean)], signal);
					return ok(`Pressed ${params.text}`);
			}
			throw new Error(`Unhandled action ${action}`);
		},
	});
}
