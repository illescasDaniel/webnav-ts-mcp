/** Shared formatting helpers for tool responses. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolInputError } from "./errors.js";
import type { IncomingCall, LspDiagnostic, LspLocation, LspSymbol, Range, SymbolNode } from "./lspTypes.js";
import { escapeRegExp, readTextStrict, splitLines } from "./text.js";

// LSP SymbolKind
const SYMBOL_KINDS: Record<number, string> = {
	1: "File",
	2: "Module",
	3: "Namespace",
	4: "Package",
	5: "Class",
	6: "Method",
	7: "Property",
	8: "Field",
	9: "Constructor",
	10: "Enum",
	11: "Interface",
	12: "Function",
	13: "Variable",
	14: "Constant",
	15: "String",
	16: "Number",
	17: "Boolean",
	18: "Array",
	19: "Object",
	20: "Key",
	21: "Null",
	22: "EnumMember",
	23: "Struct",
	24: "Event",
	25: "Operator",
	26: "TypeParameter",
};

export const DEFAULT_SEARCH_SYMBOL_LIMIT = 50;
export const DEFAULT_DIAGNOSTICS_LIMIT = 200;
// When the LSP range starts on a decorator line, walk this many lines past
// start to find the identifier.
const NAME_LOOKAHEAD_LINES = 8;

const DIAGNOSTIC_SEVERITIES: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

export function uriToPath(uri: string): string {
	try {
		const parsed = new URL(uri);
		if (parsed.protocol === "file:") {
			return fileURLToPath(parsed);
		}
		return decodeURIComponent(parsed.pathname);
	} catch {
		return uri;
	}
}

export function uriToRelative(uri: string, workspaceRoot: string): string {
	const abs = uriToPath(uri);
	const rel = path.relative(workspaceRoot, abs);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		return rel === "" ? "." : abs;
	}
	return rel.split(path.sep).join("/");
}

const linesCache = new Map<string, { mtimeMs: number; size: number; lines: string[] }>();

/** File lines, memoised per (path, mtime, size). `undefined` when unreadable or not UTF-8. */
function readLines(filePath: string): string[] | undefined {
	try {
		const stat = fs.statSync(filePath);
		const hit = linesCache.get(filePath);
		if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
			return hit.lines;
		}
		const lines = splitLines(readTextStrict(filePath));
		linesCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, lines });
		if (linesCache.size > 128) {
			const oldest = linesCache.keys().next().value;
			if (oldest !== undefined) {
				linesCache.delete(oldest);
			}
		}
		return lines;
	} catch {
		return undefined;
	}
}

export function snippet(uri: string, startLine: number, endLine: number, context = 0): string {
	const lines = readLines(uriToPath(uri));
	if (lines === undefined) {
		return "";
	}
	const lo = Math.max(0, startLine - context);
	const hi = Math.min(lines.length, endLine + 1 + context);
	const numbered: string[] = [];
	for (let i = lo; i < hi; i++) {
		numbered.push(`${String(i + 1).padStart(5)} | ${lines[i]}`);
	}
	return numbered.join("\n");
}

/** Prefer a LocationLink's selection range when present (narrower symbol span). */
function locationRange(loc: LspLocation): Range {
	if ("targetSelectionRange" in loc) {
		return loc.targetSelectionRange ?? {};
	}
	return loc.range ?? loc.targetRange ?? {};
}

export function formatLocation(loc: LspLocation, workspaceRoot: string): string {
	const uri = loc.uri ?? loc.targetUri ?? "";
	const rng = locationRange(loc);
	const start = rng.start ?? {};
	const end = rng.end ?? {};
	const startLine = start.line ?? 0;
	const startCol = start.character ?? 0;
	const endLine = end.line ?? startLine;
	const header = `${uriToRelative(uri, workspaceRoot)}:${startLine + 1}:${startCol + 1}`;
	const body = snippet(uri, startLine, endLine, 2);
	return body ? `${header}\n${body}` : header;
}

export function symbolKindLabel(kind: unknown): string {
	if (typeof kind === "number") {
		return SYMBOL_KINDS[kind] ?? `Kind${kind}`;
	}
	return "?";
}

/** 0-based (line, character) for `name` near the LSP range, else the range start. */
function namePosition(
	uri: string,
	name: string,
	startLine: number,
	startCol: number,
	endLine?: number,
): [number, number] {
	if (!name) {
		return [startLine, startCol];
	}
	const lines = readLines(uriToPath(uri));
	if (lines === undefined || startLine < 0 || startLine >= lines.length) {
		return [startLine, startCol];
	}
	const rangeEnd = endLine === undefined ? startLine : Math.max(startLine, endLine);
	const hi = Math.min(Math.max(rangeEnd, startLine + NAME_LOOKAHEAD_LINES), lines.length - 1);
	// Whole-identifier match, so `id` doesn't hit `valid`/`uuid`.
	const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, "g");
	for (let lineNo = startLine; lineNo <= hi; lineNo++) {
		const line = lines[lineNo] ?? "";
		if (line.trimStart().startsWith("@")) {
			continue; // decorator lines mention names without declaring them
		}
		let match: RegExpExecArray | null = null;
		if (lineNo === startLine) {
			// Skip keywords (class/function) that often begin the range.
			pattern.lastIndex = Math.min(Math.max(0, startCol), line.length);
			match = pattern.exec(line);
			if (!match) {
				pattern.lastIndex = 0;
				match = pattern.exec(line);
			}
		} else {
			pattern.lastIndex = 0;
			match = pattern.exec(line);
		}
		if (match) {
			return [lineNo, match.index];
		}
	}
	return [startLine, startCol];
}

/** (uri, 0-based line, 0-based character) aimed at the symbol name. */
export function workspaceSymbolPosition(sym: LspSymbol): [string, number, number] {
	const loc = sym.location ?? {};
	const uri = loc.uri ?? "";
	const selStart = sym.selectionRange?.start;
	if (selStart) {
		return [uri, selStart.line ?? 0, selStart.character ?? 0];
	}
	const start = loc.range?.start ?? {};
	const end = loc.range?.end ?? {};
	const startLine = start.line ?? 0;
	const startCol = start.character ?? 0;
	const [line, col] = namePosition(uri, sym.name ?? "", startLine, startCol, end.line);
	return [uri, line, col];
}

export function formatWorkspaceSymbol(sym: LspSymbol, workspaceRoot: string): string {
	const name = sym.name || "?";
	const kind = symbolKindLabel(sym.kind);
	const [uri, line, col] = workspaceSymbolPosition(sym);
	const rel = uri ? uriToRelative(uri, workspaceRoot) : "?";
	return `${name}  [${kind}]  (${rel}:${line + 1}:${col + 1})`;
}

// Tier for names that only match the language server's fuzzy subsequence search.
const FUZZY_TIER = 4;

export function matchTier(name: string, query: string): number {
	if (name === query) {
		return 0;
	}
	const foldedName = name.toLowerCase();
	const foldedQuery = query.toLowerCase();
	if (foldedName === foldedQuery) {
		return 1;
	}
	if (foldedName.startsWith(foldedQuery)) {
		return 2;
	}
	if (foldedName.includes(foldedQuery)) {
		return 3;
	}
	return FUZZY_TIER;
}

// Property/Field symbols rank after declarations within the same match tier:
// tsserver reports every `state.foo = x` assignment as its own Property symbol.
const LOW_PRIORITY_KINDS = new Set([7, 8]);
// Kinds that are "real" declarations: when one shares a name+file with a
// Variable, the Variable is almost always the `export { foo }` list entry.
const DECLARATION_KINDS = new Set([5, 10, 11, 12, 14]); // Class, Enum, Interface, Function, Constant
const VARIABLE_KIND = 13;

const TEST_DIR_NAMES = new Set(["tests", "test", "__tests__", "spec", "specs"]);

/** A path that looks like test code: under a tests-like directory or named like a test file. */
function isTestPath(p: string): boolean {
	const parts = p.replaceAll("\\", "/").split("/");
	const name = parts[parts.length - 1] ?? "";
	return (
		parts.slice(0, -1).some((part) => TEST_DIR_NAMES.has(part)) ||
		name.startsWith("test_") ||
		[".test.ts", ".test.js", ".spec.ts", ".spec.js"].some((suffix) => name.endsWith(suffix))
	);
}

function symbolFileKey(sym: LspSymbol): string {
	const loc = sym.location as { uri?: string; targetUri?: string } | undefined;
	return loc?.uri || loc?.targetUri || "";
}

/**
 * Exact → case-insensitive exact → prefix → substring → other; within a tier,
 * production code before tests, then declarations before properties/fields.
 */
export function rankWorkspaceSymbols(symbols: LspSymbol[], query: string): LspSymbol[] {
	if (!query) {
		return [...symbols];
	}
	const key = (sym: LspSymbol): [number, number, number] => [
		matchTier(sym.name ?? "", query),
		isTestPath(symbolFileKey(sym)) ? 1 : 0,
		sym.kind !== undefined && LOW_PRIORITY_KINDS.has(sym.kind) ? 1 : 0,
	];
	return symbols
		.map((sym) => ({ sym, key: key(sym) }))
		.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2])
		.map((entry) => entry.sym);
}

/**
 * Drop export-list Variable noise and repeated Property/Field assignments.
 * Preserves input order (call after `rankWorkspaceSymbols`).
 */
export function filterWorkspaceSymbols(symbols: LspSymbol[]): LspSymbol[] {
	const declarationKeys = new Set(
		symbols
			.filter((sym) => sym.kind !== undefined && DECLARATION_KINDS.has(sym.kind))
			.map((sym) => `${sym.name ?? ""}\0${symbolFileKey(sym)}`),
	);
	const filtered: LspSymbol[] = [];
	const seenLowPriority = new Set<string>();
	for (const sym of symbols) {
		const name = sym.name ?? "";
		const kind = sym.kind;
		const fileKey = symbolFileKey(sym);
		if (kind === VARIABLE_KIND && declarationKeys.has(`${name}\0${fileKey}`)) {
			continue;
		}
		if (kind !== undefined && LOW_PRIORITY_KINDS.has(kind)) {
			const key = `${name}\0${kind}\0${fileKey}`;
			if (seenLowPriority.has(key)) {
				continue;
			}
			seenLowPriority.add(key);
		}
		filtered.push(sym);
	}
	return filtered;
}

const KIND_BY_LABEL = new Map(Object.entries(SYMBOL_KINDS).map(([kind, label]) => [label.toLowerCase(), Number(kind)]));

/** `"class,function"` (case-insensitive SymbolKind labels) → kind numbers; blank → no filter. */
export function parseKindFilter(kind: string | undefined | null): ReadonlySet<number> | undefined {
	if (kind === undefined || kind === null || !kind.trim()) {
		return undefined;
	}
	const wanted = new Set<number>();
	for (const part of kind.split(",")) {
		const label = part.trim().toLowerCase();
		if (!label) {
			continue;
		}
		const number = KIND_BY_LABEL.get(label);
		if (number === undefined) {
			const valid = [...KIND_BY_LABEL.keys()].sort().join(", ");
			throw new ToolInputError(`unknown symbol kind '${part.trim()}'; use one or more of: ${valid}`);
		}
		wanted.add(number);
	}
	return wanted.size > 0 ? wanted : undefined;
}

/** Python `fnmatch` semantics: `*` crosses `/`, `?` is one char, `[seq]`/`[!seq]` classes. */
function fnmatchToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern.charAt(i);
		if (ch === "*") {
			out += ".*";
		} else if (ch === "?") {
			out += ".";
		} else if (ch === "[") {
			let j = i + 1;
			if (pattern.charAt(j) === "!") {
				j++;
			}
			if (pattern.charAt(j) === "]") {
				j++;
			}
			while (j < pattern.length && pattern.charAt(j) !== "]") {
				j++;
			}
			if (j >= pattern.length) {
				out += "\\[";
			} else {
				let body = pattern.slice(i + 1, j).replaceAll("\\", "\\\\");
				if (body.startsWith("!")) {
					body = `^${body.slice(1)}`;
				} else if (body.startsWith("^")) {
					body = `\\${body}`;
				}
				out += `[${body}]`;
				i = j;
			}
		} else {
			out += escapeRegExp(ch);
		}
	}
	return new RegExp(`^${out}$`, "s");
}

function pathFilterMatches(relPath: string, patternRaw: string): boolean {
	let pattern = patternRaw.trim().replaceAll("\\", "/");
	if (pattern.startsWith("./")) {
		pattern = pattern.slice(2);
	}
	if (/[*?[]/.test(pattern)) {
		return fnmatchToRegExp(pattern).test(relPath);
	}
	return relPath.startsWith(pattern);
}

/** Keep symbols of the given kinds under `path` (workspace-relative prefix, or a glob when it contains `*?[`). */
export function filterSymbolsByKindAndPath(
	symbols: LspSymbol[],
	workspaceRoot: string,
	options: { kinds?: ReadonlySet<number> | undefined; path?: string | undefined | null },
): LspSymbol[] {
	const { kinds, path: pathFilter } = options;
	const hasPath = Boolean(pathFilter?.trim());
	if (kinds === undefined && !hasPath) {
		return symbols;
	}
	return symbols.filter((sym) => {
		if (kinds !== undefined && (sym.kind === undefined || !kinds.has(sym.kind))) {
			return false;
		}
		if (hasPath && !pathFilterMatches(uriToRelative(symbolFileKey(sym), workspaceRoot), pathFilter as string)) {
			return false;
		}
		return true;
	});
}

/**
 * Ranked, capped listing. Unless `fuzzy`, loose subsequence-only hits (tier 4)
 * are hidden whenever the name really contains the query somewhere (tiers 0-3).
 */
export function formatWorkspaceSymbols(
	symbols: LspSymbol[],
	workspaceRoot: string,
	options: { query?: string; limit?: number; fuzzy?: boolean } = {},
): string {
	const { query = "", limit = DEFAULT_SEARCH_SYMBOL_LIMIT, fuzzy = false } = options;
	if (symbols.length === 0) {
		return "";
	}
	let ranked = filterWorkspaceSymbols(rankWorkspaceSymbols(symbols, query));
	let hiddenFuzzy = 0;
	if (query && !fuzzy) {
		const real = ranked.filter((sym) => matchTier(sym.name ?? "", query) < FUZZY_TIER);
		if (real.length > 0) {
			hiddenFuzzy = ranked.length - real.length;
			ranked = real;
		}
	}
	const shown = ranked.slice(0, Math.max(0, limit));
	const lines = shown.map((sym) => formatWorkspaceSymbol(sym, workspaceRoot));
	const omitted = ranked.length - shown.length;
	if (omitted > 0) {
		lines.push(`… and ${omitted} more (showing first ${shown.length}); narrow with kind=… or path=…`);
	}
	if (hiddenFuzzy > 0) {
		lines.push(
			`(${hiddenFuzzy} looser fuzzy match${hiddenFuzzy !== 1 ? "es" : ""} whose names don't contain ` +
				`${pyRepr(query)} hidden; pass fuzzy=true to list them)`,
		);
	}
	return lines.join("\n");
}

/** Python-style `repr()` of a string, as the tool texts have always quoted names. */
export function pyRepr(text: string): string {
	if (text.includes("'") && !text.includes('"')) {
		return `"${text.replaceAll("\\", "\\\\")}"`;
	}
	return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export function formatDiagnostic(item: LspDiagnostic): string {
	const start = item.range?.start ?? {};
	const severity = DIAGNOSTIC_SEVERITIES[item.severity ?? -1] ?? "?";
	const code = item.code;
	const tag = code !== undefined && code !== null && code !== "" ? `${severity} ${code}` : severity;
	const lines = splitLines(String(item.message ?? ""));
	if (lines.length === 0) {
		lines.push("");
	}
	const header = `${(start.line ?? 0) + 1}:${(start.character ?? 0) + 1} [${tag}] ${lines[0]}`;
	return [header, ...lines.slice(1).map((line) => `    ${line}`)].join("\n");
}

/** Capped, so a badly broken file can't flood the caller with an unbounded wall of text. */
export function formatDiagnostics(items: LspDiagnostic[], limit = DEFAULT_DIAGNOSTICS_LIMIT): string {
	if (items.length === 0) {
		return "No diagnostics.";
	}
	const shown = items.slice(0, Math.max(0, limit));
	const lines = shown.map(formatDiagnostic);
	const omitted = items.length - shown.length;
	if (omitted > 0) {
		lines.push(`… and ${omitted} more (showing first ${shown.length})`);
	}
	return lines.join("\n");
}

export const DEFAULT_REFERENCE_FILE_LIMIT = 25;

/** Compact `path: L12, L40, …` grouping (no snippets). */
export function formatReferencesGrouped(
	locations: LspLocation[],
	workspaceRoot: string,
	options: { fileLimit?: number; withColumns?: boolean } = {},
): string {
	const { fileLimit = DEFAULT_REFERENCE_FILE_LIMIT, withColumns = false } = options;
	if (locations.length === 0) {
		return "No references found.";
	}
	const groups = new Map<string, Map<string, [number, number]>>();
	for (const loc of locations) {
		const uri = loc.uri ?? loc.targetUri ?? "";
		const start = locationRange(loc).start ?? {};
		const line = (start.line ?? 0) + 1;
		const col = (start.character ?? 0) + 1;
		const rel = uriToRelative(uri, workspaceRoot);
		let group = groups.get(rel);
		if (!group) {
			group = new Map();
			groups.set(rel, group);
		}
		group.set(`${line}:${col}`, [line, col]);
	}
	let total = 0;
	for (const group of groups.values()) {
		total += group.size;
	}
	const files = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const shown = files.slice(0, fileLimit);
	const tag = (line: number, col: number): string => (withColumns ? `L${line}:${col}` : `L${line}`);
	const lines = [`${total} reference(s) in ${files.length} file(s):`];
	for (const [rel, positions] of shown) {
		const sorted = [...positions.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		lines.push(`${rel}: ${sorted.map(([l, c]) => tag(l, c)).join(", ")}`);
	}
	const omitted = files.length - shown.length;
	if (omitted > 0) {
		lines.push(`… and ${omitted} more file(s)`);
	}
	return lines.join("\n");
}

export const DEFAULT_REFERENCES_SNIPPET_LIMIT = 8;

/** Full per-location snippets for a few hits; above `snippetLimit`, the compact grouped listing. */
export function formatReferences(
	locations: LspLocation[],
	workspaceRoot: string,
	snippetLimit = DEFAULT_REFERENCES_SNIPPET_LIMIT,
): string {
	if (locations.length === 0) {
		return "No references found at that position.";
	}
	if (locations.length <= snippetLimit) {
		return locations.map((loc) => formatLocation(loc, workspaceRoot)).join("\n\n");
	}
	const grouped = formatReferencesGrouped(locations, workspaceRoot, { withColumns: true });
	return `(compact list: ${locations.length} > ${snippetLimit} hits)\n${grouped}`;
}

/** Nested `DocumentSymbol` (has `range`, no `location`) rather than flat `SymbolInformation`. */
export function isHierarchicalDocumentSymbols(symbols: LspSymbol[]): boolean {
	const first = symbols[0];
	return first !== undefined && "range" in first && !("location" in first);
}

function documentSymbolNode(sym: LspSymbol): SymbolNode {
	const start = sym.range?.start ?? {};
	const end = sym.range?.end ?? {};
	return {
		name: sym.name || "?",
		kind: sym.kind,
		startLine: start.line ?? 0,
		endLine: end.line ?? start.line ?? 0,
		// Some servers (tsserver) return siblings alphabetically, not in file order.
		children: (sym.children ?? []).map(documentSymbolNode).sort((a, b) => a.startLine - b.startLine),
	};
}

/** Nest a flat `SymbolInformation` list by range containment. */
function nestSymbolInformation(symbols: LspSymbol[]): SymbolNode[] {
	const nodes: SymbolNode[] = symbols.map((sym) => {
		const start = sym.location?.range?.start ?? {};
		const end = sym.location?.range?.end ?? {};
		return {
			name: sym.name || "?",
			kind: sym.kind,
			startLine: start.line ?? 0,
			endLine: end.line ?? start.line ?? 0,
			children: [],
		};
	});
	nodes.sort((a, b) => a.startLine - b.startLine || b.endLine - b.startLine - (a.endLine - a.startLine));
	const roots: SymbolNode[] = [];
	const stack: SymbolNode[] = [];
	for (const node of nodes) {
		for (
			let top = stack[stack.length - 1];
			top && !(top.startLine <= node.startLine && node.endLine <= top.endLine);
		) {
			stack.pop();
			top = stack[stack.length - 1];
		}
		const parent = stack[stack.length - 1];
		(parent ? parent.children : roots).push(node);
		stack.push(node);
	}
	return roots;
}

/** Normalise either shape `documentSymbol` can return into `{name, kind, startLine, endLine, children}`. */
export function toSymbolTree(symbols: LspSymbol[]): SymbolNode[] {
	if (isHierarchicalDocumentSymbols(symbols)) {
		return symbols.map(documentSymbolNode).sort((a, b) => a.startLine - b.startLine);
	}
	return nestSymbolInformation(symbols);
}

// Kinds whose children are implementation detail (locals, callbacks,
// object-literal keys) rather than structure: Method, Constructor, Function, Variable, Constant.
export const LOCALS_HOLDER_KINDS: ReadonlySet<number> = new Set([6, 9, 12, 13, 14]);

/** Indented `name  [Kind]  :start-end` tree; children of `collapseKinds` symbols are left out. */
export function formatOutline(
	symbols: LspSymbol[],
	options: { indent?: string; collapseKinds?: ReadonlySet<number> } = {},
): string {
	const { indent = "  ", collapseKinds = new Set<number>() } = options;
	if (symbols.length === 0) {
		return "No symbols found.";
	}
	const lines: string[] = [];
	const walk = (nodes: SymbolNode[], depth: number): void => {
		for (const node of nodes) {
			const start = node.startLine + 1;
			const end = node.endLine + 1;
			const span = start === end ? `:${start}` : `:${start}-${end}`;
			lines.push(`${indent.repeat(depth)}${node.name}  [${symbolKindLabel(node.kind)}]  ${span}`);
			if (node.kind === undefined || !collapseKinds.has(node.kind)) {
				walk(node.children, depth + 1);
			}
		}
	};
	walk(toSymbolTree(symbols), 0);
	return lines.join("\n");
}

/**
 * `callHierarchy/incomingCalls` results as `caller  [Kind]  (path:line) calls at L.., L..`:
 * the caller's own position plus every call-site line within it, so an agent sees who
 * calls a function without imports/type-only usages mixed in (unlike `references`).
 */
export function formatCallers(incoming: IncomingCall[], workspaceRoot: string): string {
	if (incoming.length === 0) {
		return "No callers found.";
	}
	return incoming
		.map((call) => {
			const from = call.from ?? {};
			const callerLine = (from.selectionRange?.start?.line ?? 0) + 1;
			const sites = [...new Set((call.fromRanges ?? []).map((r) => (r.start?.line ?? 0) + 1))].sort((a, b) => a - b);
			const callSites = sites.length > 0 ? sites.map((n) => `L${n}`).join(", ") : `L${callerLine}`;
			const rel = uriToRelative(from.uri ?? "", workspaceRoot);
			return `${from.name || "?"}  [${symbolKindLabel(from.kind)}]  (${rel}:${callerLine}) calls at ${callSites}`;
		})
		.join("\n");
}

/**
 * The symbol whose name sits at a 0-based position, qualified by its enclosing
 * classes/interfaces (`Square.area`). Falls back to the innermost symbol whose
 * range contains the position.
 */
export function symbolAt(
	symbols: LspSymbol[],
	line: number,
	character: number,
): { label: string; kind: number | undefined } | undefined {
	const walk = (nodes: LspSymbol[], owners: string[]): { label: string; kind: number | undefined } | undefined => {
		for (const node of nodes) {
			const start = node.selectionRange?.start ?? node.range?.start;
			const inRange =
				node.range?.start !== undefined &&
				node.range.end !== undefined &&
				(node.range.start.line ?? 0) <= line &&
				line <= (node.range.end.line ?? 0);
			if (!inRange) {
				continue;
			}
			const nested = owners.concat(node.kind === 5 || node.kind === 11 ? [node.name ?? "?"] : []);
			const inner = walk(node.children ?? [], nested);
			if (inner) {
				return inner;
			}
			if (start && (start.line ?? 0) === line && (start.character ?? 0) === character) {
				return { label: [...owners, node.name ?? "?"].join("."), kind: node.kind };
			}
		}
		return undefined;
	};
	if (isHierarchicalDocumentSymbols(symbols)) {
		return walk(symbols, []);
	}
	return undefined;
}
