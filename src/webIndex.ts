/**
 * Workspace-wide CSS custom-property and class/id selector index.
 *
 * The CSS/HTML language servers each see one document at a time, so `var(--x)`
 * usages and `#id`/`.class` selectors can't be cross-referenced across files.
 * This is a plain scanner, not a language server: no `@import` resolution, no
 * CSS parser, regex/brace-stack grade. It rescans on every call but reuses each
 * root's parsed index while that root's files are unchanged: the cache key is
 * the `(path, mtime_ns, size)` of every relevant file, re-stat'd on each call,
 * so an edit, add, or delete always invalidates it.
 *
 * One or more named roots are indexed separately, since each may define its own
 * values/markup and mixing them into one answer would be misleading (see
 * `buildWorkspaceIndex`; a project configures its roots via
 * `WEBNAV_MCP_ROOTS`). Positions are 1-indexed lines.
 */

import fs from "node:fs";
import path from "node:path";
import { EXCLUDED_DIR_NAMES } from "./shared/exclude.js";
import { pyRepr } from "./shared/format.js";
import { comparePaths, relativeWithin, resolveReal, toPosix } from "./shared/paths.js";
import { readTextStrict } from "./shared/text.js";

export const DEFAULT_ROOT_LABEL = "web";

const VAR_DECL_RE = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;{}]+);/g;
const VAR_USE_RE = /var\(\s*(--[a-zA-Z0-9_-]+)\s*(,)?/g;
const SELECTOR_TOKEN_RE = /[.#][a-zA-Z_-][a-zA-Z0-9_-]*/g;

const STYLE_BLOCK_RE = /<style\b[^>]*>(.*?)<\/style>/dgis;
// `(?<![\w-])`, not `\b`: `\b` also matches inside `data-id` / `data-style`.
const STYLE_ATTR_RE = /(?<![\w-])style\s*=\s*"([^"]*)"/dgi;
// A `src=` attribute means the tag has no inline body to scan.
const SCRIPT_BLOCK_RE = /<script\b(?![^>]*\bsrc\s*=)[^>]*>(.*?)<\/script>/dgis;
// Quote is a backreference (group 1) so `id="x"` and `id='x'` both match; the
// value is group 2. Used for HTML markup and, since JS string literals may
// themselves quote HTML (`innerHTML = '<span class="x">'`), for JS source too.
const ID_ATTR_RE = /(?<![\w-])id\s*=\s*(["'])([^"']+)\1/dgi;
const CLASS_ATTR_RE = /(?<![\w-])class\s*=\s*(["'])([^"']*)\1/dgi;

// JS string literals below accept backticks too (template literals); a `${…}`
// inside one ends the static part and is treated like a `+` concatenation.
const JS_SETPROPERTY_RE = /\.setProperty\(\s*["'`](--[a-zA-Z0-9_-]+)["'`]/g;
const JS_GETPROPERTYVALUE_RE = /\.getPropertyValue\(\s*["'`](--[a-zA-Z0-9_-]+)["'`]/g;
const JS_GET_ELEMENT_BY_ID_RE = /getElementById\(\s*["'`]([^"'`]*)["'`]\s*(\+)?/g;
const JS_CLASSLIST_RE = /classList\.(add|remove|toggle|contains)\(([^)]*)\)/g;
// An optional TypeScript type argument (`querySelector<HTMLElement>(...)`, one
// nesting level) may sit before the `(`.
const TS_TYPE_ARGS = "(?:<[^()<>]*(?:<[^()<>]*>[^()<>]*)*>)?";
const JS_QUERY_RE = new RegExp(
	`\\b(?:querySelector(?:All)?|closest|matches)${TS_TYPE_ARGS}\\(\\s*["'\`]([^"'\`]*)["'\`]`,
	"g",
);
const JS_CLASSNAME_ASSIGN_RE = /className\s*\+?=\s*["'`]([^"'`]*)["'`]\s*(\+)?/g;
const TEMPLATE_EXPR_RE = /\$\{[^}]*\}/g;
// A local variable conventionally named like a class list (`mediaClass`,
// `rowClasses`) being built up with `+=`. The exact identifier `className` is
// excluded (JS_CLASSNAME_ASSIGN_RE covers it) so the two don't double-record.
const JS_CLASS_VAR_CONCAT_RE = /\b(?!className\b)\w*[Cc]lass\w*\s*\+=\s*["'`]([^"'`]*)["'`]\s*(\+)?/g;
// A string literal, optionally followed by `+`: finds dynamic prefixes inside `classList.add(...)` arguments.
const STRING_LITERAL_RE = /["'`]([^"'`]*)["'`]\s*(\+)?/g;
// A whole string literal that is itself a bare identifier-like name, not
// followed by `+`. Projects wrap DOM lookups in their own helpers
// (`onClick("btn-save", …)`) that no fixed list of DOM APIs can know about.
const BARE_NAME_LITERAL_RE = /(["'`])([A-Za-z_][A-Za-z0-9_-]*)\1(?!\s*\+)/g;

type Match = RegExpMatchArray & { index: number; indices: RegExpIndicesArray };

function* finditer(re: RegExp, text: string): Generator<Match> {
	for (const match of text.matchAll(re)) {
		yield match as Match;
	}
}

/** 1-indexed line lookup for character offsets of one text (binary search over newline positions). */
function makeLineAt(text: string): (index: number) => number {
	const newlines: number[] = [];
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
		newlines.push(i);
	}
	return (index) => {
		let lo = 0;
		let hi = newlines.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((newlines[mid] as number) < index) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		return lo + 1;
	};
}

const keepNewlines = (m: string): string => "\n".repeat(m.split("\n").length - 1);

function stripCssComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, keepNewlines);
}

/**
 * Drop `//` and `/* *\/` comments (keeping newlines so line numbers hold), but
 * not comment-looking text inside string literals (`"http://x"`). ' and "
 * strings end at a newline, so a stray quote in a regex literal can't desync
 * the scan past its own line.
 */
function stripJsComments(text: string): string {
	if (!text.includes("//") && !text.includes("/*")) {
		return text;
	}
	const out: string[] = [];
	const n = text.length;
	let quote = "";
	let i = 0;
	while (i < n) {
		const ch = text.charAt(i);
		if (quote) {
			out.push(ch);
			if (ch === "\\" && i + 1 < n) {
				out.push(text.charAt(i + 1));
				i += 2;
				continue;
			}
			if (ch === quote || (ch === "\n" && quote !== "`")) {
				quote = "";
			}
			i++;
		} else if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			out.push(ch);
			i++;
		} else if (text.startsWith("//", i)) {
			const end = text.indexOf("\n", i);
			i = end < 0 ? n : end;
		} else if (text.startsWith("/*", i)) {
			let end = text.indexOf("*/", i + 2);
			end = end < 0 ? n : end + 2;
			out.push("\n".repeat(text.slice(i, end).split("\n").length - 1));
			i = end;
		} else {
			out.push(ch);
			i++;
		}
	}
	return out.join("");
}

/** A template literal's text up to its first `${…}`, flagged dynamic (the same shape as `"view-" + x`). */
function staticPrefix(literal: string, concatFollows: boolean): [string, boolean] {
	const at = literal.indexOf("${");
	return at >= 0 ? [literal.slice(0, at), true] : [literal, concatFollows];
}

function stripHtmlComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, keepNewlines);
}

export interface VarDeclaration {
	name: string;
	value: string;
	/** e.g. "@media (prefers-color-scheme: dark) › :root" */
	context: string;
	/** Relative to the root. */
	file: string;
	line: number;
}

export interface VarUsage {
	name: string;
	file: string;
	line: number;
	hasFallback: boolean;
}

export interface SelectorHit {
	/** "#id" or ".class" */
	token: string;
	kind: "css" | "html" | "js";
	file: string;
	line: number;
	/** e.g. "getElementById", "classList.add", "CSS rule" */
	detail: string;
	/** A JS hit built from string concatenation (only a static prefix is known). */
	dynamic: boolean;
}

export class RootIndex {
	varDeclarations = new Map<string, VarDeclaration[]>();
	varUsages = new Map<string, VarUsage[]>();
	selectorHits = new Map<string, SelectorHit[]>();
	/** bare name (no `#`/`.`) -> (file, line) of each JS/TS string literal equal to it */
	stringLiterals = new Map<string, [string, number][]>();

	constructor(
		readonly name: string,
		readonly root: string,
		/** Directory the recorded `file` paths are relative to (the workspace root in multi-root setups). */
		readonly base: string = root,
	) {}

	addDeclaration(decl: VarDeclaration): void {
		pushTo(this.varDeclarations, decl.name, decl);
	}

	addUsage(usage: VarUsage): void {
		pushTo(this.varUsages, usage.name, usage);
	}

	addSelectorHit(
		hit: Omit<SelectorHit, "detail" | "dynamic"> & Partial<Pick<SelectorHit, "detail" | "dynamic">>,
	): void {
		pushTo(this.selectorHits, hit.token, { detail: "", dynamic: false, ...hit });
	}
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
	const list = map.get(key);
	if (list) {
		list.push(value);
	} else {
		map.set(key, [value]);
	}
}

interface Block {
	selector: string;
	/** Index just after the opening '{'. */
	start: number;
	/** Index of the matching '}' (-1 until closed). */
	end: number;
	parent: Block | undefined;
}

/**
 * Brace-stack pass over (comment-stripped) CSS: one `Block` per `{...}`, each
 * knowing its own selector text and parent, enough to build a context
 * breadcrumb for anything nested inside it.
 */
function parseBlocks(text: string): Block[] {
	const blocks: Block[] = [];
	const openStack: Block[] = [];
	let bufStart = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charAt(i);
		if (ch === "{") {
			const selector = text.slice(bufStart, i).replace(/\s+/g, " ").trim();
			const block: Block = { selector, start: i + 1, end: -1, parent: openStack[openStack.length - 1] };
			openStack.push(block);
			blocks.push(block);
			bufStart = i + 1;
		} else if (ch === "}") {
			const closed = openStack.pop();
			if (closed) {
				closed.end = i;
			}
			bufStart = i + 1;
		} else if (ch === ";") {
			// A declaration (`color: #abc;`) ends here; without this reset, the
			// next nested rule's selector text would swallow it.
			bufStart = i + 1;
		}
	}
	return blocks;
}

function enclosingBlock(blocks: Block[], idx: number): Block | undefined {
	let best: Block | undefined;
	for (const b of blocks) {
		if (b.end === -1) {
			continue;
		}
		if (b.start <= idx && idx < b.end && (best === undefined || b.end - b.start < best.end - best.start)) {
			best = b;
		}
	}
	return best;
}

function breadcrumb(block: Block | undefined): string {
	const parts: string[] = [];
	for (let b = block; b !== undefined; b = b.parent) {
		if (b.selector) {
			parts.push(b.selector);
		}
	}
	return parts.reverse().join(" › ");
}

function scanCssText(text: string, fileRel: string, rootIndex: RootIndex, lineOffset = 0): void {
	text = stripCssComments(text);
	const blocks = parseBlocks(text);
	const lineAt = makeLineAt(text);

	for (const block of blocks) {
		if (block.end === -1 || block.selector.startsWith("@") || !block.selector) {
			continue;
		}
		const line = lineAt(block.start - 1) + lineOffset;
		for (const part of block.selector.split(",")) {
			for (const match of finditer(SELECTOR_TOKEN_RE, part)) {
				rootIndex.addSelectorHit({ token: match[0], kind: "css", file: fileRel, line, detail: "CSS rule" });
			}
		}
	}

	for (const match of finditer(VAR_DECL_RE, text)) {
		const context = breadcrumb(enclosingBlock(blocks, match.index));
		rootIndex.addDeclaration({
			name: match[1] as string,
			value: (match[2] as string).trim(),
			context,
			file: fileRel,
			line: lineAt(match.index) + lineOffset,
		});
	}

	for (const match of finditer(VAR_USE_RE, text)) {
		rootIndex.addUsage({
			name: match[1] as string,
			file: fileRel,
			line: lineAt(match.index) + lineOffset,
			hasFallback: Boolean(match[2]),
		});
	}
}

function scanHtmlText(text: string, fileRel: string, rootIndex: RootIndex): void {
	text = stripHtmlComments(text);
	const lineAt = makeLineAt(text);

	for (const styleMatch of finditer(STYLE_BLOCK_RE, text)) {
		const [start] = styleMatch.indices[1] as [number, number];
		scanCssText(styleMatch[1] as string, fileRel, rootIndex, lineAt(start) - 1);
	}

	for (const attrMatch of finditer(STYLE_ATTR_RE, text)) {
		const [start] = attrMatch.indices[1] as [number, number];
		scanCssText(attrMatch[1] as string, fileRel, rootIndex, lineAt(start) - 1);
	}

	for (const scriptMatch of finditer(SCRIPT_BLOCK_RE, text)) {
		const [start] = scriptMatch.indices[1] as [number, number];
		scanJsText(scriptMatch[1] as string, fileRel, rootIndex, lineAt(start) - 1);
	}

	scanMarkupAttrs(text, fileRel, rootIndex, "html", "id attribute", "class attribute");
}

/**
 * `id="x"`/`class="a b"` attributes in `text`. Shared by HTML markup and by JS
 * source, since JS often builds markup from string literals.
 */
function scanMarkupAttrs(
	text: string,
	fileRel: string,
	rootIndex: RootIndex,
	kind: SelectorHit["kind"],
	idDetail: string,
	classDetail: string,
	lineOffset = 0,
): void {
	const lineAt = makeLineAt(text);
	for (const match of finditer(ID_ATTR_RE, text)) {
		const line = lineAt(match.index) + lineOffset;
		// `id="row-${i}"` (JS template): only the static prefix is known.
		const [name, dynamic] = staticPrefix(match[2] as string, false);
		if (name) {
			rootIndex.addSelectorHit({ token: `#${name}`, kind, file: fileRel, line, detail: idDetail, dynamic });
		}
	}

	for (const match of finditer(CLASS_ATTR_RE, text)) {
		const line = lineAt(match.index) + lineOffset;
		for (const token of (match[2] as string).split(/\s+/).filter(Boolean)) {
			const [name, dynamic] = staticPrefix(token, false);
			if (!name) {
				continue;
			}
			rootIndex.addSelectorHit({ token: `.${name}`, kind, file: fileRel, line, detail: classDetail, dynamic });
		}
	}
}

/** `[token, dynamic]` pairs; a token cut short by a template `${…}` is a dynamic prefix (`.item-${n}` -> `.item-`). */
function jsSelectorTokensFromString(value: string): [string, boolean][] {
	const replaced = value.replace(TEMPLATE_EXPR_RE, "\0");
	return [...finditer(SELECTOR_TOKEN_RE, replaced)].map((m) => [
		m[0],
		replaced.slice(m.index + m[0].length, m.index + m[0].length + 1) === "\0",
	]);
}

/**
 * Split a class-list string literal into whitespace-separated tokens, tagging
 * the *last* one as a dynamic prefix when something is concatenated right
 * after it (`"tool-status resolution-" + x`). A trailing space in the literal
 * means the concatenation starts a fresh, separate class name, so nothing is
 * marked dynamic in that case.
 */
function literalTokens(literal: string, concatFollows: boolean): [string, boolean][] {
	const tokens = literal.split(/\s+/).filter(Boolean);
	if (tokens.length === 0) {
		return [];
	}
	const endsWithSpace = /\s$/.test(literal);
	const dynamicPrefix = concatFollows && !endsWithSpace;
	return tokens.map((tok, i) => [tok, dynamicPrefix && i === tokens.length - 1]);
}

function scanJsText(text: string, fileRel: string, rootIndex: RootIndex, lineOffset = 0): void {
	text = stripJsComments(text);
	const lineAt = makeLineAt(text);
	const at = (match: Match): number => lineAt(match.index) + lineOffset;
	const hit = (token: string, line: number, detail: string, dynamic: boolean): void =>
		rootIndex.addSelectorHit({ token, kind: "js", file: fileRel, line, detail, dynamic });

	for (const match of finditer(JS_SETPROPERTY_RE, text)) {
		rootIndex.addUsage({ name: match[1] as string, file: fileRel, line: at(match), hasFallback: true });
	}

	for (const match of finditer(JS_GETPROPERTYVALUE_RE, text)) {
		rootIndex.addUsage({ name: match[1] as string, file: fileRel, line: at(match), hasFallback: true });
	}

	for (const match of finditer(JS_GET_ELEMENT_BY_ID_RE, text)) {
		const [literal, hasConcat] = staticPrefix(match[1] as string, Boolean(match[2]));
		if (!literal) {
			continue;
		}
		hit(`#${literal}`, at(match), "getElementById", hasConcat);
	}

	for (const match of finditer(JS_CLASSLIST_RE, text)) {
		const method = match[1] as string;
		const line = at(match);
		for (const lit of finditer(STRING_LITERAL_RE, match[2] as string)) {
			const [literal, concatFollows] = staticPrefix(lit[1] as string, Boolean(lit[2]));
			for (const [token, dynamic] of literalTokens(literal, concatFollows)) {
				hit(`.${token}`, line, `classList.${method}`, dynamic);
			}
		}
	}

	for (const match of finditer(JS_QUERY_RE, text)) {
		const line = at(match);
		for (const [token, dynamic] of jsSelectorTokensFromString(match[1] as string)) {
			hit(token, line, "querySelector", dynamic);
		}
	}

	for (const match of finditer(JS_CLASSNAME_ASSIGN_RE, text)) {
		const line = at(match);
		const [literal, concatFollows] = staticPrefix(match[1] as string, Boolean(match[2]));
		for (const [token, dynamic] of literalTokens(literal, concatFollows)) {
			hit(`.${token}`, line, "className", dynamic);
		}
	}

	for (const match of finditer(JS_CLASS_VAR_CONCAT_RE, text)) {
		const line = at(match);
		const [literal, concatFollows] = staticPrefix(match[1] as string, Boolean(match[2]));
		for (const [token, dynamic] of literalTokens(literal, concatFollows)) {
			hit(`.${token}`, line, "class-var +=", dynamic);
		}
	}

	for (const match of finditer(BARE_NAME_LITERAL_RE, text)) {
		pushTo(rootIndex.stringLiterals, match[2] as string, [fileRel, at(match)]);
	}

	scanMarkupAttrs(
		text,
		fileRel,
		rootIndex,
		"js",
		"id attribute in JS string",
		"class attribute in JS string",
		lineOffset,
	);
}

const SCRIPT_SUFFIXES = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
const INDEXED_SUFFIXES = new Set([".css", ".html", ...SCRIPT_SUFFIXES]);

// "root\0name\0base" -> (signature, index); see the module docstring.
const rootCache = new Map<string, { signature: string; index: RootIndex }>();

export function relevantFiles(root: string): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (EXCLUDED_DIR_NAMES.has(entry.name)) {
				continue;
			}
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (INDEXED_SUFFIXES.has(path.extname(entry.name).toLowerCase())) {
				if (entry.isFile() || (entry.isSymbolicLink() && isFileFollowingLink(full))) {
					files.push(full);
				}
			}
		}
	};
	walk(root);
	return files.sort(comparePaths);
}

function isFileFollowingLink(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function signatureOf(files: string[]): string {
	const entries: string[] = [];
	for (const file of files) {
		try {
			const st = fs.statSync(file, { bigint: true });
			entries.push(`${file}:${st.mtimeNs}:${st.size}`);
		} catch {}
	}
	return entries.join("\n");
}

/**
 * Scan `root` for CSS/HTML/JS/TS files. Recorded `file` paths are relative to
 * `workspaceRoot` (defaulting to `root` itself) so multi-root setups report
 * paths consistently with every other tool.
 */
export function buildRootIndex(root: string, name: string, workspaceRoot?: string): RootIndex {
	const base = workspaceRoot ?? root;
	const files = fs.existsSync(root) && fs.statSync(root).isDirectory() ? relevantFiles(root) : [];
	const signature = signatureOf(files);
	const cacheKey = `${root}\0${name}\0${base}`;
	const cached = rootCache.get(cacheKey);
	if (cached && cached.signature === signature) {
		return cached.index;
	}
	const rootIndex = new RootIndex(name, root, base);
	for (const file of files) {
		const fileRel = toPosix(path.relative(base, file));
		let text: string;
		try {
			text = readTextStrict(file);
		} catch {
			continue; // unreadable or non-UTF-8: skip the file rather than fail every index call
		}
		const suffix = path.extname(file).toLowerCase();
		if (suffix === ".css") {
			scanCssText(text, fileRel, rootIndex);
		} else if (suffix === ".html") {
			scanHtmlText(text, fileRel, rootIndex);
		} else if (SCRIPT_SUFFIXES.has(suffix)) {
			scanJsText(text, fileRel, rootIndex);
		}
	}
	rootCache.set(cacheKey, { signature, index: rootIndex });
	return rootIndex;
}

/** One `RootIndex` per configured root; with no `roots`, the whole workspace is a single root labelled `DEFAULT_ROOT_LABEL`. */
export function buildWorkspaceIndex(workspaceRoot: string, roots?: [string, string][]): RootIndex[] {
	const list = roots ?? [[DEFAULT_ROOT_LABEL, workspaceRoot] as [string, string]];
	return list.map(([label, root]) => buildRootIndex(root, label, workspaceRoot));
}

/** Parse `WEBNAV_MCP_ROOTS` (`label=relative/path,label2=relative/path2`) into `[label, absolutePath]` pairs. */
export function parseRootsEnv(raw: string, workspaceRoot: string): [string, string][] {
	const roots: [string, string][] = [];
	for (const rawPart of raw.split(",")) {
		const part = rawPart.trim();
		if (!part) {
			continue;
		}
		const eq = part.indexOf("=");
		if (eq < 0) {
			throw new Error(`invalid WEBNAV_MCP_ROOTS entry ${pyRepr(part)}; expected label=relative/path`);
		}
		roots.push([part.slice(0, eq).trim(), resolveReal(path.resolve(workspaceRoot, part.slice(eq + 1).trim()))]);
	}
	return roots;
}

function normalizeVarName(name: string): string {
	const trimmed = name.trim();
	return trimmed.startsWith("--") ? trimmed : `--${trimmed}`;
}

/** `'id'`/`'class'` for a `#foo`/`.foo` token, else `undefined`. */
export function tokenKind(token: string): "id" | "class" | undefined {
	if (token.startsWith("#")) {
		return "id";
	}
	if (token.startsWith(".")) {
		return "class";
	}
	return undefined;
}

// -- formatting --------------------------------------------------------------

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function groupUsagesByFile(usages: VarUsage[]): [string, number[]][] {
	const groups = new Map<string, Set<number>>();
	for (const u of usages) {
		const set = groups.get(u.file) ?? new Set<number>();
		set.add(u.line);
		groups.set(u.file, set);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => cmp(a, b))
		.map(([file, lines]) => [file, [...lines].sort((x, y) => x - y)]);
}

function isGenerated(fileRel: string, generated: readonly string[]): boolean {
	return generated.some((g) => fileRel === g || fileRel.startsWith(`${g.replace(/\/+$/, "")}/`));
}

/**
 * Tag generated output (`WEBNAV_MCP_EXCLUDE`, e.g. `tsc`-emitted JS) so an
 * agent edits the source instead: those hits stay in the index because a
 * root's runtime usages may only exist there, but they are never the file to change.
 */
function fileLabel(fileRel: string, generated: readonly string[]): string {
	return isGenerated(fileRel, generated) ? `${fileRel} [generated]` : fileRel;
}

function groupHitsByFile(hits: SelectorHit[]): [string, SelectorHit[]][] {
	const groups = new Map<string, SelectorHit[]>();
	for (const h of hits) {
		pushTo(groups, h.file, h);
	}
	return [...groups.entries()].sort(([a], [b]) => cmp(a, b));
}

function rootNames(indexes: RootIndex[]): string {
	const names = indexes.map((idx) => idx.name);
	return names.length > 0 ? names.join(" or ") : "any configured root";
}

export interface FormatOptions {
	generated?: readonly string[];
	definitionsOnly?: boolean;
}

export function formatCssVar(indexes: RootIndex[], name: string, options: FormatOptions = {}): string {
	const { generated = [], definitionsOnly = false } = options;
	const varName = normalizeVarName(name);
	const sections: string[] = [];
	for (const idx of indexes) {
		const decls = idx.varDeclarations.get(varName) ?? [];
		const uses = definitionsOnly ? [] : (idx.varUsages.get(varName) ?? []);
		if (decls.length === 0 && uses.length === 0) {
			continue;
		}
		const lines = [`== ${idx.name} ==`];
		if (decls.length > 0) {
			lines.push("Definitions:");
			lines.push(...decls.map((d) => `  ${d.file}:${d.line}  (${d.context || "(top level)"})  = ${d.value}`));
		} else {
			lines.push("Definitions: (none)");
		}
		if (uses.length > 0) {
			const byFile = groupUsagesByFile(uses);
			lines.push(`Usages (${uses.length} in ${byFile.length} file(s)):`);
			lines.push(...byFile.map(([f, ns]) => `  ${fileLabel(f, generated)}: ${ns.map((n) => `L${n}`).join(", ")}`));
		} else if (!definitionsOnly) {
			lines.push("Usages: (none)");
		}
		sections.push(lines.join("\n"));
	}
	if (sections.length === 0) {
		return `${varName} is not defined or used anywhere under ${rootNames(indexes)}.`;
	}
	return `${varName}\n\n${sections.join("\n\n")}`;
}

/**
 * Dynamic hits stored under a *different*, shorter key that `token` could
 * resolve to at runtime: a `getElementById("view-" + x)` hit stored under
 * `#view-` is a plausible match for a query of `#view-components`.
 */
function dynamicPrefixHits(idx: RootIndex, token: string): SelectorHit[] {
	const hits: SelectorHit[] = [];
	for (const [key, keyHits] of idx.selectorHits) {
		if (key === token || !token.startsWith(key)) {
			continue;
		}
		hits.push(...keyHits.filter((h) => h.dynamic));
	}
	return hits;
}

/**
 * JS/TS string literals exactly equal to `token`'s bare name, on lines no
 * recognised DOM-API hit already covers: typically an id/class passed to a
 * project's own helper (`onClick("btn-save", …)`).
 */
function stringLiteralHits(idx: RootIndex, token: string): SelectorHit[] {
	const covered = new Set<string>();
	for (const hits of idx.selectorHits.values()) {
		for (const h of hits) {
			if (h.kind === "js") {
				covered.add(`${h.file}\0${h.line}`);
			}
		}
	}
	return (idx.stringLiterals.get(token.slice(1)) ?? [])
		.filter(([file, line]) => !covered.has(`${file}\0${line}`))
		.map(([file, line]) => ({ token, kind: "js" as const, file, line, detail: "string literal", dynamic: false }));
}

const hitKey = (h: SelectorHit): string => JSON.stringify([h.token, h.kind, h.file, h.line, h.detail, h.dynamic]);

function dedupe(hits: SelectorHit[]): SelectorHit[] {
	const seen = new Map<string, SelectorHit>();
	for (const h of hits) {
		seen.set(hitKey(h), seen.get(hitKey(h)) ?? h);
	}
	return [...seen.values()];
}

export function formatSelector(indexes: RootIndex[], token: string, options: FormatOptions = {}): string {
	const { generated = [], definitionsOnly = false } = options;
	if (tokenKind(token) === undefined) {
		return `${pyRepr(token)} must start with '#' (id) or '.' (class).`;
	}
	const sections: string[] = [];
	for (const idx of indexes) {
		const exactHits = idx.selectorHits.get(token) ?? [];
		let allHits = [...exactHits, ...dynamicPrefixHits(idx, token), ...stringLiteralHits(idx, token)];
		if (definitionsOnly) {
			// A class is defined by its CSS rule(s), an id by its markup attribute.
			const wanted = token.startsWith(".") ? "css" : "html";
			const preferred = exactHits.filter((h) => h.kind === wanted);
			allHits = preferred.length > 0 ? preferred : exactHits.filter((h) => h.kind === "css");
		}
		if (allHits.length === 0) {
			continue;
		}
		const lines = [`== ${idx.name} ==`];
		for (const kindLabel of ["html", "css", "js"] as const) {
			// Dedupes identical hits, e.g. `.a.x, .a .y {` records `.a` twice for one rule line.
			const kindHits = dedupe(allHits.filter((h) => h.kind === kindLabel));
			if (kindHits.length === 0) {
				continue;
			}
			lines.push(`${kindLabel.toUpperCase()} (${kindHits.length}):`);
			for (const [file, fileHits] of groupHitsByFile(kindHits)) {
				const parts = [...fileHits]
					.sort((a, b) => a.line - b.line)
					.map((h) => {
						let detail: string;
						if (h.dynamic && h.token !== token) {
							const via = `dynamic partial match via ${pyRepr(h.token)}`;
							detail = h.detail ? `${h.detail}, ${via}` : via;
						} else if (h.dynamic) {
							detail = h.detail ? `${h.detail}, dynamic partial match` : "dynamic partial match";
						} else {
							detail = h.detail;
						}
						return detail ? `L${h.line} (${detail})` : `L${h.line}`;
					});
				lines.push(`  ${fileLabel(file, generated)}: ${parts.join(", ")}`);
			}
		}
		sections.push(lines.join("\n"));
	}
	if (sections.length === 0) {
		return `${token} was not found under ${rootNames(indexes)}.`;
	}
	return `${token}\n\n${sections.join("\n\n")}`;
}

// -- reference/definition/diagnostics enrichment ------------------------------

const CSS_TOKEN_UNDER_CURSOR_RE = /(--[a-zA-Z0-9_-]+|[.#][a-zA-Z_-][a-zA-Z0-9_-]*)/g;

/** `#name`/`.name` for a cursor on a word inside an HTML `id="..."`/`class="..."` value, where the markup spells the selector without its `#`/`.`. */
function attrTokenAt(lineText: string, idx: number): string | undefined {
	for (const [regex, prefix] of [
		[ID_ATTR_RE, "#"],
		[CLASS_ATTR_RE, "."],
	] as const) {
		for (const attr of finditer(regex, lineText)) {
			const [valueStart, valueEnd] = attr.indices[2] as [number, number];
			if (!(valueStart <= idx && idx < valueEnd)) {
				continue;
			}
			for (const word of finditer(/\S+/g, attr[2] as string)) {
				if (valueStart + word.index <= idx && idx < valueStart + word.index + word[0].length) {
					return prefix + word[0];
				}
			}
			return undefined;
		}
	}
	return undefined;
}

/** The `--var`, `#id` or `.class` token containing a 1-indexed `column`, including a bare name inside an HTML `id`/`class` attribute value. */
export function tokenAtPosition(lineText: string, column: number): string | undefined {
	const idx = column - 1;
	const attrToken = attrTokenAt(lineText, idx);
	if (attrToken !== undefined) {
		return attrToken;
	}
	for (const match of finditer(CSS_TOKEN_UNDER_CURSOR_RE, lineText)) {
		if (match.index <= idx && idx < match.index + match[0].length) {
			return match[1];
		}
	}
	return undefined;
}

/** The index whose root contains `filePath`, plus the path exactly as that index recorded it (relative to `idx.base`). */
export function rootIndexForFile(indexes: RootIndex[], filePath: string): [RootIndex, string] | undefined {
	const resolved = resolveReal(filePath);
	for (const idx of indexes) {
		if (relativeWithin(resolved, resolveReal(idx.root)) === undefined) {
			continue;
		}
		const rel = relativeWithin(resolved, resolveReal(idx.base));
		if (rel === undefined) {
			continue;
		}
		return [idx, toPosix(rel)];
	}
	return undefined;
}

/** True when any root's index has hits for `token` (`#id`/`.class`) or, for a bare-name string literal, its name. */
export function knowsSelector(indexes: RootIndex[], token: string): boolean {
	return indexes.some((idx) => idx.selectorHits.has(token) || idx.stringLiterals.has(token.slice(1)));
}

export function undefinedVarUsages(idx: RootIndex): VarUsage[] {
	const result: VarUsage[] = [];
	for (const [name, usages] of idx.varUsages) {
		if (idx.varDeclarations.has(name)) {
			continue;
		}
		result.push(...usages.filter((usage) => !usage.hasFallback));
	}
	return result;
}

/**
 * Declared custom properties never read by any `var()` in the root. A JS/TS
 * string literal equal to the name (e.g. `getPropertyValue("--x")`) counts as a use.
 */
export function unusedVarDeclarations(idx: RootIndex): VarDeclaration[] {
	const result: VarDeclaration[] = [];
	for (const [name, decls] of idx.varDeclarations) {
		if (!idx.varUsages.has(name) && !idx.stringLiterals.has(name)) {
			result.push(...decls);
		}
	}
	return result;
}

/**
 * CSS-defined tokens with no HTML/JS reference. A dynamically-built JS hit
 * elsewhere in the root counts as a reference for any token it's a prefix of;
 * so does a JS/TS string literal equal to the bare name.
 */
export function unreferencedSelectors(idx: RootIndex): string[] {
	const unreferenced: string[] = [];
	for (const [token, hits] of idx.selectorHits) {
		const hasDefinition = hits.some((h) => h.kind === "css");
		const hasReference =
			hits.some((h) => (h.kind === "html" || h.kind === "js") && !h.dynamic) || idx.stringLiterals.has(token.slice(1));
		if (hasDefinition && !hasReference && dynamicPrefixHits(idx, token).length === 0) {
			unreferenced.push(token);
		}
	}
	return unreferenced.sort(cmp);
}

/** Index-derived warning lines for one file: undefined `var(--x)` usages (no fallback), unused `--x` declarations and CSS selectors with no HTML/JS reference in this root. */
export function diagnosticsForFile(idx: RootIndex, fileRel: string, publicPaths: readonly string[] = []): string[] {
	const warnings: string[] = [];
	for (const usage of undefinedVarUsages(idx)) {
		if (usage.file === fileRel) {
			warnings.push(`${usage.line}:1 [warning] var(${usage.name}) is never defined in ${idx.name}`);
		}
	}
	// `WEBNAV_MCP_PUBLIC` files are an API for other projects: nothing in them is "unused".
	if (isGenerated(fileRel, publicPaths)) {
		return sortWarnings(warnings);
	}
	for (const decl of unusedVarDeclarations(idx)) {
		if (decl.file === fileRel) {
			warnings.push(`${decl.line}:1 [warning] ${decl.name} is declared but never used in ${idx.name}`);
		}
	}
	for (const token of new Set(unreferencedSelectors(idx))) {
		for (const hit of idx.selectorHits.get(token) ?? []) {
			if (hit.kind === "css" && hit.file === fileRel) {
				warnings.push(`${hit.line}:1 [warning] ${token} is never referenced in ${idx.name}'s HTML/JS`);
			}
		}
	}
	return sortWarnings(warnings);
}

function sortWarnings(warnings: string[]): string[] {
	return warnings.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}
