/**
 * Reading and rewriting ES import / re-export statements at the top level of a
 * script file. Regex-grade on purpose: it understands `import x, { a as b, type c }
 * from "m"`, `import * as ns from "m"`, `import "m"`, `import type ...` and
 * `export { a } from "m"` / `export * from "m"`, with any quote, spacing and
 * `;` style, and leaves everything else alone.
 */

import { joinAfterRemoval } from "./edits.js";

export interface NamedBinding {
	/** Exported name in the other module. */
	name: string;
	/** Local name (equals `name` unless `as` is used). */
	local: string;
	typeOnly: boolean;
}

export interface ImportStatement {
	kind: "import" | "export";
	/** Offset of `import`/`export`. */
	start: number;
	/** Offset just after the statement (its `;` included, line break not). */
	end: number;
	typeOnly: boolean;
	defaultName?: string | undefined;
	namespaceName?: string | undefined;
	/** `export * from` without `as`. */
	starExport: boolean;
	named: NamedBinding[];
	hasBraces: boolean;
	specifier: string;
	quote: string;
	semicolon: boolean;
	multiline: boolean;
	spacedBraces: boolean;
	trailingComma: boolean;
	/** Attributes (`with { type: "json" }`) kept verbatim. */
	attributes: string;
}

const IMPORT_RE =
	/^import\b\s*(type\s+)?(?:([\w$]+)\s*(?:,\s*)?)?(?:\*\s*as\s+([\w$]+)|(\{[^}]*\}))?\s*(?:from\s*)?(["'])([^"'\n]+)\5(\s*(?:with|assert)\s*\{[^}]*\})?[ \t]*(;?)/gm;
const EXPORT_RE =
	/^export\b\s*(type\s+)?(?:(\*)(?:\s*as\s+([\w$]+))?|(\{[^}]*\}))\s*from\s*(["'])([^"'\n]+)\5(\s*(?:with|assert)\s*\{[^}]*\})?[ \t]*(;?)/gm;

function parseNamed(braces: string): { named: NamedBinding[]; trailingComma: boolean } {
	const inner = braces.slice(1, -1);
	const parts = inner.split(",").map((p) => p.trim());
	const trailingComma = parts.length > 0 && parts[parts.length - 1] === "" && parts.length > 1;
	const named: NamedBinding[] = [];
	for (const part of parts) {
		if (!part) {
			continue;
		}
		const match = /^(type\s+)?([\w$"'-]+?)(?:\s+as\s+([\w$]+))?$/.exec(part);
		if (match) {
			named.push({ name: match[2] as string, local: (match[3] ?? match[2]) as string, typeOnly: Boolean(match[1]) });
		}
	}
	return { named, trailingComma };
}

/** Offsets of lines starting in a block comment, so a commented-out `import` is not parsed. */
function commentMask(text: string): boolean[] {
	const mask = new Array<boolean>(text.length).fill(false);
	let i = 0;
	let quote = "";
	while (i < text.length) {
		const ch = text[i] as string;
		if (quote) {
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === quote || (ch === "\n" && quote !== "`")) {
				quote = "";
			}
			i++;
		} else if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			i++;
		} else if (ch === "/" && text[i + 1] === "/") {
			const end = text.indexOf("\n", i);
			const stop = end < 0 ? text.length : end;
			mask.fill(true, i, stop);
			i = stop;
		} else if (ch === "/" && text[i + 1] === "*") {
			const close = text.indexOf("*/", i + 2);
			const stop = close < 0 ? text.length : close + 2;
			mask.fill(true, i, stop);
			i = stop;
		} else {
			i++;
		}
	}
	return mask;
}

export function parseImports(text: string): ImportStatement[] {
	const masked = commentMask(text);
	const found: ImportStatement[] = [];
	for (const match of text.matchAll(IMPORT_RE)) {
		const start = match.index as number;
		if (masked[start]) {
			continue;
		}
		const braces = match[4];
		const parsed = braces ? parseNamed(braces) : { named: [], trailingComma: false };
		found.push({
			kind: "import",
			start,
			end: start + match[0].length,
			typeOnly: Boolean(match[1]),
			defaultName: match[2],
			namespaceName: match[3],
			starExport: false,
			named: parsed.named,
			hasBraces: Boolean(braces),
			specifier: match[6] as string,
			quote: match[5] as string,
			semicolon: match[8] === ";",
			multiline: Boolean(braces?.includes("\n")),
			spacedBraces: Boolean(braces && /^\{\s/.test(braces)),
			trailingComma: parsed.trailingComma,
			attributes: match[7]?.trim() ?? "",
		});
	}
	for (const match of text.matchAll(EXPORT_RE)) {
		const start = match.index as number;
		if (masked[start]) {
			continue;
		}
		const braces = match[4];
		const parsed = braces ? parseNamed(braces) : { named: [], trailingComma: false };
		found.push({
			kind: "export",
			start,
			end: start + match[0].length,
			typeOnly: Boolean(match[1]),
			namespaceName: match[3],
			starExport: Boolean(match[2]) && !match[3],
			named: parsed.named,
			hasBraces: Boolean(braces),
			specifier: match[6] as string,
			quote: match[5] as string,
			semicolon: match[8] === ";",
			multiline: Boolean(braces?.includes("\n")),
			spacedBraces: Boolean(braces && /^\{\s/.test(braces)),
			trailingComma: parsed.trailingComma,
			attributes: match[7]?.trim() ?? "",
		});
	}
	return found.sort((a, b) => a.start - b.start);
}

export interface ImportStyle {
	quote: string;
	semicolon: boolean;
	spacedBraces: boolean;
}

/** The quote / semicolon / brace-spacing convention of the file's existing imports (or common defaults). */
export function detectImportStyle(statements: readonly ImportStatement[]): ImportStyle {
	const first = statements[0];
	return { quote: first?.quote ?? '"', semicolon: first?.semicolon ?? true, spacedBraces: first?.spacedBraces ?? true };
}

const bindingText = (b: NamedBinding): string =>
	`${b.typeOnly ? "type " : ""}${b.name}${b.local !== b.name ? ` as ${b.local}` : ""}`;

export function renderImport(
	stmt: Pick<
		ImportStatement,
		| "kind"
		| "typeOnly"
		| "defaultName"
		| "namespaceName"
		| "starExport"
		| "named"
		| "hasBraces"
		| "specifier"
		| "attributes"
	>,
	style: ImportStyle & { multiline?: boolean; trailingComma?: boolean; indent?: string },
): string {
	const q = style.quote;
	const attrs = stmt.attributes ? ` ${stmt.attributes}` : "";
	const end = style.semicolon ? ";" : "";
	const typeKw = stmt.typeOnly ? "type " : "";
	if (stmt.kind === "export") {
		const what = stmt.starExport ? "*" : stmt.namespaceName ? `* as ${stmt.namespaceName}` : braces(stmt.named, style);
		return `export ${typeKw}${what} from ${q}${stmt.specifier}${q}${attrs}${end}`;
	}
	const clauses: string[] = [];
	if (stmt.defaultName) {
		clauses.push(stmt.defaultName);
	}
	if (stmt.namespaceName) {
		clauses.push(`* as ${stmt.namespaceName}`);
	} else if (stmt.named.length > 0) {
		clauses.push(braces(stmt.named, style));
	}
	if (clauses.length === 0) {
		return `import ${q}${stmt.specifier}${q}${attrs}${end}`;
	}
	return `import ${typeKw}${clauses.join(", ")} from ${q}${stmt.specifier}${q}${attrs}${end}`;
}

function braces(
	named: readonly NamedBinding[],
	style: ImportStyle & { multiline?: boolean; trailingComma?: boolean; indent?: string },
): string {
	const items = named.map(bindingText);
	if (style.multiline) {
		const indent = style.indent ?? "\t";
		return `{\n${items.map((item) => `${indent}${item}`).join(",\n")}${style.trailingComma ? "," : ""}\n}`;
	}
	return style.spacedBraces ? `{ ${items.join(", ")} }` : `{${items.join(", ")}}`;
}

/** Offset where a new import belongs when the file has none: after a shebang, header comments and `"use strict"`. */
function firstCodeOffset(text: string): number {
	let offset = 0;
	const lines = text.split("\n");
	let inBlock = false;
	for (const line of lines) {
		const trimmed = line.trim();
		if (inBlock) {
			if (trimmed.includes("*/")) {
				inBlock = false;
			}
		} else if (trimmed.startsWith("#!") || trimmed.startsWith("//") || /^["']use [\w ]+["'];?$/.test(trimmed)) {
			// header line
		} else if (trimmed.startsWith("/*")) {
			inBlock = !trimmed.includes("*/");
		} else if (trimmed === "") {
			// keep scanning blank lines inside the header
		} else {
			break;
		}
		offset += line.length + 1;
	}
	return Math.min(offset, text.length);
}

export interface NewImport {
	specifier: string;
	named?: NamedBinding[];
	defaultName?: string;
	namespaceName?: string;
	typeOnly?: boolean;
}

/** Add `wanted` to `text`: merged into a plain `import { ... } from` of the same module when there is one, else a new statement after the last import. */
export function addImport(text: string, wanted: NewImport): string {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const statements = parseImports(text);
	const style = detectImportStyle(statements.filter((s) => s.kind === "import"));
	const same = statements.find(
		(s) =>
			s.kind === "import" &&
			s.specifier === wanted.specifier &&
			s.typeOnly === Boolean(wanted.typeOnly) &&
			!s.namespaceName &&
			!wanted.namespaceName &&
			s.attributes === "" &&
			(s.hasBraces || s.defaultName || s.named.length === 0) &&
			(!wanted.defaultName || !s.defaultName || s.defaultName === wanted.defaultName),
	);
	if (same) {
		const named = [...same.named];
		for (const b of wanted.named ?? []) {
			if (!named.some((n) => n.local === b.local && n.name === b.name)) {
				named.push(b);
			}
		}
		const defaultName = same.defaultName ?? wanted.defaultName;
		if (named.length === same.named.length && defaultName === same.defaultName) {
			return text;
		}
		const rendered = renderImport(
			{ ...same, named, defaultName, hasBraces: named.length > 0 },
			{ ...style, multiline: same.multiline, trailingComma: same.trailingComma, indent: indentOfNamed(text, same) },
		);
		return text.slice(0, same.start) + rendered + text.slice(same.end);
	}
	const rendered = renderImport(
		{
			kind: "import",
			typeOnly: Boolean(wanted.typeOnly),
			defaultName: wanted.defaultName,
			namespaceName: wanted.namespaceName,
			starExport: false,
			named: wanted.named ?? [],
			hasBraces: (wanted.named?.length ?? 0) > 0,
			specifier: wanted.specifier,
			attributes: "",
		},
		style,
	);
	const imports = statements.filter((s) => s.kind === "import");
	const last = imports[imports.length - 1];
	if (last) {
		return `${text.slice(0, last.end)}${eol}${rendered}${text.slice(last.end)}`;
	}
	const at = firstCodeOffset(text);
	const rest = text.slice(at);
	return `${text.slice(0, at)}${rendered}${eol}${rest.trim() === "" ? "" : eol}${rest}`;
}

function indentOfNamed(text: string, stmt: ImportStatement): string {
	const body = text.slice(stmt.start, stmt.end);
	const match = /\{\s*\n([ \t]+)\S/.exec(body);
	return match ? (match[1] as string) : "\t";
}

/** Drop the binding with local name `local` from `stmt`; the whole statement goes when it was the last one. Returns the new text. */
export function removeBinding(text: string, stmt: ImportStatement, local: string): string {
	const named = stmt.named.filter((b) => b.local !== local);
	const defaultName = stmt.defaultName === local ? undefined : stmt.defaultName;
	const namespaceName = stmt.namespaceName === local ? undefined : stmt.namespaceName;
	if (named.length === stmt.named.length && defaultName === stmt.defaultName && namespaceName === stmt.namespaceName) {
		return text;
	}
	if (named.length === 0 && !defaultName && !namespaceName) {
		return removeStatement(text, stmt);
	}
	const style = { quote: stmt.quote, semicolon: stmt.semicolon, spacedBraces: stmt.spacedBraces };
	const rendered = renderImport(
		{ ...stmt, named, defaultName, namespaceName, hasBraces: named.length > 0 },
		{
			...style,
			multiline: stmt.multiline && named.length > 1,
			trailingComma: stmt.trailingComma,
			indent: indentOfNamed(text, stmt),
		},
	);
	return text.slice(0, stmt.start) + rendered + text.slice(stmt.end);
}

/** Remove a whole statement together with its line break. */
export function removeStatement(text: string, stmt: Pick<ImportStatement, "start" | "end">): string {
	let end = stmt.end;
	if (text.startsWith("\r\n", end)) {
		end += 2;
	} else if (text[end] === "\n") {
		end += 1;
	}
	return joinAfterRemoval(text.slice(0, stmt.start), text.slice(end));
}
