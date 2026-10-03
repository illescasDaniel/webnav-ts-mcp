/** `verify_changes`: which diagnostics did the working tree gain or lose since a git revision. */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { ToolInputError } from "../shared/errors.js";
import { EXCLUDED_DIR_NAMES } from "../shared/exclude.js";
import { canonicalPath } from "../shared/paths.js";
import type { ToolHost } from "./common.js";
import { formatDelta } from "./diagnosticsDelta.js";
import { relativeName } from "./edits.js";
import { compareStates, type Side } from "./simulate.js";
import { WRITABLE_SUFFIXES } from "./transaction.js";

function git(cwd: string, args: string[], encoding: "utf8" | "buffer" = "utf8"): string {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: encoding === "utf8" ? "utf8" : "buffer",
			timeout: 30_000,
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		}).toString();
	} catch (error) {
		const stderr = String((error as { stderr?: Buffer | string }).stderr ?? "").trim();
		throw new ToolInputError(`git ${args.slice(0, 2).join(" ")} failed: ${stderr || (error as Error).message}`);
	}
}

/** The committed text of `rel` (relative to the repository top) at `since`, or undefined when it did not exist or is not text. */
function gitShow(cwd: string, since: string, rel: string): string | undefined {
	try {
		const bytes = execFileSync("git", ["-C", cwd, "show", `${since}:${rel}`], {
			timeout: 30_000,
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

const isWeb = (file: string): boolean => WRITABLE_SUFFIXES.has(path.extname(file).toLowerCase());
const inExcludedDir = (rel: string): boolean => rel.split("/").some((part) => EXCLUDED_DIR_NAMES.has(part));

export async function verifyChanges(host: ToolHost, since = "HEAD", includeDependents = true): Promise<string> {
	if (since.startsWith("-")) {
		throw new ToolInputError(`invalid revision ${JSON.stringify(since)}`);
	}
	const root = host.workspaceRoot;
	const top = canonicalPath(git(root, ["rev-parse", "--show-toplevel"]).trim());
	const status = git(root, ["diff", "--name-status", "-z", "--no-renames", since, "--", "."]).split("\0");
	const before: Side = new Map();
	const after: Side = new Map();
	const edited: string[] = [];
	const gone: string[] = [];
	for (let i = 0; i + 1 < status.length; i += 2) {
		const code = status[i] as string;
		const rel = status[i + 1] as string;
		const file = canonicalPath(path.join(top, rel));
		if (!isWeb(file) || inExcludedDir(rel)) {
			continue;
		}
		if (code.startsWith("A")) {
			before.set(file, { overlay: "", skip: true });
			edited.push(file);
		} else if (code.startsWith("D")) {
			const old = gitShow(root, since, rel);
			if (old !== undefined) {
				before.set(file, { overlay: old });
				after.set(file, { overlay: "", skip: true });
				edited.push(file);
				gone.push(file);
			}
		} else {
			const old = gitShow(root, since, rel);
			if (old !== undefined) {
				before.set(file, { overlay: old });
			}
			edited.push(file);
		}
	}
	for (const rel of git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]).split("\0")) {
		if (rel === "") {
			continue;
		}
		const file = canonicalPath(path.join(root, rel));
		if (isWeb(file) && !inExcludedDir(rel)) {
			before.set(file, { overlay: "", skip: true });
			edited.push(file);
		}
	}
	if (edited.length === 0) {
		return `No JS/TS/HTML/CSS files differ from ${since}.`;
	}
	const delta = await compareStates(host, { edited, gone, before, after, includeDependents });
	const names =
		edited
			.slice(0, 8)
			.map((f) => relativeName(f, root))
			.join(", ") + (edited.length > 8 ? ` (+${edited.length - 8} more)` : "");
	return `Changed since ${since}: ${names}\n\n${formatDelta(delta)}`;
}
