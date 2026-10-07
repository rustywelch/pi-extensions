import { execFileSync } from "node:child_process";

const MAX_STATUS_LINES = 20;

function git(cwd, args) {
	try {
		return execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2000,
			maxBuffer: 1024 * 1024,
		}).replace(/\r?\n$/, "");
	} catch {
		return null;
	}
}

/** Capture local workspace identity without changing files or contacting a remote. */
export function captureWorkspaceCheckpoint(cwd) {
	const checkpoint = { cwd };
	const root = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (!root) return checkpoint;

	const rawStatus = git(root, ["status", "--porcelain=v1", "--untracked-files=normal"]) ?? "";
	const status = rawStatus ? rawStatus.split("\n") : [];
	checkpoint.git = {
		root,
		branch: git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || "(detached)",
		head: git(root, ["rev-parse", "HEAD"]) || "unknown",
		upstream: git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
		upstreamHead: git(root, ["rev-parse", "@{upstream}"]),
		status: status.slice(0, MAX_STATUS_LINES),
		statusTotal: status.length,
	};
	return checkpoint;
}

export function formatWorkspaceCheckpoint(checkpoint) {
	if (!checkpoint.git) return `cwd ${checkpoint.cwd}; not a Git worktree`;
	const g = checkpoint.git;
	const tracking = g.upstream
		? `; tracking ${g.upstream} at ${g.upstreamHead || "unknown"}`
		: "; no upstream configured";
	const worktree = g.statusTotal === 0
		? "; worktree clean"
		: `; worktree had ${g.statusTotal} change(s): ${g.status.join(" | ")}` +
			(g.statusTotal > g.status.length ? " | …" : "");
	return `cwd ${checkpoint.cwd}; repo ${g.root}; branch ${g.branch}; HEAD ${g.head}${tracking}${worktree}`;
}

/** Text deliberately says the snapshot is stale: the resumed model must verify live state. */
export function resumeVerification(checkpoint) {
	return [
		"Before editing or making external changes, independently verify current state; do not treat the compaction summary as proof.",
		"Re-check cwd, Git branch, HEAD, worktree status, and upstream/remote head (refresh the remote when appropriate).",
		"Re-query any task-critical external permissions, CI, deployment, API, or service state because it may have changed during compaction.",
		`Historical checkpoint captured before compaction: ${formatWorkspaceCheckpoint(checkpoint)}.`,
	].join(" ");
}
