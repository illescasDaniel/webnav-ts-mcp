/** Pieces every write tool needs: the host interface, path arguments, and the shared parameter rules. */

import path from "node:path";
import { ToolInputError } from "../shared/errors.js";
import type { LspClient } from "../shared/lspClient.js";
import { canonicalPath } from "../shared/paths.js";
import type { WriteHost } from "./finish.js";

export interface WebRootInfo {
	name: string;
	/** Absolute directory. */
	root: string;
}

export interface ToolHost extends WriteHost {
	/** The TypeScript language server (started on first use). */
	scriptClient(): Promise<LspClient>;
	/** The configured index roots (`WEBNAV_MCP_ROOTS`; the whole workspace by default). */
	webRoots(): WebRootInfo[];
}

/** Common to every tool that can write. */
export interface WriteArgs {
	apply?: boolean | undefined;
	maxNewErrors?: number | null | undefined;
}

/** `max_new_errors` as the tools take it: omitted means 0, `null` means no limit. */
export function newErrorLimit(value: number | null | undefined): number | undefined {
	if (value === null) {
		return undefined;
	}
	return value ?? 0;
}

/** Absolute, symlink-normalised path for a workspace-relative or absolute argument. */
export function resolveArgPath(host: WriteHost, filePath: string): string {
	return canonicalPath(path.isAbsolute(filePath) ? filePath : path.join(host.workspaceRoot, filePath));
}

export function requireText(value: string | undefined, what: string): string {
	if (value === undefined || value === "") {
		throw new ToolInputError(`${what} is required.`);
	}
	return value;
}

/** A parameter an action ignores is a mistake to report, not to swallow. */
export function rejectUnused(action: string, unused: Record<string, unknown>): void {
	const extra = Object.entries(unused)
		.filter(([, value]) => value !== undefined && value !== false)
		.map(([key]) => `\`${key}\``);
	if (extra.length > 0) {
		throw new ToolInputError(`${extra.join(", ")} do not apply to ${action}.`);
	}
}
