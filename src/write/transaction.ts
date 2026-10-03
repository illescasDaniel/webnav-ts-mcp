/**
 * Writing plans to disk safely: path rules, atomic application with rollback,
 * remembered previews, and undo.
 *
 * - `WriteGuard` decides which files a write tool may touch.
 * - `PlanStore` holds previews until `apply_edit` writes them.
 * - `EditJournal` applies a plan (each file replaced atomically; a failure
 *   part-way restores what was already written) and can revert it as long as
 *   none of its files changed afterwards.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ToolInputError } from "../shared/errors.js";
import { EXCLUDED_DIR_NAMES } from "../shared/exclude.js";
import { canonicalPath, relativeWithin, removeEmptyDirChain, resolveReal } from "../shared/paths.js";
import { type EditPlan, encodeSource, type FileChange, relativeName } from "./edits.js";

export const READ_ONLY_ENV = "WEBNAV_MCP_READ_ONLY";
export const WRITABLE_SUFFIXES: ReadonlySet<string> = new Set([
	".js",
	".mjs",
	".cjs",
	".jsx",
	".ts",
	".mts",
	".cts",
	".tsx",
	".html",
	".css",
]);
/** Edits touching more files than this need `allow_large=true`. */
export const LARGE_EDIT_FILES = 40;
const MAX_PENDING_PREVIEWS = 25;

export function readOnlyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
	return ["1", "true", "yes"].includes((env[READ_ONLY_ENV] ?? "").trim().toLowerCase());
}

export interface WriteGuardOptions {
	root: string;
	allowedSuffixes?: ReadonlySet<string>;
	readOnly?: boolean;
	/** Paths that must not be written even though they are inside the workspace (generated output). */
	isForbidden?: (resolved: string) => string | undefined;
}

export class WriteGuard {
	readonly root: string;
	readOnly: boolean;
	private readonly suffixes: ReadonlySet<string>;
	private readonly isForbidden: ((resolved: string) => string | undefined) | undefined;

	constructor(options: WriteGuardOptions) {
		this.root = resolveReal(options.root);
		this.readOnly = options.readOnly ?? false;
		this.suffixes = options.allowedSuffixes ?? WRITABLE_SUFFIXES;
		this.isForbidden = options.isForbidden;
	}

	/** Throws a `ToolInputError` naming the rule when `filePath` may not be written (previews included). */
	checkPath(filePath: string, options: { anySuffix?: boolean } = {}): void {
		const abs = path.resolve(filePath);
		const shown = relativeName(abs, this.root);
		try {
			if (fs.lstatSync(abs).isSymbolicLink()) {
				throw new ToolInputError(`${shown} is a symbolic link; write tools do not follow symlinks.`);
			}
		} catch (error) {
			if (error instanceof ToolInputError) {
				throw error;
			}
		}
		const resolved = canonicalPath(filePath);
		const rel = relativeWithin(resolved, this.root);
		if (rel === undefined || rel === "") {
			throw new ToolInputError(
				`${shown} is outside the workspace ${this.root}; write tools only touch files inside it.`,
			);
		}
		if (!options.anySuffix && !this.suffixes.has(path.extname(resolved).toLowerCase())) {
			throw new ToolInputError(
				`${shown}: write tools only edit ${[...this.suffixes].sort().join("/")} files, not '${path.extname(resolved) || "(no extension)"}'.`,
			);
		}
		const excluded = rel.split(path.sep).find((part) => EXCLUDED_DIR_NAMES.has(part));
		if (excluded !== undefined) {
			throw new ToolInputError(`${shown} is inside '${excluded}/', which write tools never touch.`);
		}
		const reason = this.isForbidden?.(resolved);
		if (reason !== undefined) {
			throw new ToolInputError(`${shown} ${reason}`);
		}
	}

	checkWritable(): void {
		if (this.readOnly) {
			throw new ToolInputError(`writes are disabled (${READ_ONLY_ENV} is set); previews still work.`);
		}
	}
}

export class PlanStore {
	private plans = new Map<string, EditPlan>();

	add(plan: EditPlan): string {
		const id = `p-${crypto.randomBytes(3).toString("hex")}`;
		this.plans.set(id, plan);
		while (this.plans.size > MAX_PENDING_PREVIEWS) {
			const oldest = this.plans.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.plans.delete(oldest);
		}
		return id;
	}

	get(id: string): EditPlan {
		const plan = this.plans.get(id);
		if (plan === undefined) {
			throw new ToolInputError(
				`No pending preview with id ${JSON.stringify(id)} (previews are forgotten when the workspace changes or after ${MAX_PENDING_PREVIEWS} newer ones).`,
			);
		}
		return plan;
	}

	discard(id: string): void {
		this.plans.delete(id);
	}
}

interface Snapshot {
	path: string;
	/** Bytes on disk before (undefined: absent). */
	before: Buffer | undefined;
	/** Bytes the plan wrote (undefined: removed). */
	after: Buffer | undefined;
	mode: number | undefined;
}

export interface JournalEntry {
	id: string;
	plan: EditPlan;
	snapshots: Snapshot[];
	createdDirs: { leaf: string; top: string }[];
}

function readBytes(p: string): Buffer | undefined {
	try {
		return fs.readFileSync(p);
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
			return undefined;
		}
		throw error;
	}
}

const sameBytes = (a: Buffer | undefined, b: Buffer | undefined): boolean =>
	a === undefined || b === undefined ? a === b : a.equals(b);

function writeAtomic(
	p: string,
	bytes: Buffer,
	mode: number | undefined,
	createdDirs: { leaf: string; top: string }[],
): void {
	const top = fs.mkdirSync(path.dirname(p), { recursive: true });
	if (top !== undefined) {
		createdDirs.push({ leaf: path.dirname(p), top });
	}
	const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
	try {
		fs.writeFileSync(tmp, bytes, mode === undefined ? undefined : { mode });
		fs.renameSync(tmp, p);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
}

function removeEmptyDirs(dirs: { leaf: string; top: string }[]): void {
	for (const { leaf, top } of dirs) {
		removeEmptyDirChain(leaf, top);
	}
}

export class EditJournal {
	private entries: JournalEntry[] = [];

	constructor(public guard: WriteGuard) {}

	/** Per-file expected state before the plan runs, as the plan saw it. */
	private expectedBefore(change: FileChange): Buffer | undefined {
		if (change.kind === "rename") {
			return change.oldText === undefined ? undefined : encodeSource(change.oldText, change.oldBom);
		}
		return change.oldText === undefined ? undefined : encodeSource(change.oldText, change.oldBom);
	}

	apply(plan: EditPlan, options: { allowLarge?: boolean } = {}): JournalEntry {
		this.guard.checkWritable();
		const files = new Set(plan.changes.flatMap((c) => [c.path, ...(c.renamedFrom ? [c.renamedFrom] : [])]));
		if (files.size > LARGE_EDIT_FILES && !options.allowLarge) {
			throw new ToolInputError(
				`this edit touches ${files.size} files (more than ${LARGE_EDIT_FILES}); pass allow_large=true to write it.`,
			);
		}
		const snapshots: Snapshot[] = [];
		// Verify first, so a stale plan writes nothing at all.
		for (const change of plan.changes) {
			this.guard.checkPath(change.path, { anySuffix: change.kind === "rename" });
			const source = change.renamedFrom ?? change.path;
			const current = readBytes(source);
			const expected = this.expectedBefore(change);
			const name = relativeName(source, this.guard.root);
			if (change.kind === "create") {
				if (current !== undefined) {
					throw new ToolInputError(
						`${name} was created since the preview; nothing was written. Preview the edit again.`,
					);
				}
			} else if (change.kind === "rename") {
				if (current === undefined) {
					throw new ToolInputError(`${name} no longer exists; nothing was written. Preview the move again.`);
				}
				if (expected !== undefined && !sameBytes(current, expected)) {
					throw new ToolInputError(`${name} changed since the preview; nothing was written. Preview the edit again.`);
				}
				if (readBytes(change.path) !== undefined) {
					throw new ToolInputError(
						`${relativeName(change.path, this.guard.root)} already exists; nothing was written.`,
					);
				}
			} else if (!sameBytes(current, expected)) {
				throw new ToolInputError(`${name} changed since the preview; nothing was written. Preview the edit again.`);
			}
		}
		const createdDirs: { leaf: string; top: string }[] = [];
		const done: (() => void)[] = [];
		try {
			for (const change of plan.changes) {
				if (change.kind === "rename") {
					const from = change.renamedFrom as string;
					const original = readBytes(from) as Buffer;
					const mode = fs.statSync(from).mode;
					const bytes = change.newText === undefined ? original : encodeSource(change.newText, change.newBom);
					writeAtomic(change.path, bytes, mode, createdDirs);
					done.push(() => fs.rmSync(change.path, { force: true }));
					fs.rmSync(from);
					done.push(() => writeAtomic(from, original, mode, []));
					snapshots.push({ path: from, before: original, after: undefined, mode });
					snapshots.push({ path: change.path, before: undefined, after: bytes, mode });
				} else if (change.kind === "delete") {
					const original = readBytes(change.path) as Buffer;
					const mode = fs.statSync(change.path).mode;
					fs.rmSync(change.path);
					done.push(() => writeAtomic(change.path, original, mode, []));
					snapshots.push({ path: change.path, before: original, after: undefined, mode });
				} else {
					const original = readBytes(change.path);
					const mode = original === undefined ? undefined : fs.statSync(change.path).mode;
					const bytes = encodeSource(change.newText ?? "", change.newBom);
					writeAtomic(change.path, bytes, mode, createdDirs);
					done.push(() =>
						original === undefined
							? fs.rmSync(change.path, { force: true })
							: writeAtomic(change.path, original, mode, []),
					);
					snapshots.push({ path: change.path, before: original, after: bytes, mode });
				}
			}
		} catch (error) {
			for (const undo of done.reverse()) {
				try {
					undo();
				} catch {}
			}
			removeEmptyDirs(createdDirs);
			throw error;
		}
		const entry: JournalEntry = { id: `e-${crypto.randomBytes(3).toString("hex")}`, plan, snapshots, createdDirs };
		this.entries.push(entry);
		return entry;
	}

	/** Revert the applied edit `id` (the latest by default) unless one of its files changed since. */
	undo(id?: string): JournalEntry {
		this.guard.checkWritable();
		const entry = id === undefined ? this.entries[this.entries.length - 1] : this.entries.find((e) => e.id === id);
		if (entry === undefined) {
			throw new ToolInputError(
				id === undefined
					? "There is no applied edit to undo."
					: `No applied edit with id ${JSON.stringify(id)} (undo works within the session that made it).`,
			);
		}
		for (const snap of entry.snapshots) {
			if (!sameBytes(readBytes(snap.path), snap.after)) {
				throw new ToolInputError(
					`${relativeName(snap.path, this.guard.root)} changed after the edit; undoing would overwrite that work, so nothing was reverted.`,
				);
			}
		}
		for (const snap of [...entry.snapshots].reverse()) {
			if (snap.before === undefined) {
				fs.rmSync(snap.path, { force: true });
			} else {
				writeAtomic(snap.path, snap.before, snap.mode, []);
			}
		}
		removeEmptyDirs(entry.createdDirs);
		this.entries = this.entries.filter((e) => e !== entry);
		return entry;
	}
}
