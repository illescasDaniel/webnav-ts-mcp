/** `edit_symbol`: replace, insert or delete a function, class or member by name. */

import fs from "node:fs";
import { ToolInputError } from "../shared/errors.js";
import { formatReferencesGrouped, uriToPath } from "../shared/format.js";
import type { LspClient } from "../shared/lspClient.js";
import type { LspDiagnostic, LspLocation, LspSymbol } from "../shared/lspTypes.js";
import { canonicalPath } from "../shared/paths.js";
import { newErrorLimit, rejectUnused, requireText, resolveArgPath, type ToolHost, type WriteArgs } from "./common.js";
import {
	createChange,
	detectEol,
	EditPlan,
	joinAfterRemoval,
	lineStarts,
	modifyChange,
	positionToOffset,
	readSource,
	relativeName,
} from "./edits.js";
import { finishPlan } from "./finish.js";
import { addImport, parseImports, removeBinding } from "./jsImports.js";
import { findMentions, formatMentions } from "./mentions.js";
import {
	declaredName,
	detectIndentUnit,
	type Extent,
	extentOf,
	fitSnippet,
	kindLabel,
	type Located,
	locateSymbol,
	SymbolKinds,
	startsWithComment,
} from "./symbolLookup.js";

export type SymbolAction = "replace" | "insert" | "delete";
export type InsertPosition = "after" | "before" | "into" | "end";

export interface EditSymbolArgs extends WriteArgs {
	action?: SymbolAction | undefined;
	name?: string | undefined;
	source?: string | undefined;
	filePath?: string | undefined;
	position?: InsertPosition | undefined;
	imports?: string[] | undefined;
	force?: boolean | undefined;
	pruneImports?: boolean | undefined;
}

const BLOCK_KINDS = new Set<number>([
	SymbolKinds.Class,
	SymbolKinds.Interface,
	SymbolKinds.Namespace,
	SymbolKinds.Enum,
]);
const FUNCTION_KINDS = new Set<number>([SymbolKinds.Function, SymbolKinds.Method, SymbolKinds.Constructor]);

const withEol = (snippet: string, eol: string): string => (eol === "\r\n" ? snippet.replace(/\n/g, "\r\n") : snippet);

/** Add each `import ...` statement the new code needs, unless the file already has it. */
export function applyImports(text: string, statements: readonly string[] | undefined): string {
	let out = text;
	for (const statement of statements ?? []) {
		const parsed = parseImports(`${statement.trim()}\n`);
		if (parsed.length === 0 || parsed.some((p) => p.kind !== "import")) {
			throw new ToolInputError(`\`imports\` takes ES import statements (import ... from "module"), got: ${statement}`);
		}
		for (const imp of parsed) {
			out = addImport(out, {
				specifier: imp.specifier,
				named: imp.named,
				...(imp.defaultName ? { defaultName: imp.defaultName } : {}),
				...(imp.namespaceName ? { namespaceName: imp.namespaceName } : {}),
				typeOnly: imp.typeOnly,
			});
		}
	}
	return out;
}

function leadingDecorators(source: string): string[] {
	const found: string[] = [];
	for (const line of source.split("\n")) {
		const t = line.trim();
		if (t.startsWith("@")) {
			found.push(t);
		} else if (t !== "" && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*")) {
			break;
		}
	}
	return found;
}

async function replaceSymbol(host: ToolHost, args: EditSymbolArgs): Promise<string> {
	const name = requireText(args.name, "`name`");
	const source = args.source;
	if (source === undefined || source.trim() === "") {
		throw new ToolInputError('action="replace" needs `name` and `source` (the complete new definition).');
	}
	const loc = await locateSymbol(host, name, args.filePath);
	const ext = extentOf(loc.text, loc.node, name);
	const eol = detectEol(loc.text);
	const fitted = fitSnippet(source, ext.indent, detectIndentUnit(loc.text));
	const from = startsWithComment(source) ? ext.docStart : ext.start;
	const body = withEol(fitted.slice(ext.indent.length), eol);
	let next = loc.text.slice(0, from) + body + loc.text.slice(ext.end);
	next = applyImports(next, args.imports);
	const notes: string[] = [];
	const newName = declaredName(source);
	const oldName = String(loc.node.name ?? name);
	if (newName !== undefined && newName !== oldName.split(".").pop()) {
		notes.push(
			`the definition is now called ${newName}; references to ${oldName} are NOT updated (use rename_symbol to rename)`,
		);
	}
	if (loc.node.kind !== undefined && FUNCTION_KINDS.has(loc.node.kind)) {
		const oldHead = loc.text.slice(ext.start, ext.end).split("{")[0]?.replace(/\s+/g, " ").trim();
		const newHead = source.replace(/\s+/g, " ").split("{")[0]?.trim();
		if (oldHead !== undefined && newHead !== undefined && oldHead !== newHead) {
			notes.push(`signature changed; callers may need updating (see the diagnostics)`);
		}
	}
	const oldDecorators = leadingDecorators(loc.text.slice(ext.start, ext.end));
	const newDecorators = leadingDecorators(source.replace(/\r\n?/g, "\n"));
	const dropped = oldDecorators.filter((d) => !newDecorators.includes(d));
	if (dropped.length > 0) {
		notes.push(`decorators not in the new source were removed: ${dropped.join(", ")}`);
	}
	const plan = new EditPlan(`Replace ${name} in ${loc.rel}`, [modifyChange(loc.file, loc.text, next, loc.bom)], notes);
	return (
		await finishPlan(host, plan, plan.description, {
			apply: args.apply ?? true,
			maxNewErrors: newErrorLimit(args.maxNewErrors),
		})
	).text;
}

function siblingsOf(symbols: LspSymbol[], line: number, column: number): LspSymbol[] {
	const search = (list: LspSymbol[]): LspSymbol[] | undefined => {
		for (const node of list) {
			if (node.selectionRange?.start?.line === line && node.selectionRange?.start?.character === column) {
				return list;
			}
			const inner = search(node.children ?? []);
			if (inner) {
				return inner;
			}
		}
		return undefined;
	};
	return search(symbols) ?? [];
}

function insertAfter(loc: Located, ext: Extent, fitted: string, eol: string): string {
	return `${loc.text.slice(0, ext.end)}${eol}${eol}${withEol(fitted, eol)}${loc.text.slice(ext.end)}`;
}

function insertBefore(loc: Located, ext: Extent, fitted: string, eol: string): string {
	const lineStart = ext.docStart - ext.indent.length;
	return `${loc.text.slice(0, lineStart)}${withEol(fitted, eol)}${eol}${eol}${loc.text.slice(lineStart)}`;
}

function insertInto(loc: Located, ext: Extent, fitted: string, eol: string): string {
	const closeAt = ext.end - 1;
	if (loc.text[closeAt] !== "}") {
		throw new ToolInputError(`${loc.name} has no { } body to insert into.`);
	}
	const closeLineStart = Math.max(loc.text.lastIndexOf("\n", closeAt - 1), loc.text.lastIndexOf("\r", closeAt - 1)) + 1;
	const body = withEol(fitted, eol);
	if (/^[ \t]*$/.test(loc.text.slice(closeLineStart, closeAt))) {
		const lastChild = (loc.node.children ?? [])[loc.node.children?.length ? loc.node.children.length - 1 : 0];
		const multiline = fitted.includes("\n") || lastChild?.range?.start?.line !== lastChild?.range?.end?.line;
		const blank = lastChild && multiline && loc.node.kind !== SymbolKinds.Interface ? eol : "";
		return `${loc.text.slice(0, closeLineStart)}${blank}${body}${eol}${loc.text.slice(closeLineStart)}`;
	}
	const head = loc.text.slice(0, closeAt).replace(/\s+$/, "");
	return `${head}${eol}${body}${eol}${ext.indent}${loc.text.slice(closeAt)}`;
}

async function insertSymbol(host: ToolHost, args: EditSymbolArgs): Promise<string> {
	const source = args.source;
	if (source === undefined || source.trim() === "" || !args.filePath) {
		throw new ToolInputError('action="insert" needs `source` (the new definition) and `file_path`.');
	}
	const where = args.position ?? (args.name ? "after" : "end");
	if (where === "end" && args.name) {
		throw new ToolInputError('position="end" appends to the file; drop `name`, or use "after"/"before"/"into".');
	}
	if (where !== "end" && !args.name) {
		throw new ToolInputError(`position="${where}" needs \`name\` (the symbol to place it relative to).`);
	}
	const file = resolveArgPath(host, args.filePath);
	const rel = relativeName(file, host.workspaceRoot);
	const exists = fs.existsSync(file);
	const client = await host.scriptClient();
	const newName = declaredName(source);
	let plan: EditPlan;
	let next: string;
	if (where === "end") {
		const current = exists ? readSource(file) : { text: "", bom: false };
		const eol = detectEol(current.text);
		const fitted = fitSnippet(source, "", detectIndentUnit(current.text));
		next =
			current.text.trim() === ""
				? `${withEol(fitted, eol)}${eol}`
				: `${current.text.replace(/\s+$/, "")}${eol}${eol}${withEol(fitted, eol)}${eol}`;
		if (newName && exists) {
			const clash = (await client.documentSymbol(rel)).find(
				(s) => s.name === newName && !FUNCTION_KINDS.has(s.kind ?? 0),
			);
			if (clash) {
				throw new ToolInputError(
					`${rel} already defines '${newName}' (${kindLabel(clash.kind)}); use action="replace" to change it.`,
				);
			}
		}
		next = applyImports(next, args.imports);
		plan = new EditPlan(`Insert ${newName ?? "code"} at the end of ${rel}`, [
			exists ? modifyChange(file, current.text, next, current.bom) : createChange(file, next),
		]);
	} else {
		if (!exists) {
			throw new ToolInputError(`File not found: ${args.filePath}`);
		}
		const loc = await locateSymbol(host, args.name as string, args.filePath);
		if (loc.file !== file) {
			throw new ToolInputError(`${args.name} is defined in ${loc.rel}, not in ${rel}.`);
		}
		const ext = extentOf(loc.text, loc.node, loc.name);
		const eol = detectEol(loc.text);
		const unit = detectIndentUnit(loc.text);
		let scope: LspSymbol[];
		let indent = ext.indent;
		if (where === "into") {
			if (!loc.node.kind || !BLOCK_KINDS.has(loc.node.kind)) {
				throw new ToolInputError(
					`position="into" needs a class, interface, enum or namespace; ${loc.name} is a ${kindLabel(loc.node.kind)}.`,
				);
			}
			scope = loc.node.children ?? [];
			const first = scope[0];
			indent = first?.range?.start
				? (/^[ \t]*/.exec(
						loc.text.slice(positionToOffset(loc.text, first.range.start.line ?? 0, 0, lineStarts(loc.text))),
					)?.[0] ?? ext.indent + unit)
				: ext.indent + unit;
		} else {
			scope = siblingsOf(await client.documentSymbol(loc.rel), loc.line, loc.column);
		}
		if (newName) {
			const clash = scope.find((s) => s.name === newName && !FUNCTION_KINDS.has(s.kind ?? 0));
			if (clash) {
				throw new ToolInputError(
					`'${newName}' already exists there (${kindLabel(clash.kind)}); use action="replace" to change it.`,
				);
			}
		}
		const fitted = fitSnippet(source, indent, unit);
		next =
			where === "after"
				? insertAfter(loc, ext, fitted, eol)
				: where === "before"
					? insertBefore(loc, ext, fitted, eol)
					: insertInto(loc, ext, fitted, eol);
		next = applyImports(next, args.imports);
		plan = new EditPlan(`Insert ${newName ?? "code"} ${where} ${args.name} in ${loc.rel}`, [
			modifyChange(loc.file, loc.text, next, loc.bom),
		]);
	}
	return (
		await finishPlan(host, plan, plan.description, {
			apply: args.apply ?? true,
			maxNewErrors: newErrorLimit(args.maxNewErrors),
		})
	).text;
}

/** `text` without the lines `[start, end)` of a declaration, collapsing the blank line it leaves behind. */
export function removeDeclaration(text: string, start: number, end: number): string {
	const eol = detectEol(text);
	let from = start;
	const lineStart = Math.max(text.lastIndexOf("\n", start - 1), text.lastIndexOf("\r", start - 1)) + 1;
	if (/^[ \t]*$/.test(text.slice(lineStart, start))) {
		from = lineStart;
	}
	let to = end;
	const rest = /^[ \t]*(\r\n|\r|\n|$)/.exec(text.slice(to));
	if (rest) {
		to += rest[0].length;
	}
	const before = text.slice(0, from);
	const after = text.slice(to);
	if (after.trim() === "") {
		return before.replace(/\s+$/, "") + (before.trim() === "" ? "" : eol);
	}
	return joinAfterRemoval(before, after);
}

const UNUSED_CODES = new Set(["6133", "6196", "6192"]);
// "All imports in import declaration are unused": names no binding, so the statement's own are taken.
const ALL_IMPORTS_UNUSED = "6192";

/** Local names reported unused in `text` (the text the diagnostics describe). */
function unusedNames(items: readonly LspDiagnostic[], text: string): Set<string> {
	const names = new Set<string>();
	for (const item of items) {
		if (item.severity !== 4 || !UNUSED_CODES.has(String(item.code))) {
			continue;
		}
		const name = /'([^']+)'/.exec(item.message ?? "")?.[1];
		if (name) {
			names.add(name);
		} else if (String(item.code) === ALL_IMPORTS_UNUSED && item.range?.start) {
			const at = positionToOffset(text, item.range.start.line ?? 0, item.range.start.character ?? 0);
			const stmt = parseImports(text).find((s) => s.kind === "import" && s.start <= at && at < s.end);
			for (const local of [stmt?.defaultName, stmt?.namespaceName, ...(stmt?.named ?? []).map((b) => b.local)]) {
				if (local) {
					names.add(local);
				}
			}
		}
	}
	return names;
}

/** Names of the imports the language server currently reports as unused in `file` (as it sees the file right now). */
export async function unusedImportNames(client: LspClient, file: string): Promise<Set<string>> {
	return unusedNames(await client.diagnostics(file), readSource(file).text);
}

/**
 * `after` without the imports it leaves unused beyond `wasUnused` (those were unused before the edit
 * and stay). Must run inside `client.withOverlay`; `file` is shown with the text `after` meanwhile.
 */
export async function dropNewlyDeadImports(
	client: LspClient,
	file: string,
	after: string,
	wasUnused: ReadonlySet<string>,
): Promise<{ text: string; removed: string[] }> {
	client.updateOverlay(file, after);
	const dead = [...unusedNames(await client.diagnostics(file), after)].filter((name) => !wasUnused.has(name));
	let text = after;
	const removed: string[] = [];
	for (const local of dead) {
		const stmt = parseImports(text).find(
			(s) =>
				s.kind === "import" &&
				(s.defaultName === local || s.namespaceName === local || s.named.some((b) => b.local === local)),
		);
		if (stmt) {
			text = removeBinding(text, stmt, local);
			removed.push(local);
		}
	}
	return { text, removed };
}

/** `after` without the imports the edit just left unused. */
export async function pruneNewlyDeadImports(
	host: ToolHost,
	client: LspClient,
	file: string,
	after: string,
): Promise<{ text: string; removed: string[] }> {
	const wasUnused = await unusedImportNames(client, file);
	return host.exclusive(() =>
		client.withOverlay(new Map([[file, after]]), () => dropNewlyDeadImports(client, file, after, wasUnused)),
	);
}

async function deleteSymbol(host: ToolHost, args: EditSymbolArgs): Promise<string> {
	const name = requireText(args.name, "`name`");
	const loc = await locateSymbol(host, name, args.filePath);
	const client = await host.scriptClient();
	const ext = extentOf(loc.text, loc.node, name);
	const inside = (location: LspLocation): boolean => {
		if (canonicalPath(uriToPath(location.uri ?? location.targetUri ?? "")) !== loc.file) {
			return false;
		}
		const start = location.range?.start ?? location.targetRange?.start;
		if (!start) {
			return false;
		}
		const at = positionToOffset(loc.text, start.line ?? 0, start.character ?? 0);
		return at >= ext.docStart && at < ext.end;
	};
	const users = (await client.references(loc.rel, loc.line + 1, loc.column + 1, { includeDeclaration: false })).filter(
		(l) => !inside(l),
	);
	if (users.length > 0 && !args.force) {
		return `${name} is still used in ${users.length} place(s); nothing was changed:\n${formatReferencesGrouped(users, host.workspaceRoot)}\nRemove or change those first, or pass force=true to delete anyway and see what breaks.`;
	}
	let next = removeDeclaration(loc.text, ext.docStart, ext.end);
	const notes: string[] = [];
	if (users.length > 0) {
		notes.push(`deleted although ${users.length} place(s) still use it (force=true)`);
	}
	if (args.pruneImports ?? true) {
		const pruned = await pruneNewlyDeadImports(host, client, loc.file, next);
		next = pruned.text;
		if (pruned.removed.length > 0) {
			notes.push(`removed imports that only the deleted code used: ${pruned.removed.join(", ")}`);
		}
	}
	const simple = String(loc.node.name ?? name)
		.split(".")
		.pop() as string;
	const mentions = findMentions(host.workspaceRoot, simple, (file, line) => {
		if (canonicalPath(file) !== loc.file) {
			return false;
		}
		const at = lineStarts(loc.text)[line - 1] ?? 0;
		return at >= ext.docStart - ext.indent.length && at <= ext.end;
	});
	notes.push(...formatMentions(mentions, simple, "; the type checker cannot see these"));
	const plan = new EditPlan(`Delete ${name} from ${loc.rel}`, [modifyChange(loc.file, loc.text, next, loc.bom)], notes);
	// Strings and docs naming the symbol mean "look before writing": preview instead of applying.
	const apply = (args.apply ?? true) && !(mentions.total > 0 && !args.force);
	const outcome = await finishPlan(host, plan, plan.description, {
		apply,
		maxNewErrors: newErrorLimit(args.maxNewErrors),
	});
	return mentions.total > 0 && !apply && (args.apply ?? true)
		? `${outcome.text}\n\n(Previewed instead of applied because the name is mentioned elsewhere; review the notes, then apply_edit or rerun with force=true.)`
		: outcome.text;
}

export async function editSymbol(host: ToolHost, args: EditSymbolArgs): Promise<string> {
	switch (args.action) {
		case "replace":
			rejectUnused('action="replace"', { position: args.position, force: args.force });
			return replaceSymbol(host, args);
		case "insert":
			rejectUnused('action="insert"', { force: args.force });
			return insertSymbol(host, args);
		case "delete":
			rejectUnused('action="delete"', { source: args.source, position: args.position, imports: args.imports });
			return deleteSymbol(host, args);
		default:
			throw new ToolInputError(`unknown action ${JSON.stringify(args.action)}: use replace, insert or delete.`);
	}
}
