/**
 * Text edits and edit plans: the data every write tool produces before anything touches the disk.
 *
 * A plan is a list of whole-file changes (old and new text) plus the notes the
 * tool wants the agent to read. Edits arrive as LSP ranges or plain
 * replacements; both end up as offset-based `TextEdit`s applied to one file's
 * text. Text keeps its own line endings and a leading BOM is carried
 * separately, so a rewrite never changes bytes it didn't mean to.
 */

import fs from "node:fs";
import path from "node:path";
import { ToolInputError } from "../shared/errors.js";
import { uriToPath } from "../shared/format.js";
import type { LspTextEdit, LspWorkspaceEdit } from "../shared/lspTypes.js";
import { canonicalPath } from "../shared/paths.js";
import { readTextStrict } from "../shared/text.js";

const BOM = "﻿";

export interface SourceFile {
	/** Text without a leading BOM. */
	text: string;
	bom: boolean;
}

export function readSource(filePath: string): SourceFile {
	const raw = readTextStrict(filePath);
	return raw.startsWith(BOM) ? { text: raw.slice(1), bom: true } : { text: raw, bom: false };
}

export const encodeSource = (text: string, bom: boolean): Buffer => Buffer.from(bom ? BOM + text : text, "utf8");

/** The dominant line ending of `text` (`\n` when it has none). */
export function detectEol(text: string): "\n" | "\r\n" {
	const crlf = (text.match(/\r\n/g) ?? []).length;
	const lf = (text.match(/\n/g) ?? []).length - crlf;
	return crlf > lf ? "\r\n" : "\n";
}

/** Offsets at which each line starts (LSP line terminators: `\r\n`, `\r`, `\n`). */
export function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		if (ch === 13 && text.charCodeAt(i + 1) === 10) {
			i++;
			starts.push(i + 1);
		} else if (ch === 13 || ch === 10) {
			starts.push(i + 1);
		}
	}
	return starts;
}

/** 0-based LSP line/character (UTF-16) to a string offset; a character past the line's end clamps to it. */
export function positionToOffset(text: string, line: number, character: number, starts = lineStarts(text)): number {
	if (line >= starts.length) {
		return text.length;
	}
	const start = starts[line] as number;
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 10 && text.charCodeAt(end) !== 13) {
		end++;
	}
	return Math.min(start + character, end);
}

export function offsetToPosition(
	text: string,
	offset: number,
	starts = lineStarts(text),
): { line: number; character: number } {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((starts[mid] as number) <= offset) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return { line: lo, character: offset - (starts[lo] as number) };
}

export interface TextEdit {
	start: number;
	end: number;
	newText: string;
}

/** Apply non-overlapping edits (identical duplicates are collapsed); overlapping ones are a bug in the caller's plan. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
	const unique = [...new Map(edits.map((e) => [`${e.start}:${e.end}:${e.newText}`, e])).values()];
	unique.sort((a, b) => a.start - b.start || a.end - b.end);
	let out = "";
	let cursor = 0;
	for (const edit of unique) {
		if (edit.start < cursor) {
			throw new ToolInputError(
				`two edits overlap at offset ${edit.start}; the edit plan is inconsistent, nothing was changed.`,
			);
		}
		out += text.slice(cursor, edit.start) + edit.newText;
		cursor = edit.end;
	}
	return out + text.slice(cursor);
}

export function lspEditsToTextEdits(text: string, edits: readonly LspTextEdit[]): TextEdit[] {
	const starts = lineStarts(text);
	return edits.map((e) => ({
		start: positionToOffset(text, e.range.start.line, e.range.start.character, starts),
		end: positionToOffset(text, e.range.end.line, e.range.end.character, starts),
		newText: e.newText,
	}));
}

export type ChangeKind = "modify" | "create" | "delete" | "rename";

/** One file's change. For `rename`, `path` is the destination and `renamedFrom` the source. */
export interface FileChange {
	path: string;
	kind: ChangeKind;
	/** Text before (undefined: the file doesn't exist, or a rename of a file that isn't text). */
	oldText: string | undefined;
	/** Text after (undefined: deleted, or a rename that leaves the content alone). */
	newText: string | undefined;
	oldBom: boolean;
	newBom: boolean;
	renamedFrom?: string | undefined;
}

export function modifyChange(filePath: string, oldText: string, newText: string, bom = false): FileChange {
	return { path: filePath, kind: "modify", oldText, newText, oldBom: bom, newBom: bom };
}

export function createChange(filePath: string, newText: string): FileChange {
	return { path: filePath, kind: "create", oldText: undefined, newText, oldBom: false, newBom: false };
}

export function deleteChange(filePath: string, oldText: string, bom = false): FileChange {
	return { path: filePath, kind: "delete", oldText, newText: undefined, oldBom: bom, newBom: false };
}

export const relativeName = (filePath: string, root: string): string => {
	const rel = path.relative(root, filePath);
	return (rel.startsWith("..") || path.isAbsolute(rel) ? filePath : rel).split(path.sep).join("/");
};

function lineCount(text: string): number {
	return text === "" ? 0 : lineStarts(text).length - (/(\r\n|\r|\n)$/.test(text) ? 1 : 0);
}

type DiffOp = { op: " " | "-" | "+"; text: string };

/** Line diff by trimming the common head/tail and running an LCS over the middle (capped). */
function diffLines(a: string[], b: string[]): DiffOp[] {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) {
		head++;
	}
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
		tail++;
	}
	const midA = a.slice(head, a.length - tail);
	const midB = b.slice(head, b.length - tail);
	const ops: DiffOp[] = a.slice(0, head).map((text) => ({ op: " ", text }));
	if (midA.length * midB.length > 4_000_000) {
		ops.push(...midA.map((text): DiffOp => ({ op: "-", text })), ...midB.map((text): DiffOp => ({ op: "+", text })));
	} else {
		const n = midA.length;
		const m = midB.length;
		const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				(table[i] as Uint32Array)[j] =
					midA[i] === midB[j]
						? ((table[i + 1] as Uint32Array)[j + 1] as number) + 1
						: Math.max((table[i + 1] as Uint32Array)[j] as number, (table[i] as Uint32Array)[j + 1] as number);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (midA[i] === midB[j]) {
				ops.push({ op: " ", text: midA[i] as string });
				i++;
				j++;
			} else if (((table[i + 1] as Uint32Array)[j] as number) >= ((table[i] as Uint32Array)[j + 1] as number)) {
				ops.push({ op: "-", text: midA[i++] as string });
			} else {
				ops.push({ op: "+", text: midB[j++] as string });
			}
		}
		while (i < n) {
			ops.push({ op: "-", text: midA[i++] as string });
		}
		while (j < m) {
			ops.push({ op: "+", text: midB[j++] as string });
		}
	}
	ops.push(...a.slice(a.length - tail).map((text): DiffOp => ({ op: " ", text })));
	return ops;
}

const splitForDiff = (text: string | undefined): string[] =>
	text ? text.split(/\r\n|\r|\n/).slice(0, text.endsWith("\n") ? -1 : undefined) : [];

/** Unified-style diff of one change with `context` lines around each hunk. */
function diffOne(change: FileChange, root: string, context = 2): string {
	const name =
		change.kind === "rename"
			? `${relativeName(change.renamedFrom ?? "", root)} -> ${relativeName(change.path, root)}`
			: relativeName(change.path, root);
	if (change.newText === undefined && change.kind !== "delete") {
		return `--- ${name}\n(moved without content changes)`;
	}
	const ops = diffLines(splitForDiff(change.oldText), splitForDiff(change.newText));
	const keep = new Set<number>();
	ops.forEach((op, i) => {
		if (op.op !== " ") {
			for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) {
				keep.add(k);
			}
		}
	});
	const out = [`--- ${name}`];
	let oldLine = 1;
	let newLine = 1;
	let inHunk = false;
	ops.forEach((op, i) => {
		if (keep.has(i)) {
			if (!inHunk) {
				out.push(`@@ -${oldLine} +${newLine} @@`);
				inHunk = true;
			}
			out.push(`${op.op}${op.text}`);
		} else {
			inHunk = false;
		}
		if (op.op !== "+") {
			oldLine++;
		}
		if (op.op !== "-") {
			newLine++;
		}
	});
	return out.join("\n");
}

function changedLineCounts(change: FileChange): { added: number; removed: number } {
	if (change.kind === "delete") {
		return { added: 0, removed: lineCount(change.oldText ?? "") };
	}
	if (change.kind === "create") {
		return { added: lineCount(change.newText ?? ""), removed: 0 };
	}
	if (change.newText === undefined) {
		return { added: 0, removed: 0 };
	}
	const ops = diffLines(splitForDiff(change.oldText), splitForDiff(change.newText));
	return { added: ops.filter((o) => o.op === "+").length, removed: ops.filter((o) => o.op === "-").length };
}

export class EditPlan {
	constructor(
		readonly description: string,
		readonly changes: FileChange[],
		readonly notes: string[] = [],
	) {}

	get isEmpty(): boolean {
		return this.changes.every((c) => c.kind === "modify" && c.oldText === c.newText && c.oldBom === c.newBom);
	}

	/** One line per file: `M src/a.ts (+3 -1)`. */
	summary(root: string): string {
		return this.changes
			.map((change) => {
				const { added, removed } = changedLineCounts(change);
				const stats = ` (+${added} -${removed})`;
				switch (change.kind) {
					case "create":
						return `  A ${relativeName(change.path, root)}${stats}`;
					case "delete":
						return `  D ${relativeName(change.path, root)}${stats}`;
					case "rename":
						return `  R ${relativeName(change.renamedFrom ?? "", root)} -> ${relativeName(change.path, root)}${stats}`;
					default:
						return `  M ${relativeName(change.path, root)}${stats}`;
				}
			})
			.join("\n");
	}

	/** The diff of every change, cut at `maxLines` with a note on what was left out. */
	diff(root: string, maxLines = 150): string {
		const lines = this.changes.flatMap((change) => diffOne(change, root).split("\n"));
		if (lines.length <= maxLines) {
			return lines.join("\n");
		}
		return `${lines.slice(0, maxLines).join("\n")}\n... ${lines.length - maxLines} more diff line(s) not shown`;
	}
}

/**
 * Per-file edits (offset-based, against each file's current text) to a plan.
 * `texts` supplies the text a file had when the edits were computed.
 */
export function planFromEdits(
	description: string,
	edits: ReadonlyMap<string, readonly TextEdit[]>,
	notes: string[] = [],
): EditPlan {
	const changes: FileChange[] = [];
	for (const [file, fileEdits] of edits) {
		const { text, bom } = readSource(file);
		const newText = applyEdits(text, fileEdits);
		if (newText !== text) {
			changes.push(modifyChange(file, text, newText, bom));
		}
	}
	return new EditPlan(description, changes, notes);
}

/** The text edits a `WorkspaceEdit` makes, per canonical file path; file operations are returned separately. */
export function parseWorkspaceEdit(edit: LspWorkspaceEdit): {
	edits: Map<string, TextEdit[]>;
	renames: { oldPath: string; newPath: string }[];
	other: string[];
} {
	const edits = new Map<string, TextEdit[]>();
	const renames: { oldPath: string; newPath: string }[] = [];
	const other: string[] = [];
	const add = (uri: string, lsp: readonly LspTextEdit[]): void => {
		const file = canonicalPath(uriToPath(uri));
		let text: string;
		try {
			text = readSource(file).text;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				other.push(`edit for ${file}, which does not exist`);
				return;
			}
			throw error;
		}
		const bucket = edits.get(file) ?? [];
		bucket.push(...lspEditsToTextEdits(text, lsp));
		edits.set(file, bucket);
	};
	for (const [uri, list] of Object.entries(edit.changes ?? {})) {
		add(uri, list);
	}
	for (const change of edit.documentChanges ?? []) {
		if ("textDocument" in change) {
			add(change.textDocument.uri, change.edits);
		} else if (change.kind === "rename") {
			renames.push({
				oldPath: canonicalPath(uriToPath(change.oldUri)),
				newPath: canonicalPath(uriToPath(change.newUri)),
			});
		} else {
			other.push(`${change.kind} ${uriToPath(change.uri)}`);
		}
	}
	return { edits, renames, other };
}

export const fileExists = (p: string): boolean => {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
};

/**
 * `before` + `after` where a block of lines was cut out between them, without leaving a stray blank line:
 * two blank lines meeting become one, and no blank line is left at the top of a file, right after an
 * opening brace or right before a closing one.
 */
export function joinAfterRemoval(before: string, after: string): string {
	const blankAtEnd = /(?:^|\n|\r)[ \t]*(?:\r\n|\r|\n)$/.test(before);
	const blankAtStart = /^[ \t]*(?:\r\n|\r|\n)/.exec(after);
	const opensBlock = /[{([][ \t]*(?:\r\n|\r|\n)$/.test(before);
	if (blankAtStart && (before === "" || blankAtEnd || opensBlock)) {
		return before + after.slice(blankAtStart[0].length);
	}
	const closesBlock = /^[ \t]*[})\]]/.test(after);
	if (blankAtEnd && closesBlock && before !== "") {
		return before.replace(/[ \t]*(?:\r\n|\r|\n)$/, "") + after;
	}
	return before + after;
}
