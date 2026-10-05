/**
 * Search extension - structured code search for Pi.
 *
 * Pi ships with read/bash/edit/write only, so every search otherwise costs a
 * shell round-trip. This registers one `search` tool with two modes:
 *   content -> grep for a pattern inside files
 *   files   -> list files matching a name glob
 *
 * Prefers ripgrep when it is on PATH and degrades to grep/find otherwise, so
 * the same extension works on machines without rg installed.
 */

import { execFile } from "node:child_process";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_CHARS = 20000;

const SearchParams = Type.Object({
	pattern: Type.String({
		description: "Content mode: a regular expression. Files mode: a filename glob such as *.ts",
	}),
	mode: Type.Optional(
		Type.String({ description: "'content' (default) searches inside files, 'files' matches filenames" }),
	),
	path: Type.Optional(Type.String({ description: "Directory to search. Defaults to the working directory" })),
	glob: Type.Optional(Type.String({ description: "Content mode only: restrict to files matching this glob" })),
	caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive match. Defaults to false" })),
	maxResults: Type.Optional(Type.Number({ description: "Maximum lines returned. Defaults to 200" })),
});

function run(cmd: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { cwd, signal, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
			// grep and rg exit 1 for "no matches", which is not an error here.
			const code = (err as NodeJS.ErrnoException & { code?: number })?.code;
			if (err && code !== 1) {
				reject(new Error(stderr?.trim() || (err as Error).message));
				return;
			}
			resolve(stdout);
		});
	});
}

async function hasRipgrep(cwd: string): Promise<boolean> {
	try {
		await run("rg", ["--version"], cwd);
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "search",
		label: "Search",
		description:
			"Search the codebase. mode='content' greps file contents for a regex; mode='files' lists files whose names match a glob. Returns file:line:text lines. Use this instead of shelling out to grep or find.",
		parameters: SearchParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = params.path || ctx.cwd || process.cwd();
			const mode = params.mode === "files" ? "files" : "content";
			const limit = params.maxResults ?? 200;
			const rg = await hasRipgrep(cwd);

			let out = "";
			let tool = "";

			if (mode === "files") {
				if (rg) {
					tool = "rg --files";
					out = await run("rg", ["--files", "--glob", params.pattern], cwd, signal);
				} else {
					tool = "find";
					out = await run("find", [".", "-type", "f", "-name", params.pattern], cwd, signal);
				}
			} else {
				if (rg) {
					tool = "rg";
					const args = ["--line-number", "--no-heading", "--color", "never"];
					if (!params.caseSensitive) args.push("--ignore-case");
					if (params.glob) args.push("--glob", params.glob);
					args.push("--", params.pattern, ".");
					out = await run("rg", args, cwd, signal);
				} else {
					tool = "grep";
					const args = ["-rn"];
					if (!params.caseSensitive) args.push("-i");
					if (params.glob) args.push(`--include=${params.glob}`);
					args.push("-e", params.pattern, ".");
					out = await run("grep", args, cwd, signal);
				}
			}

			const all = out.split("\n").filter((l) => l.length > 0);
			const total = all.length;
			let lines = all.slice(0, limit);
			let text = lines.join("\n");
			let truncated = total > limit;

			if (text.length > MAX_CHARS) {
				text = text.slice(0, MAX_CHARS);
				truncated = true;
			}

			if (total === 0) {
				text = `No matches for ${JSON.stringify(params.pattern)} in ${cwd}`;
			} else if (truncated) {
				text += `\n\n[truncated: showing ${lines.length} of ${total} matches. Narrow the pattern, set glob, or raise maxResults.]`;
			}

			return {
				content: [{ type: "text", text }],
				details: { mode, tool, cwd, pattern: params.pattern, total, returned: lines.length, truncated },
			};
		},
	});
}
