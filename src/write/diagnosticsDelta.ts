/**
 * What an edit does to a project's diagnostics: the same files checked with
 * and without the edit, compared as multisets so a line that merely moved
 * (an insertion above it) is not reported as a new error.
 */

import path from "node:path";
import type { LspDiagnostic } from "../shared/lspTypes.js";
import { lineStarts } from "./edits.js";

const ERROR = 1;
const WARNING = 2;
const HINT = 4;
const SHOWN_PER_SECTION = 12;

export interface DiagEntry {
	file: string;
	line: number;
	column: number;
	severity: number;
	code: string;
	message: string;
	/** The trimmed source line the diagnostic points at: what makes two entries "the same" across an edit. */
	lineText: string;
}

export const isError = (e: DiagEntry): boolean => e.severity === ERROR;

const entryKey = (e: DiagEntry): string => `${e.file}\0${e.code}\0${e.message}\0${e.lineText}`;

export function entriesFromLsp(file: string, text: string, items: readonly LspDiagnostic[]): DiagEntry[] {
	const starts = lineStarts(text);
	return items.map((item) => {
		const line = item.range?.start?.line ?? 0;
		const startOffset = starts[line] ?? text.length;
		const endOffset = starts[line + 1] ?? text.length;
		return {
			file,
			line: line + 1,
			column: (item.range?.start?.character ?? 0) + 1,
			severity: item.severity ?? ERROR,
			code: item.code === undefined || item.code === null ? "" : String(item.code),
			message: String(item.message ?? "").split("\n")[0] ?? "",
			lineText: text.slice(startOffset, endOffset).trim(),
		};
	});
}

export function renderEntry(e: DiagEntry): string {
	const kind = e.severity === ERROR ? "error" : e.severity === WARNING ? "warning" : "info";
	const tag = e.code ? `${kind} ${e.code}` : kind;
	const where = `${e.file}:${e.line}:${e.column}`;
	return `${where} [${tag}] ${e.message}${e.lineText ? `\n      | ${e.lineText.slice(0, 160)}` : ""}`;
}

const looseKey = (e: DiagEntry): string => `${e.file}\0${e.code}\0${e.message}`;

/**
 * Pair up entries of `before` and `after` that are the same diagnostic: first those on identical source
 * lines, then (so an edit to the very line an old error sits on does not turn it into a "new" one) those
 * with the same file, code and message. What is left over is `added` (only after) and `removed` (only before).
 */
function pairUp(before: DiagEntry[], after: DiagEntry[]): { added: DiagEntry[]; removed: DiagEntry[] } {
	let added = after;
	let removed = before;
	for (const keyOf of [entryKey, looseKey]) {
		const pool = new Map<string, DiagEntry[]>();
		for (const e of removed) {
			pool.set(keyOf(e), [...(pool.get(keyOf(e)) ?? []), e]);
		}
		const stillAdded: DiagEntry[] = [];
		for (const e of added) {
			const bucket = pool.get(keyOf(e));
			if (bucket && bucket.length > 0) {
				bucket.pop();
			} else {
				stillAdded.push(e);
			}
		}
		added = stillAdded;
		removed = [...pool.values()].flat();
	}
	return { added, removed };
}

export interface DiagnosticsDelta {
	newErrors: DiagEntry[];
	fixedErrors: DiagEntry[];
	newWarnings: DiagEntry[];
	fixedWarnings: DiagEntry[];
	filesChecked: number;
	/** Files that could not be checked, or notes on what was skipped. */
	unchecked: string[];
}

export function diffDiagnostics(before: DiagEntry[], after: DiagEntry[]): DiagnosticsDelta {
	// Hints are editor niceties ("x is never read"): adding a parameter before its body uses it would
	// otherwise be reported as a new problem on every such edit.
	const keep = (e: DiagEntry): boolean => e.severity !== HINT;
	const b = before.filter(keep);
	const a = after.filter(keep);
	const { added: newOnes, removed: fixedOnes } = pairUp(b, a);
	return {
		newErrors: newOnes.filter(isError),
		fixedErrors: fixedOnes.filter(isError),
		newWarnings: newOnes.filter((e) => !isError(e)),
		fixedWarnings: fixedOnes.filter((e) => !isError(e)),
		filesChecked: 0,
		unchecked: [],
	};
}

/**
 * Parse errors: syntax problems in scripts (TypeScript's 1xxx codes) and any error from the CSS
 * server (it only reports errors for malformed CSS). Writing these is never worth it.
 */
export function isSyntaxError(e: DiagEntry): boolean {
	if (!isError(e)) {
		return false;
	}
	const ext = path.extname(e.file).toLowerCase();
	if (ext === ".css") {
		return true;
	}
	const code = Number(e.code);
	return Number.isInteger(code) && code >= 1000 && code < 2000;
}

function section(title: string, entries: DiagEntry[]): string[] {
	if (entries.length === 0) {
		return [];
	}
	const lines = [`${title}:`, ...entries.slice(0, SHOWN_PER_SECTION).map((e) => `  ${renderEntry(e)}`)];
	if (entries.length > SHOWN_PER_SECTION) {
		lines.push(`  ... ${entries.length - SHOWN_PER_SECTION} more`);
	}
	return lines;
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function formatDelta(delta: DiagnosticsDelta): string {
	const summary = [
		`${count(delta.newErrors.length, "new error")}`,
		`${count(delta.fixedErrors.length, "error")} fixed`,
		`${count(delta.newWarnings.length, "new warning")}`,
	].join(", ");
	const lines = [`Type check of ${count(delta.filesChecked, "file")} (edited files and their importers): ${summary}.`];
	lines.push(...section("New errors", delta.newErrors));
	lines.push(...section("New warnings", delta.newWarnings));
	lines.push(...section("Errors fixed", delta.fixedErrors));
	if (delta.unchecked.length > 0) {
		lines.push(`Not checked: ${delta.unchecked.join(", ")}`);
	}
	return lines.join("\n");
}
