export interface GitCheckpoint {
	root: string;
	branch: string;
	head: string;
	upstream: string | null;
	upstreamHead: string | null;
	status: string[];
	statusTotal: number;
}

export interface WorkspaceCheckpoint {
	cwd: string;
	git?: GitCheckpoint;
}

export function captureWorkspaceCheckpoint(cwd: string): WorkspaceCheckpoint;
export function formatWorkspaceCheckpoint(checkpoint: WorkspaceCheckpoint): string;
export function resumeVerification(checkpoint: WorkspaceCheckpoint): string;
