/**
 * Resolve the workspace root for the server.
 *
 * Hosts may spawn stdio MCP processes with a cwd that is not the repo (e.g.
 * Cursor using $HOME). Prefer an explicit override, then Claude Code's
 * injected project dir, then the process's working directory: never a path
 * baked into this package's install location, which would silently point every
 * un-configured host at wherever the server happens to be installed from.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { debug } from "./log.js";

function realpath(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

function expandUser(p: string): string {
	return p === "~" || p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(1)) : p;
}

/** The statically configured workspace root and where it came from (`explicitEnv`, `CLAUDE_PROJECT_DIR` or `cwd`). */
export function describeWorkspaceRoot(explicitEnv: string): { root: string; source: string } {
	for (const key of [explicitEnv, "CLAUDE_PROJECT_DIR"]) {
		const raw = process.env[key];
		if (raw) {
			return { root: realpath(expandUser(raw)), source: key };
		}
	}
	return { root: realpath(process.cwd()), source: "cwd" };
}

const gitCommonDirCache = new Map<string, string | undefined>();

/** The repository's shared `.git` directory for `p` (identical for a checkout and all its linked worktrees), or undefined outside a git repo. */
function gitCommonDir(p: string): string | undefined {
	if (gitCommonDirCache.has(p)) {
		return gitCommonDirCache.get(p);
	}
	let result: string | undefined;
	try {
		const out = execFileSync("git", ["-C", p, "rev-parse", "--git-common-dir"], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (out) {
			result = realpath(path.isAbsolute(out) ? out : path.join(p, out));
		}
	} catch {
		result = undefined;
	}
	gitCommonDirCache.set(p, result);
	return result;
}

/**
 * True when `a` and `b` are the same directory, or two checkouts/worktrees of
 * one git repository. This is what makes a client-reported root safe to adopt:
 * a session in some unrelated project must never redirect the server.
 */
export function sameRepository(a: string, b: string): boolean {
	if (a === b) {
		return true;
	}
	const commonA = gitCommonDir(a);
	return commonA !== undefined && commonA === gitCommonDir(b);
}

function rootPaths(uris: Iterable<string>): string[] {
	const paths: string[] = [];
	for (const uri of uris) {
		try {
			const parsed = new URL(uri);
			if (parsed.protocol === "file:") {
				paths.push(realpath(fileURLToPath(parsed)));
			}
		} catch {}
	}
	return paths;
}

export interface Selection {
	root: string;
	source: string;
}

/** Asks the connected MCP client for its roots; `undefined` when it has none to offer. */
export type RootsProvider = () => Promise<string[] | undefined>;

/**
 * Decides which directory a navigation server operates on.
 *
 * Hosts start a project's MCP servers once, with the *main* checkout as
 * `CLAUDE_PROJECT_DIR`/cwd, even when the session works in a git worktree, so
 * a fixed root silently answers from the wrong tree. Order of authority:
 *
 * 1. `explicitEnv` set: pinned, never overridden.
 * 2. The client's MCP roots (`roots/list`), first one that is the configured
 *    base or another worktree/checkout of the same git repository.
 * 3. The configured base (`CLAUDE_PROJECT_DIR`, else cwd).
 */
export class WorkspaceSelector {
	readonly base: string;
	readonly baseSource: string;
	readonly pinned: boolean;

	constructor(private readonly explicitEnv: string) {
		({ root: this.base, source: this.baseSource } = describeWorkspaceRoot(explicitEnv));
		this.pinned = Boolean(process.env[explicitEnv]);
	}

	/** One sentence an agent can act on for a `Selection.source` value. */
	explain(source: string): string {
		if (source === "client roots") {
			return `client roots (the MCP client reported this checkout/worktree of the same repository as the configured base ${this.base})`;
		}
		if (source === this.explicitEnv) {
			return `pinned by $${this.explicitEnv}; client roots are ignored`;
		}
		if (source === "CLAUDE_PROJECT_DIR") {
			return "$CLAUDE_PROJECT_DIR (default; the client has not reported another checkout/worktree of this repository)";
		}
		return `server working directory ($${this.explicitEnv} and $CLAUDE_PROJECT_DIR are unset)`;
	}

	async select(rootsProvider: RootsProvider): Promise<Selection> {
		if (this.pinned) {
			return { root: this.base, source: this.baseSource };
		}
		for (const root of await this.clientRoots(rootsProvider)) {
			if (sameRepository(root, this.base)) {
				return { root, source: "client roots" };
			}
		}
		return { root: this.base, source: this.baseSource };
	}

	private async clientRoots(rootsProvider: RootsProvider): Promise<string[]> {
		try {
			return rootPaths((await rootsProvider()) ?? []);
		} catch (error) {
			debug("roots/list failed; keeping the configured workspace", error);
			return [];
		}
	}
}
