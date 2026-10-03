/**
 * Where a CSS custom property, `#id` or `.class` appears in a file, as exact
 * text ranges, so it can be renamed.
 *
 * Same recognisers as the cross-file index (`webIndex.ts`) but offset-exact
 * and conservative: it only names places that are certainly the token (CSS
 * selectors and `var()`, HTML `class`/`id` attributes and the attributes that
 * refer to ids, and the DOM APIs the index understands). A bare string
 * literal equal to the name is reported separately, because
 * `"active"` in a script is as likely a state name as a class.
 */

import path from "node:path";
import { escapeRegExp } from "../shared/text.js";
import type { TextEdit } from "./edits.js";

export type TokenKind = "var" | "id" | "class";

export interface WebToken {
	kind: TokenKind;
	/** The identifier without `--`, `#` or `.` prefix for selectors; with `--` for variables. */
	name: string;
}

export function parseToken(raw: string): WebToken | undefined {
	const t = raw.trim();
	if (t.startsWith("--") && t.length > 2) {
		return { kind: "var", name: t };
	}
	if (t.startsWith("#") && t.length > 1) {
		return { kind: "id", name: t.slice(1) };
	}
	if (t.startsWith(".") && t.length > 1) {
		return { kind: "class", name: t.slice(1) };
	}
	return undefined;
}

export const tokenText = (t: WebToken): string =>
	t.kind === "var" ? t.name : `${t.kind === "id" ? "#" : "."}${t.name}`;

export interface TokenFindings {
	edits: TextEdit[];
	/** Places the name is built dynamically (`"row-" + id`, `` `.item-${n}` ``): not renamed. */
	dynamic: { offset: number; text: string }[];
	/** Bare string literals exactly equal to the name (candidates, renamed only on request). */
	literals: TextEdit[];
}

const blank = (s: string): string => s.replace(/[^\n\r]/g, " ");

function maskCss(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, blank);
}

function maskHtml(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, blank);
}

const wordRe = (name: string, flags = "g"): RegExp => new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`, flags);

function emptyFindings(): TokenFindings {
	return { edits: [], dynamic: [], literals: [] };
}

function replaceAt(findings: TokenFindings, base: number, start: number, length: number, newText: string): void {
	findings.edits.push({ start: base + start, end: base + start + length, newText });
}

// -- CSS ---------------------------------------------------------------------

function cssFindings(text: string, token: WebToken, newName: string, base: number, out: TokenFindings): void {
	const masked = maskCss(text);
	if (token.kind === "var") {
		for (const m of masked.matchAll(wordRe(token.name))) {
			replaceAt(out, base, m.index as number, token.name.length, newName);
		}
		return;
	}
	const prefix = token.kind === "id" ? "#" : ".";
	const re = new RegExp(`${escapeRegExp(prefix)}${escapeRegExp(token.name)}(?![\\w-])`, "g");
	let preludeStart = 0;
	for (let i = 0; i < masked.length; i++) {
		const ch = masked[i];
		if (ch === "{") {
			const prelude = masked.slice(preludeStart, i);
			if (!prelude.trimStart().startsWith("@")) {
				// Attribute selectors and strings can contain `.name` text that is not a selector.
				const clean = prelude.replace(/\[[^\]]*\]/g, blank).replace(/"[^"\n]*"|'[^'\n]*'/g, blank);
				for (const m of clean.matchAll(re)) {
					const at = m.index as number;
					if (clean[at - 1] === "\\") {
						continue;
					}
					replaceAt(out, base, preludeStart + at + 1, token.name.length, newName);
				}
			}
			preludeStart = i + 1;
		} else if (ch === "}" || ch === ";") {
			preludeStart = i + 1;
		}
	}
}

// -- JS ----------------------------------------------------------------------

interface Literal {
	/** Content range (quotes excluded). */
	start: number;
	end: number;
	/** A template literal segment that stops at `${`. */
	dynamicAfter: boolean;
	/** A string followed by `+`. */
	concatFollows: boolean;
}

/** String literals of a script (template segments split at `${}`), with comments blanked out of `masked`. */
function scanJs(text: string): { masked: string; literals: Literal[] } {
	const chars = [...text];
	const literals: Literal[] = [];
	const n = text.length;
	const stack: ("code" | "template")[] = ["code"];
	const depths: number[] = [0];
	let i = 0;
	let segmentStart = 0;
	const blankRange = (from: number, to: number): void => {
		for (let k = from; k < to; k++) {
			if (chars[k] !== "\n" && chars[k] !== "\r") {
				chars[k] = " ";
			}
		}
	};
	const concat = (at: number): boolean => /^\s*\+/.test(text.slice(at, at + 16));
	while (i < n) {
		const mode = stack[stack.length - 1];
		if (mode === "template") {
			let j = i;
			while (j < n && text[j] !== "`" && !(text[j] === "$" && text[j + 1] === "{")) {
				j += text[j] === "\\" ? 2 : 1;
			}
			if (text[j] === "`") {
				literals.push({ start: segmentStart, end: Math.min(j, n), dynamicAfter: false, concatFollows: concat(j + 1) });
				stack.pop();
				depths.pop();
				i = j + 1;
			} else {
				literals.push({ start: segmentStart, end: Math.min(j, n), dynamicAfter: true, concatFollows: false });
				stack.push("code");
				depths.push(0);
				i = j + 2;
			}
			continue;
		}
		const ch = text[i] as string;
		if (ch === "/" && text[i + 1] === "/") {
			const eol = text.indexOf("\n", i);
			const stop = eol < 0 ? n : eol;
			blankRange(i, stop);
			i = stop;
		} else if (ch === "/" && text[i + 1] === "*") {
			const close = text.indexOf("*/", i + 2);
			const stop = close < 0 ? n : close + 2;
			blankRange(i, stop);
			i = stop;
		} else if (ch === '"' || ch === "'") {
			let j = i + 1;
			while (j < n && text[j] !== ch && text[j] !== "\n") {
				j += text[j] === "\\" ? 2 : 1;
			}
			literals.push({ start: i + 1, end: Math.min(j, n), dynamicAfter: false, concatFollows: concat(j + 1) });
			i = j + 1;
		} else if (ch === "`") {
			stack.push("template");
			depths.push(0);
			segmentStart = i + 1;
			i++;
		} else if (ch === "{") {
			depths[depths.length - 1] = (depths[depths.length - 1] ?? 0) + 1;
			i++;
		} else if (ch === "}") {
			if ((depths[depths.length - 1] ?? 0) === 0 && stack.length > 1) {
				stack.pop();
				depths.pop();
				segmentStart = i + 1;
				i++;
			} else {
				depths[depths.length - 1] = (depths[depths.length - 1] ?? 1) - 1;
				i++;
			}
		} else {
			i++;
		}
	}
	return { masked: chars.join(""), literals };
}

const GET_BY_ID = /getElementById\(\s*$/;
const CLASSLIST = /classList\.(?:add|remove|toggle|contains|replace)\([^()]*$/;
const CLASSNAME = /(?:className\s*\+?=|\b\w*[Cc]lass\w*\s*\+=)\s*$/;
const QUERY = /(?:querySelector(?:All)?|closest|matches)(?:<[^()]*>)?\(\s*$/;
const REF_ATTRS =
	"(?:for|form|list|headers|usemap|popovertarget|commandfor|aria-(?:labelledby|describedby|controls|owns|activedescendant|flowto|details|errormessage))";

/** `class="a b"` / `id="x"` / id-referencing attributes inside `text` (HTML markup, or a script's string). */
function markupFindings(text: string, token: WebToken, newName: string, base: number, out: TokenFindings): void {
	if (token.kind === "var") {
		return;
	}
	const attrNames = token.kind === "class" ? "class(?:Name)?" : `(?:id|${REF_ATTRS})`;
	const re = new RegExp(`(?<![\\w-])(${attrNames})\\s*=\\s*(["'])([^"']*)\\2`, "gi");
	for (const m of text.matchAll(re)) {
		const value = m[3] as string;
		const valueStart = (m.index as number) + m[0].length - value.length - 1;
		for (const t of value.matchAll(/\S+/g)) {
			if (t[0] === token.name) {
				replaceAt(out, base, valueStart + (t.index as number), token.name.length, newName);
			}
		}
	}
	if (token.kind === "id") {
		const href = new RegExp(`(?<![\\w-])(?:xlink:)?href\\s*=\\s*(["'])#${escapeRegExp(token.name)}\\1`, "gi");
		for (const m of text.matchAll(href)) {
			replaceAt(out, base, (m.index as number) + m[0].length - 1 - token.name.length, token.name.length, newName);
		}
		const url = new RegExp(`url\\(\\s*(["']?)#${escapeRegExp(token.name)}\\1\\s*\\)`, "g");
		for (const m of text.matchAll(url)) {
			replaceAt(out, base, (m.index as number) + m[0].indexOf("#") + 1, token.name.length, newName);
		}
	}
}

function jsFindings(text: string, token: WebToken, newName: string, base: number, out: TokenFindings): void {
	const { masked, literals } = scanJs(text);
	const name = token.name;
	for (const lit of literals) {
		const content = text.slice(lit.start, lit.end);
		const before = masked.slice(Math.max(0, lit.start - 1 - 240), Math.max(0, lit.start - 1));
		if (token.kind === "var") {
			for (const m of content.matchAll(wordRe(name))) {
				replaceAt(out, base, lit.start + (m.index as number), name.length, newName);
			}
			continue;
		}
		markupFindings(content, token, newName, base + lit.start, out);
		const partial = lit.dynamicAfter || lit.concatFollows;
		const noteDynamic = (at: number): void => {
			out.dynamic.push({ offset: base + lit.start + at, text: content.trim().slice(0, 80) });
		};
		if (token.kind === "id" && GET_BY_ID.test(before)) {
			if (content === name && !partial) {
				replaceAt(out, base, lit.start, name.length, newName);
			} else if (partial && content !== "" && name.startsWith(content)) {
				noteDynamic(0); // "view-" + id could produce this id
			}
			continue;
		}
		if (token.kind === "class" && (CLASSLIST.test(before) || CLASSNAME.test(before))) {
			const tokens = [...content.matchAll(/\S+/g)];
			tokens.forEach((t, idx) => {
				const isLast = idx === tokens.length - 1 && !/\s$/.test(content);
				if (isLast && partial) {
					if (name.startsWith(t[0])) {
						noteDynamic(t.index as number); // "row-" + n could produce this class
					}
				} else if (t[0] === name) {
					replaceAt(out, base, lit.start + (t.index as number), name.length, newName);
				}
			});
			continue;
		}
		if (QUERY.test(before)) {
			const prefix = token.kind === "id" ? "#" : ".";
			const re = new RegExp(`${escapeRegExp(prefix)}${escapeRegExp(name)}(?![\\w-])`, "g");
			for (const m of content.matchAll(re)) {
				replaceAt(out, base, lit.start + (m.index as number) + 1, name.length, newName);
			}
			if (lit.dynamicAfter) {
				const tail = new RegExp(`${escapeRegExp(prefix)}([\\w-]+)$`).exec(content);
				if (tail && name.startsWith(tail[1] as string)) {
					noteDynamic(content.length - (tail[1] as string).length);
				}
			}
			continue;
		}
		if (content === name) {
			out.literals.push({ start: base + lit.start, end: base + lit.start + name.length, newText: newName });
		}
	}
}

// -- HTML --------------------------------------------------------------------

const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const SCRIPT_BLOCK = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
const STYLE_ATTR = /(?<![\w-])style\s*=\s*"([^"]*)"/gi;

function htmlFindings(text: string, token: WebToken, newName: string, base: number, out: TokenFindings): void {
	const masked = maskHtml(text);
	let markup = masked;
	const blankSpan = (from: number, to: number): void => {
		markup = markup.slice(0, from) + blank(markup.slice(from, to)) + markup.slice(to);
	};
	for (const m of masked.matchAll(STYLE_BLOCK)) {
		const content = m[1] as string;
		const start = (m.index as number) + m[0].indexOf(content, m[0].indexOf(">"));
		cssFindings(text.slice(start, start + content.length), token, newName, base + start, out);
		blankSpan(start, start + content.length);
	}
	for (const m of masked.matchAll(SCRIPT_BLOCK)) {
		const content = m[1] as string;
		const start = (m.index as number) + m[0].indexOf(content, m[0].indexOf(">"));
		jsFindings(text.slice(start, start + content.length), token, newName, base + start, out);
		blankSpan(start, start + content.length);
	}
	if (token.kind === "var") {
		for (const m of masked.matchAll(STYLE_ATTR)) {
			const value = m[1] as string;
			const start = (m.index as number) + m[0].length - value.length - 1;
			cssFindings(value, token, newName, base + start, out);
		}
		return;
	}
	markupFindings(markup, token, newName, base, out);
}

/** Every place `token` appears in `text` (a file with extension `ext`), with the edits renaming it to `newName`. */
export function findTokenEdits(filePath: string, text: string, token: WebToken, newName: string): TokenFindings {
	const out = emptyFindings();
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".css") {
		cssFindings(text, token, newName, 0, out);
	} else if (ext === ".html") {
		htmlFindings(text, token, newName, 0, out);
	} else {
		jsFindings(text, token, newName, 0, out);
	}
	return out;
}
