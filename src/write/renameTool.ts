/**
 * `rename_symbol`: rename a JS/TS symbol through the language server, or a CSS
 * custom property / `#id` / `.class` across stylesheets, markup and scripts.
 */

import { ToolInputError } from "../shared/errors.js";
import { uriToPath, uriToRelative } from "../shared/format.js";
import type { LspSymbol } from "../shared/lspTypes.js";
import { canonicalPath, relativeWithin, resolveReal } from "../shared/paths.js";
import { resolveSymbol } from "../shared/resolve.js";
import { relevantFiles } from "../webIndex.js";
import { newErrorLimit, resolveArgPath, type ToolHost, type WebRootInfo, type WriteArgs } from "./common.js";
import {
	fileExists,
	lineStarts,
	offsetToPosition,
	parseWorkspaceEdit,
	planFromEdits,
	positionToOffset,
	readSource,
	relativeName,
	type TextEdit,
} from "./edits.js";
import { finishPlan } from "./finish.js";
import { findMentions, formatMentions } from "./mentions.js";
import { findNodeAt } from "./symbolLookup.js";
import { findTokenEdits, parseToken, type TokenKind, tokenText, type WebToken } from "./webTokens.js";

export interface RenameArgs extends WriteArgs {
	newName?: string | undefined;
	name?: string | undefined;
	filePath?: string | undefined;
	line?: number | undefined;
	column?: number | undefined;
	parameter?: string | undefined;
	allowLarge?: boolean | undefined;
	/** Web tokens: rename even when the new name already exists. */
	force?: boolean | undefined;
	/** Web tokens: also rename script string literals exactly equal to the name. */
	includeStringLiterals?: boolean | undefined;
}

const RESERVED = new Set(
	"break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public".split(
		" ",
	),
);
const IDENTIFIER = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;

export function validateIdentifier(oldName: string, newName: string): void {
	if (!IDENTIFIER.test(newName) || RESERVED.has(newName)) {
		throw new ToolInputError(`${JSON.stringify(newName)} is not a valid JavaScript identifier.`);
	}
	if (newName === oldName) {
		throw new ToolInputError(`new_name is the same as the current name (${JSON.stringify(oldName)}).`);
	}
}

/** The 0-based position of parameter `parameter` in the function whose declaration starts at `node`. */
function parameterPosition(
	text: string,
	node: LspSymbol,
	parameter: string,
): { line: number; character: number } | undefined {
	const sel = node.selectionRange?.end;
	if (!sel) {
		return undefined;
	}
	let at = positionToOffset(text, sel.line ?? 0, sel.character ?? 0);
	while (at < text.length && /\s/.test(text[at] as string)) {
		at++;
	}
	if (text[at] === "<") {
		for (let depth = 0; at < text.length; at++) {
			depth += text[at] === "<" ? 1 : text[at] === ">" ? -1 : 0;
			if (depth === 0) {
				at++;
				break;
			}
		}
	}
	if (text[at] !== "(") {
		return undefined;
	}
	let depth = 0;
	let end = at;
	for (; end < text.length; end++) {
		depth += "([{".includes(text[end] as string) ? 1 : ")]}".includes(text[end] as string) ? -1 : 0;
		if (depth === 0) {
			break;
		}
	}
	const signature = text.slice(at, end + 1);
	const re = new RegExp(`(?<=[(,{\\s.])${parameter.replace(/[$]/g, "\\$")}(?![\\w$])`, "g");
	for (const m of signature.matchAll(re)) {
		const index = m.index as number;
		const head = signature.slice(0, index).trimEnd();
		if (/[({[,]$/.test(head) || head.endsWith("...")) {
			return offsetToPosition(text, at + index);
		}
	}
	return undefined;
}

async function renameScript(host: ToolHost, args: RenameArgs, newName: string): Promise<string> {
	const client = await host.scriptClient();
	let rel: string;
	let line: number;
	let column: number;
	let display: string;
	if (args.name) {
		const resolved = await resolveSymbol(client, host.workspaceRoot, args.name, args.filePath);
		rel = uriToRelative(resolved.uri, host.workspaceRoot);
		line = resolved.line;
		column = resolved.column;
		display = args.name;
		if (args.parameter) {
			const file = canonicalPath(uriToPath(resolved.uri));
			const text = readSource(file).text;
			const hit = findNodeAt(await client.documentSymbol(rel), line, column);
			const pos = hit && parameterPosition(text, hit.node, args.parameter);
			if (!pos) {
				throw new ToolInputError(
					`${args.name} has no parameter ${JSON.stringify(args.parameter)} that rename can find.`,
				);
			}
			line = pos.line;
			column = pos.character;
			display = `${args.name}(${args.parameter})`;
		}
	} else if (args.filePath && args.line && args.column) {
		const file = resolveArgPath(host, args.filePath);
		if (!fileExists(file)) {
			throw new ToolInputError(`File not found: ${args.filePath} (relative paths resolve against the workspace root).`);
		}
		rel = relativeName(file, host.workspaceRoot);
		line = args.line - 1;
		column = args.column - 1;
		display = `${rel}:${args.line}:${args.column}`;
	} else {
		throw new ToolInputError(
			"give `name` (e.g. 'Cart.total', or '--bg' / '#id' / '.class' for CSS), or `file_path` with `line` and `column`.",
		);
	}
	const prepared = await client.prepareRename(rel, line + 1, column + 1);
	if (!prepared) {
		throw new ToolInputError(
			`${display} cannot be renamed here: it is not a user-defined symbol (a builtin, a keyword, or library code).`,
		);
	}
	const origin = resolveArgPath(host, rel);
	const originText = readSource(origin).text;
	const range = prepared.range;
	const oldName =
		range?.start && range.end
			? originText.slice(
					positionToOffset(originText, range.start.line ?? 0, range.start.character ?? 0),
					positionToOffset(originText, range.end.line ?? 0, range.end.character ?? 0),
				)
			: (prepared.placeholder ?? "");
	validateIdentifier(oldName, newName);
	const workspaceEdit = await client.rename(rel, line + 1, column + 1, newName);
	const parsed = parseWorkspaceEdit(workspaceEdit);
	if (parsed.edits.size === 0) {
		throw new ToolInputError(`the language server found nothing to rename for ${display}.`);
	}
	const guard = host.state().guard;
	for (const file of parsed.edits.keys()) {
		guard.checkPath(file);
	}
	const total = [...parsed.edits.values()].reduce(
		(sum, list) => sum + new Set(list.map((e) => `${e.start}:${e.end}`)).size,
		0,
	);
	const covered = new Map<string, Set<number>>();
	for (const [file, list] of parsed.edits) {
		const text = readSource(file).text;
		const starts = lineStarts(text);
		covered.set(file, new Set(list.map((e) => offsetToPosition(text, e.start, starts).line + 1)));
	}
	const mentions = findMentions(
		host.workspaceRoot,
		oldName,
		(file, ln) => covered.get(canonicalPath(file))?.has(ln) ?? false,
	);
	const notes = formatMentions(mentions, oldName, "; the type checker cannot link them");
	if (parsed.other.length > 0) {
		notes.push(`the language server also proposed: ${parsed.other.join(", ")} (ignored)`);
	}
	const title = `Rename ${oldName} -> ${args.newName} (${display}): ${total} edit(s) in ${parsed.edits.size} file(s)`;
	const plan = planFromEdits(title, parsed.edits, notes);
	return (
		await finishPlan(host, plan, title, {
			apply: args.apply ?? true,
			maxNewErrors: newErrorLimit(args.maxNewErrors),
			allowLarge: args.allowLarge ?? false,
		})
	).text;
}

// -- CSS custom properties, ids and classes ---------------------------------------

const CSS_IDENT = /^-?(?:[_a-zA-Z]|[\u0080-\uffff])(?:[\w-]|[\u0080-\uffff])*$/;

function validateTokenName(kind: TokenKind, oldName: string, newName: string): string {
	let name = newName.trim();
	if (kind === "var") {
		name = name.startsWith("--") ? name : `--${name}`;
		if (!/^--(?:[\w-]|[\u0080-\uffff])+$/.test(name)) {
			throw new ToolInputError(
				`${JSON.stringify(newName)} is not a valid custom property name (letters, digits, - and _ after --).`,
			);
		}
	} else {
		const prefix = kind === "id" ? "#" : ".";
		if (name.startsWith("#") || name.startsWith(".")) {
			if (!name.startsWith(prefix)) {
				throw new ToolInputError(
					`a ${kind} cannot be renamed to ${JSON.stringify(newName)}: it must start with '${prefix}' (or have no prefix).`,
				);
			}
			name = name.slice(1);
		}
		if (!CSS_IDENT.test(name) || /^-?\d/.test(name) || name === "-") {
			throw new ToolInputError(`${JSON.stringify(newName)} is not a valid ${kind} name.`);
		}
	}
	if (name === oldName) {
		throw new ToolInputError(`new_name is the same as the current name (${JSON.stringify(oldName)}).`);
	}
	return name;
}

function rootOfFile(roots: WebRootInfo[], file: string): WebRootInfo | undefined {
	const real = resolveReal(file);
	return roots.find((r) => relativeWithin(real, resolveReal(r.root)) !== undefined);
}

async function renameWebToken(host: ToolHost, args: RenameArgs, token: WebToken, requested: string): Promise<string> {
	const newName = validateTokenName(token.kind, token.name, requested);
	const shown = (name: string): string => tokenText({ kind: token.kind, name });
	const roots = host.webRoots();
	const guard = host.state().guard;
	const scan = (root: WebRootInfo, what: WebToken, replacement: string) => {
		const result: {
			file: string;
			text: string;
			bom: boolean;
			edits: TextEdit[];
			dynamic: number[];
			literals: TextEdit[];
		}[] = [];
		for (const file of relevantFiles(root.root)) {
			let source: ReturnType<typeof readSource>;
			try {
				source = readSource(file);
			} catch {
				continue;
			}
			// A dynamic id ("view-" + n) only shows its first segment, so that is all a file must contain.
			if (!source.text.includes(what.name.split("-").find(Boolean) ?? what.name)) {
				continue;
			}
			const found = findTokenEdits(file, source.text, what, replacement);
			if (found.edits.length > 0 || found.dynamic.length > 0 || found.literals.length > 0) {
				result.push({
					file: canonicalPath(file),
					...source,
					edits: found.edits,
					dynamic: found.dynamic.map((d) => d.offset),
					literals: found.literals,
				});
			}
		}
		return result;
	};
	let target: WebRootInfo[];
	let files: ReturnType<typeof scan> = [];
	let literalOnly = false;
	if (args.filePath) {
		const root = rootOfFile(roots, resolveArgPath(host, args.filePath));
		if (!root) {
			throw new ToolInputError(
				`${args.filePath} is not inside any configured root (${roots.map((r) => r.name).join(", ")}).`,
			);
		}
		target = [root];
		files = scan(root, token, newName);
	} else {
		const scans = roots.map((r) => ({ root: r, files: scan(r, token, newName) }));
		const hits = scans.filter((s) => s.files.some((f) => f.edits.length > 0));
		target = hits.map((s) => s.root);
		files = hits[0]?.files ?? [];
		literalOnly = hits.length === 0 && scans.some((s) => s.files.some((f) => f.literals.length > 0));
		if (target.length > 1) {
			throw new ToolInputError(
				`${tokenText(token)} appears in several roots (${target.map((r) => r.name).join(", ")}), and each root has its own values and markup; pass \`file_path\` of a file in the root to rename in.`,
			);
		}
	}
	const root = target[0];
	if (!root || files.every((f) => f.edits.length === 0)) {
		const hint =
			literalOnly || files.some((f) => f.literals.length > 0)
				? " It appears only as a plain string literal; `edit` those, or pass include_string_literals=true."
				: "";
		throw new ToolInputError(`No occurrences of ${tokenText(token)} found.${hint}`);
	}
	if (!args.force) {
		const clash = scan(root, { kind: token.kind, name: newName }, token.name).filter((f) => f.edits.length > 0);
		if (clash.length > 0) {
			throw new ToolInputError(
				`${shown(newName)} already exists in ${clash
					.map((f) => relativeName(f.file, host.workspaceRoot))
					.slice(0, 4)
					.join(", ")}: renaming would merge the two. Pass force=true if that is what you want.`,
			);
		}
	}
	const edits = new Map<string, TextEdit[]>();
	const notes: string[] = [];
	const skipped: string[] = [];
	let dynamicCount = 0;
	let literalCount = 0;
	const literalPlaces: string[] = [];
	for (const f of files) {
		const list = [...f.edits];
		if (args.includeStringLiterals) {
			list.push(...f.literals);
		} else {
			for (const lit of f.literals) {
				literalCount++;
				if (literalPlaces.length < 8) {
					literalPlaces.push(
						`${relativeName(f.file, host.workspaceRoot)}:${offsetToPosition(f.text, lit.start).line + 1}`,
					);
				}
			}
		}
		dynamicCount += f.dynamic.length;
		if (list.length === 0) {
			continue;
		}
		try {
			guard.checkPath(f.file);
		} catch (error) {
			if (error instanceof ToolInputError) {
				skipped.push(relativeName(f.file, host.workspaceRoot));
				continue;
			}
			throw error;
		}
		edits.set(f.file, list);
	}
	if (skipped.length > 0) {
		notes.push(`not edited (generated output; edit its source): ${skipped.join(", ")}`);
	}
	if (dynamicCount > 0) {
		notes.push(
			`${dynamicCount} place(s) build the name dynamically ("prefix-" + x, \`.prefix-\${x}\`) and were not renamed; check them by hand.`,
		);
	}
	if (literalCount > 0) {
		notes.push(
			`${literalCount} script string literal(s) equal "${token.name}" were left alone (they may or may not be this ${token.kind === "var" ? "property" : token.kind}): ${literalPlaces.join(", ")}${literalCount > literalPlaces.length ? ", ..." : ""}. Pass include_string_literals=true to rename them.`,
		);
	}
	// Mentions the structural rules do not cover: other template languages, docs, plain text.
	const covered = new Map<string, Set<number>>();
	for (const f of files) {
		covered.set(f.file, new Set(f.edits.concat(f.literals).map((e) => offsetToPosition(f.text, e.start).line + 1)));
	}
	const needle = tokenText(token);
	const mentionRe =
		token.kind === "var"
			? undefined
			: new RegExp(`[.#]?${token.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
	const found = findMentions(
		root.root,
		token.kind === "var" ? token.name : token.name,
		(file, ln) => covered.get(canonicalPath(file))?.has(ln) ?? false,
		400,
	);
	const relevant = found.mentions.filter(
		(m) =>
			token.kind === "var" ||
			(/class|id\b|[.#]|querySelector|getElementById|classList/i.test(m.text) && (mentionRe?.test(m.text) ?? true)),
	);
	notes.push(
		...formatMentions(
			{ mentions: relevant.slice(0, 12), total: relevant.length },
			needle,
			" (other template languages, docs, text)",
		),
	);
	const total = [...edits.values()].reduce((sum, list) => sum + list.length, 0);
	const title = `Rename ${tokenText(token)} -> ${shown(newName)}: ${total} edit(s) in ${edits.size} file(s)${roots.length > 1 ? ` (root ${root.name})` : ""}`;
	const plan = planFromEdits(title, edits, notes);
	return (
		await finishPlan(host, plan, title, {
			apply: args.apply ?? true,
			maxNewErrors: newErrorLimit(args.maxNewErrors),
			allowLarge: args.allowLarge ?? false,
		})
	).text;
}

export async function renameSymbol(host: ToolHost, args: RenameArgs): Promise<string> {
	const requested = args.newName?.trim();
	if (!requested) {
		throw new ToolInputError("`new_name` is required.");
	}
	const token = args.name && !args.line ? parseToken(args.name) : undefined;
	if (token) {
		if (args.parameter) {
			throw new ToolInputError("`parameter` only applies to renaming a function's parameter.");
		}
		return renameWebToken(host, args, token, requested);
	}
	return renameScript(host, args, requested);
}
