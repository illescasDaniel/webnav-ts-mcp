/**
 * Finding a named JS/TS declaration and the full text it occupies.
 *
 * The language server's symbol ranges are tight: they leave out leading
 * doc comments and (for `const x = ...`) the keyword, and `const a = 1, b = 2`
 * is two symbols. `extentOf` widens a range to what an agent means by "the
 * function": decorators, doc comment, `export const`, trailing `;`.
 */

import { ToolInputError } from "../shared/errors.js";
import { uriToPath, uriToRelative } from "../shared/format.js";
import type { LspSymbol } from "../shared/lspTypes.js";
import { canonicalPath } from "../shared/paths.js";
import { resolveSymbol } from "../shared/resolve.js";
import type { ToolHost } from "./common.js";
import { lineStarts, positionToOffset, readSource } from "./edits.js";

export const SymbolKinds = {
	Namespace: 3,
	Class: 5,
	Method: 6,
	Property: 7,
	Field: 8,
	Constructor: 9,
	Enum: 10,
	Interface: 11,
	Function: 12,
	Variable: 13,
	Constant: 14,
	EnumMember: 22,
} as const;

const KIND_LABELS: Record<number, string> = {
	2: "module",
	3: "namespace",
	5: "class",
	6: "method",
	7: "property",
	8: "field",
	9: "constructor",
	10: "enum",
	11: "interface",
	12: "function",
	13: "variable",
	14: "constant",
	22: "enum member",
};

export const kindLabel = (kind: number | undefined): string => KIND_LABELS[kind ?? 0] ?? "symbol";

export interface Located {
	file: string;
	rel: string;
	text: string;
	bom: boolean;
	node: LspSymbol;
	parent: LspSymbol | undefined;
	/** 0-based position of the identifier. */
	line: number;
	column: number;
	/** The dotted name as the user wrote it. */
	name: string;
}

function walk(
	nodes: LspSymbol[],
	visit: (node: LspSymbol, parent: LspSymbol | undefined) => boolean,
	parent?: LspSymbol,
): boolean {
	for (const node of nodes) {
		if (visit(node, parent) || walk(node.children ?? [], visit, node)) {
			return true;
		}
	}
	return false;
}

export function findNodeAt(
	symbols: LspSymbol[],
	line: number,
	column: number,
): { node: LspSymbol; parent: LspSymbol | undefined } | undefined {
	let found: { node: LspSymbol; parent: LspSymbol | undefined } | undefined;
	walk(symbols, (node, parent) => {
		const start = node.selectionRange?.start;
		if (start?.line === line && start?.character === column) {
			found = { node, parent };
			return true;
		}
		return false;
	});
	return found;
}

export async function locateSymbol(host: ToolHost, name: string, filePath?: string): Promise<Located> {
	const client = await host.scriptClient();
	const resolved = await resolveSymbol(client, host.workspaceRoot, name, filePath);
	const file = canonicalPath(uriToPath(resolved.uri));
	const rel = uriToRelative(resolved.uri, host.workspaceRoot);
	const { text, bom } = readSource(file);
	const symbols = await client.documentSymbol(rel);
	const hit = findNodeAt(symbols, resolved.line, resolved.column);
	if (!hit) {
		throw new ToolInputError(
			`${name} was found at ${rel}:${resolved.line + 1}:${resolved.column + 1}, but its declaration range is not available from the language server; use \`edit\` instead.`,
		);
	}
	return {
		file,
		rel,
		text,
		bom,
		node: hit.node,
		parent: hit.parent,
		line: resolved.line,
		column: resolved.column,
		name,
	};
}

export interface Extent {
	/** Start of the declaration proper (decorators included). */
	start: number;
	/** Start of the leading doc comment block (== `start` when there is none). */
	docStart: number;
	/** End of the declaration (a trailing `;` included). */
	end: number;
	/** Whitespace in front of the first line. */
	indent: string;
}

const lineIndent = (text: string, offset: number): string => {
	const lineStart = Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;
	return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? "";
};

const lineStartOf = (text: string, offset: number): number =>
	Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;

/** Offset where the line before the one containing `offset` starts, or undefined at the top of the file. */
function previousLineStart(text: string, offset: number): number | undefined {
	const here = lineStartOf(text, offset);
	if (here === 0) {
		return undefined;
	}
	return lineStartOf(text, here - 1 - (text[here - 2] === "\r" && text[here - 1] === "\n" ? 1 : 0));
}

const lineText = (text: string, start: number): string => {
	let end = start;
	while (end < text.length && text[end] !== "\n" && text[end] !== "\r") {
		end++;
	}
	return text.slice(start, end);
};

export function extentOf(text: string, node: LspSymbol, label: string): Extent {
	const range = node.range;
	if (!range?.start || !range.end) {
		throw new ToolInputError(`${label} has no range from the language server.`);
	}
	const starts = lineStarts(text);
	let start = positionToOffset(text, range.start.line ?? 0, range.start.character ?? 0, starts);
	let end = positionToOffset(text, range.end.line ?? 0, range.end.character ?? 0, starts);
	if (node.kind === SymbolKinds.Variable || node.kind === SymbolKinds.Constant) {
		const ls = lineStartOf(text, start);
		const prefix = text.slice(ls, start);
		if (!/^[ \t]*(?:(?:export|declare)\s+)*(?:const|let|var)\s+$/.test(prefix) || /^\s*,/.test(text.slice(end))) {
			throw new ToolInputError(
				`${label} shares its declaration with other variables (or is not a plain declaration); change it with \`edit\` instead.`,
			);
		}
		start = ls + (/^[ \t]*/.exec(prefix)?.[0].length ?? 0);
		const semi = /^[ \t]*;/.exec(text.slice(end));
		if (semi) {
			end += semi[0].length;
		}
	}
	const indent = lineIndent(text, start);
	// Decorators on their own lines above the declaration.
	for (
		let prev = previousLineStart(text, start);
		prev !== undefined && lineStartOf(text, start) === start - indent.length;
	) {
		const t = lineText(text, prev).trim();
		if (!t.startsWith("@")) {
			break;
		}
		start = prev + (/^[ \t]*/.exec(lineText(text, prev))?.[0].length ?? 0);
		prev = previousLineStart(text, start);
	}
	// Doc comment: contiguous `//` lines or a `/* ... */` block directly above.
	let docStart = start;
	for (
		let prev = previousLineStart(text, docStart);
		prev !== undefined && lineStartOf(text, docStart) === docStart - indent.length;
	) {
		const t = lineText(text, prev).trim();
		if (t.startsWith("//")) {
			docStart = prev + (/^[ \t]*/.exec(lineText(text, prev))?.[0].length ?? 0);
		} else if (t.endsWith("*/")) {
			let top = prev;
			while (!lineText(text, top).includes("/*")) {
				const before = previousLineStart(text, top);
				if (before === undefined) {
					break;
				}
				top = before;
			}
			docStart = top + (/^[ \t]*/.exec(lineText(text, top))?.[0].length ?? 0);
		} else {
			break;
		}
		prev = previousLineStart(text, docStart);
	}
	return { start, docStart, end, indent };
}

/** The unit one indentation level uses in `text`: a tab, or the common smallest space indent. */
export function detectIndentUnit(text: string): string {
	let tabs = 0;
	const widths = new Map<number, number>();
	for (const line of text.split(/\r?\n/)) {
		if (line.startsWith("\t")) {
			tabs++;
		} else {
			const n = /^ +/.exec(line)?.[0].length ?? 0;
			if (n > 0 && /\S/.test(line)) {
				widths.set(n, (widths.get(n) ?? 0) + 1);
			}
		}
	}
	const spaces = [...widths.values()].reduce((a, b) => a + b, 0);
	if (tabs > spaces) {
		return "\t";
	}
	if (spaces === 0) {
		return "  ";
	}
	const smallest = Math.min(...widths.keys());
	return " ".repeat(smallest >= 2 ? smallest : 2);
}

/** `source` normalised to `\n`, dedented, converted to the file's indent unit and indented by `indent`; no surrounding blank lines. */
export function fitSnippet(source: string, indent: string, fileUnit: string): string {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	while (lines.length > 0 && lines[0]?.trim() === "") {
		lines.shift();
	}
	while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
		lines.pop();
	}
	const widthOf = (line: string): number => (/^[ \t]*/.exec(line)?.[0] ?? "").length;
	const nonBlank = lines.filter((l) => l.trim() !== "");
	// The first line often arrives unindented while the rest keep their original nesting: measure the others.
	const rest = nonBlank.slice(1);
	const base =
		rest.length === 0 ? widthOf(nonBlank[0] ?? "") : Math.min(widthOf(nonBlank[0] ?? ""), ...rest.map(widthOf));
	const dedented = lines.map((l) => (l.trim() === "" ? "" : l.slice(Math.min(base, widthOf(l)))));
	const snippetUnit = detectIndentUnit(dedented.join("\n"));
	const convert = snippetUnit !== fileUnit && dedented.some((l) => /^[ \t]/.test(l));
	return dedented
		.map((line) => {
			if (line === "") {
				return "";
			}
			let body = line;
			if (convert) {
				const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
				const levels = lead.includes("\t") ? lead.length : Math.round(lead.length / snippetUnit.length);
				body = fileUnit.repeat(levels) + line.slice(lead.length);
			}
			return indent + body;
		})
		.join("\n");
}

/** The declared name in a snippet (`function f`, `class C`, `const x`, a method name), or undefined. */
export function declaredName(source: string): string | undefined {
	const stripped = source.replace(/^(?:\s*(?:\/\/.*|\/\*[\s\S]*?\*\/|@[\w$.]+(?:\([^)]*\))?)\s*)*/, "");
	const keyword =
		/^(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|enum|namespace|module|type|const\s+enum|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(
			stripped,
		);
	if (keyword) {
		return keyword[1];
	}
	const member =
		/^(?:(?:public|private|protected|static|async|readonly|abstract|override|declare|get|set|accessor)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*|\[[^\]]+\])\s*[(<:=?!;]/.exec(
			stripped,
		);
	return member?.[1];
}

export const startsWithComment = (source: string): boolean => /^\s*(?:\/\/|\/\*)/.test(source);
