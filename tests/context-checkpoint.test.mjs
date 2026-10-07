import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	captureWorkspaceCheckpoint,
	formatWorkspaceCheckpoint,
	resumeVerification,
} from "../lib/context-checkpoint.mjs";

function run(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repo() {
	const dir = mkdtempSync(join(tmpdir(), "pi-context-checkpoint-"));
	run(dir, "init", "-b", "main");
	run(dir, "config", "user.email", "test@example.com");
	run(dir, "config", "user.name", "Test");
	writeFileSync(join(dir, "tracked.txt"), "one\n");
	run(dir, "add", "tracked.txt");
	run(dir, "commit", "-m", "initial");
	return dir;
}

test("captures a clean Git workspace without contacting a remote", () => {
	const dir = repo();
	const checkpoint = captureWorkspaceCheckpoint(dir);
	assert.equal(checkpoint.git.branch, "main");
	assert.equal(checkpoint.git.head, run(dir, "rev-parse", "HEAD"));
	assert.equal(checkpoint.git.statusTotal, 0);
	assert.equal(checkpoint.git.upstream, null);
	assert.match(formatWorkspaceCheckpoint(checkpoint), /worktree clean/);
});

test("captures the configured upstream name and locally observed commit", () => {
	const dir = repo();
	const bare = mkdtempSync(join(tmpdir(), "pi-context-remote-"));
	run(bare, "init", "--bare", "--initial-branch=main");
	run(dir, "remote", "add", "origin", bare);
	run(dir, "push", "--set-upstream", "origin", "main");
	const checkpoint = captureWorkspaceCheckpoint(dir);
	assert.equal(checkpoint.git.upstream, "origin/main");
	assert.equal(checkpoint.git.upstreamHead, checkpoint.git.head);
});

test("records dirty paths so compaction cannot erase ownership context", () => {
	const dir = repo();
	writeFileSync(join(dir, "tracked.txt"), "changed\n");
	writeFileSync(join(dir, "untracked.txt"), "new\n");
	const checkpoint = captureWorkspaceCheckpoint(dir);
	assert.equal(checkpoint.git.statusTotal, 2);
	assert.deepEqual(checkpoint.git.status, [" M tracked.txt", "?? untracked.txt"]);
});

test("non-Git directories degrade safely", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-context-no-git-"));
	const checkpoint = captureWorkspaceCheckpoint(dir);
	assert.equal(checkpoint.git, undefined);
	assert.match(formatWorkspaceCheckpoint(checkpoint), /not a Git worktree/);
});

test("resume guidance treats the checkpoint as historical and requires live verification", () => {
	const message = resumeVerification(captureWorkspaceCheckpoint(repo()));
	assert.match(message, /independently verify current state/);
	assert.match(message, /branch, HEAD, worktree status, and upstream\/remote head/);
	assert.match(message, /external permissions, CI, deployment, API, or service state/);
	assert.match(message, /Historical checkpoint captured before compaction/);
});
