/**
 * Context awareness - tell the model how full its context window is on every request.
 *
 * Pi shows context usage in the footer, but the model never sees it. This appends one
 * short note to the end of every model request, including each step of a multi-tool
 * run, with the same usage figure the footer shows and the distance to auto-compaction.
 *
 * The note is added in the `context` event, which is request-local: it is never written
 * to the session, so it does not pile up in the transcript or get summarized at
 * compaction. Appending at the end keeps the cached prompt prefix intact.
 *
 * Also registers `context_status` so the model can check on demand, and a `/context-note`
 * command that shows the note the model would see next.
 *
 * Self-compaction: from 60% full the note suggests compacting at a clean boundary, and the
 * `compact_now` tool queues Pi's own compaction with keep/next-step instructions, ends the turn,
 * and resumes the model automatically when compaction finishes. `/compact-now` does the same for
 * you, without the automatic resume. PI_COMPACT_MIN_PERCENT overrides the 50% floor for testing.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_RESERVE_TOKENS = 16384;
const WARN_PERCENT = 75;
const CRITICAL_PERCENT = 90;

// Same lookup order Pi documents: model override, then the ordinary setting, then the default.
function reserveTokensFor(modelKey: string | null): number {
	try {
		const settings = JSON.parse(readFileSync(join(homedir(), ".pi/agent/settings.json"), "utf8"));
		const compaction = settings?.compaction ?? {};
		const override = modelKey ? compaction.modelOverrides?.[modelKey]?.reserveTokens : undefined;
		if (Number.isSafeInteger(override) && override >= 0) return override;
		if (Number.isSafeInteger(compaction.reserveTokens) && compaction.reserveTokens >= 0) return compaction.reserveTokens;
	} catch {
		// Unreadable settings fall through to Pi's built-in default.
	}
	return DEFAULT_RESERVE_TOKENS;
}

function fmt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function buildNote(ctx: ExtensionContext): string | null {
	const usage = ctx.getContextUsage();
	const window = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!window) return null;

	const modelKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null;
	if (usage?.tokens == null) {
		return `[Context status] Window ${fmt(window)} tokens. Current usage is unknown (just compacted or no reply yet).`;
	}

	const used = usage.tokens;
	const percent = usage.percent ?? (used / window) * 100;
	const untilCompaction = Math.max(0, window - reserveTokensFor(modelKey) - used);
	const lines = [
		`[Context status] ${fmt(used)} / ${fmt(window)} tokens used (${percent.toFixed(1)}%). ` +
			`About ${fmt(untilCompaction)} tokens until Pi auto-compacts and summarizes older turns. ` +
			`This figure is from the last reply and may not yet count the newest tool results.`,
	];
	if (percent >= CRITICAL_PERCENT) {
		lines.push(
			"Context is nearly full. Finish the current step, write durable results to files now, and avoid large reads.",
		);
	} else if (percent >= WARN_PERCENT) {
		lines.push(
			"Context is getting full. Prefer targeted reads (line ranges, grep) over whole files, and save important findings to files before they are summarized away.",
		);
	}
	if (percent >= PRIME_PERCENT && compactAllowedNow(used, window).ok) {
		lines.push(
			"This is a good time to compact IF you are at a clean boundary: the current task is finished, tests are green, " +
				"and notes or handoff files are saved. If so, call compact_now with what to keep and your next step; you will be " +
				"resumed automatically. Never call it in the middle of an edit.",
		);
	}
	return lines.join("\n");
}

// ---- Self-compaction -------------------------------------------------------------------------
//
// compact_now queues Pi's own compaction (the agent must be idle, so it runs as soon as this turn
// ends) and, when it completes, sends one resume message so the model continues without you.
// Guards: a minimum fill level, a cooldown until context grows again, and a per-session cap on
// automatic resumes so it can never loop.

const PRIME_PERCENT = 60;
const MIN_COMPACT_PERCENT = Number(process.env.PI_COMPACT_MIN_PERCENT ?? 50);
const COOLDOWN_PERCENT_POINTS = 20;
const MAX_AUTO_RESUMES = 5;

let compacting = false;
let autoResumes = 0;
let percentAfterLastCompaction: number | null = null;

function compactAllowedNow(used: number, window: number): { ok: boolean; reason?: string } {
	const percent = (used / window) * 100;
	if (compacting) return { ok: false, reason: "A compaction is already queued or running." };
	if (autoResumes >= MAX_AUTO_RESUMES)
		return { ok: false, reason: `Self-compaction limit reached for this session (${MAX_AUTO_RESUMES}).` };
	if (percent < MIN_COMPACT_PERCENT)
		return { ok: false, reason: `Context is only ${percent.toFixed(1)}% full; compact at ${MIN_COMPACT_PERCENT}% or more.` };
	if (percentAfterLastCompaction !== null && percent < percentAfterLastCompaction + COOLDOWN_PERCENT_POINTS)
		return { ok: false, reason: "Context has not grown enough since the last compaction." };
	return { ok: true };
}

function compactionInstructions(keep: string, nextStep: string): string {
	return [
		"Preserve, precisely: the current task and its next step; paths of files read, changed, or created; test and",
		"check status; decisions made and their reasons; open problems; the sprint brief or handoff file paths.",
		"Drop: exploration output, full file contents, long tool output, and superseded attempts.",
		`The agent's own priorities for what to keep: ${keep}`,
		`The agent's next step after compaction: ${nextStep}`,
	].join(" ");
}

function resumeMessage(nextStep: string): string {
	return (
		"[Automatic resume after self-compaction] The summary above holds the state of this work. " +
		`Continue with: ${nextStep}. Re-read only the files you need, by line range where possible.`
	);
}

function startCompaction(pi: ExtensionAPI, ctx: ExtensionContext, keep: string, nextStep: string, autoResume: boolean): void {
	compacting = true;
	ctx.compact({
		customInstructions: compactionInstructions(keep, nextStep),
		onComplete: (result) => {
			compacting = false;
			const window = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
			const after = result.estimatedTokensAfter;
			percentAfterLastCompaction = window && after ? (after / window) * 100 : 0;
			ctx.ui.notify(`Compacted: ${fmt(result.tokensBefore)} -> ${after ? fmt(after) : "?"} est. tokens`, "info");
			if (autoResume) {
				autoResumes += 1;
				pi.sendUserMessage(resumeMessage(nextStep), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			}
		},
		onError: (error) => {
			compacting = false;
			ctx.ui.notify(`Self-compaction failed, nothing was resumed: ${error.message}`, "error");
		},
	});
}

export default function contextAwareness(pi: ExtensionAPI): void {
	// Guards are per session; a new or switched session starts clean.
	pi.on("session_start", async () => {
		compacting = false;
		autoResumes = 0;
		percentAfterLastCompaction = null;
	});

	pi.on("context", async (event, ctx) => {
		const note = buildNote(ctx);
		if (!note) return;
		return {
			messages: [
				...event.messages,
				{ role: "custom", customType: "context-awareness", content: note, display: false, timestamp: Date.now() },
			],
		};
	});

	pi.registerTool({
		name: "context_status",
		label: "Context status",
		description:
			"Show how full the context window is: tokens used, window size, percent, and tokens until auto-compaction. Takes no arguments.",
		parameters: Type.Object({}),
		annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return { content: [{ type: "text" as const, text: buildNote(ctx) ?? "Context usage is unavailable." }], details: undefined };
		},
	});

	pi.registerCommand("context-note", {
		description: "Show the context-status note the model receives on its next request",
		handler: async (_args, ctx) => {
			ctx.ui.notify(buildNote(ctx) ?? "Context usage is unavailable.", "info");
		},
	});

	pi.registerTool({
		name: "compact_now",
		label: "Compact now",
		description:
			"Compact the conversation at a clean boundary and then continue automatically. Use only when the current task " +
			"is finished, tests are green, and notes or handoff files are saved, and the context status says it is a good " +
			"time. Never call it in the middle of an edit. Your turn ends right after this call; you are resumed with " +
			"next_step once compaction finishes.",
		parameters: Type.Object({
			keep: Type.String({ description: "What the summary must preserve beyond the defaults (files, decisions, status)." }),
			next_step: Type.String({ description: "The exact next step you will take after compaction." }),
		}),
		annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const usage = ctx.getContextUsage();
			const window = usage?.contextWindow ?? ctx.model?.contextWindow;
			if (usage?.tokens == null || !window) {
				return { content: [{ type: "text" as const, text: "Not compacting: current context usage is unknown." }], details: undefined };
			}
			const allowed = compactAllowedNow(usage.tokens, window);
			if (!allowed.ok) {
				return { content: [{ type: "text" as const, text: `Not compacting: ${allowed.reason} Keep working.` }], details: undefined };
			}
			// Fire-and-forget: compaction needs the agent idle and runs right after this turn ends.
			startCompaction(pi, ctx, params.keep, params.next_step, true);
			return {
				content: [{ type: "text" as const, text: "Compaction queued. Stop here; you will be resumed with your next step." }],
				details: undefined,
				terminate: true,
			};
		},
	});

	pi.registerCommand("compact-now", {
		description: "Compact at this point with the context-awareness instructions (no automatic resume)",
		handler: async (args, ctx) => {
			if (compacting) return ctx.ui.notify("A compaction is already queued or running.", "warning");
			startCompaction(pi, ctx, args || "everything needed to continue the current task", "wait for the user", false);
		},
	});
}
