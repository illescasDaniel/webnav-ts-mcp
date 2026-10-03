/**
 * `move`: relocate a module file (every import, `<script src>`, stylesheet `url()`
 * and `@import` that names it follows), or move one top-level declaration to
 * another module with the imports it needs and every importer rewritten.
 */

import fs from "node:fs";
import path from "node:path";
import { ToolInputError } from "../shared/errors.js";
import { uriToPath } from "../shared/format.js";
import { canonicalPath, resolveReal } from "../shared/paths.js";
import { relevantFiles } from "../webIndex.js";
import { newErrorLimit, requireText, resolveArgPath, type ToolHost, type WriteArgs } from "./common.js";
import { candidatePaths, SCRIPT_SUFFIXES } from "./deps.js";
import {
	applyEdits,
	createChange,
	detectEol,
	EditPlan,
	type FileChange,
	fileExists,
	modifyChange,
	parseWorkspaceEdit,
	positionToOffset,
	readSource,
	relativeName,
	type TextEdit,
} from "./edits.js";
import { finishPlan } from "./finish.js";
import { fixFile } from "./fixTools.js";
import { addImport, type ImportStatement, parseImports, removeBinding, renderImport } from "./jsImports.js";
import { findMentions, formatMentions } from "./mentions.js";
import { extentOf, kindLabel, locateSymbol, SymbolKinds } from "./symbolLookup.js";
import { dropNewlyDeadImports, removeDeclaration, unusedImportNames } from "./symbolTools.js";

export interface MoveArgs extends WriteArgs {
	toFile?: string | undefined;
	name?: string | undefined;
	filePath?: string | undefined;
	keepReexport?: boolean | undefined;
	allowLarge?: boolean | undefined;
}

// -- helpers shared by both moves ---------------------------------------------------

const posix = (p: string): string => p.split(path.sep).join("/");

/** Relative path from the directory of `fromFile` to `target`, always starting with `./` or `../`. */
function relativeRef(fromFile: string, target: string): string {
	const rel = posix(path.relative(path.dirname(fromFile), target));
	return rel.startsWith(".") ? rel : `./${rel}`;
}

const REPLACEMENT_EXT: Record<string, string> = {
	".ts": ".js",
	".tsx": ".js",
	".js": ".js",
	".jsx": ".jsx",
	".mts": ".mjs",
	".mjs": ".mjs",
	".cts": ".cjs",
	".cjs": ".cjs",
};

/** The import specifier for `target` written in `fromFile`, in the extension style of `like` (`./a`, `./a.js`, `./a.ts`). */
function moduleSpecifier(fromFile: string, target: string, like: string): string {
	const ref = relativeRef(fromFile, target);
	const targetExt = path.extname(ref);
	const base = ref.slice(0, ref.length - targetExt.length);
	const likeExt = path.extname(like);
	if (!SCRIPT_SUFFIXES.has(likeExt)) {
		return base;
	}
	return likeExt === targetExt || likeExt === ".ts"
		? base + targetExt
		: base + (REPLACEMENT_EXT[targetExt] ?? targetExt);
}

// -- file moves -----------------------------------------------------------------------

const URL_ATTR = /(?<![\w-])(src|href|poster|data-src)\s*=\s*(["'])([^"']*)\2/gi;
const CSS_URL = /url\(\s*(["']?)([^"')\s]+)\1\s*\)|@import\s+(["'])([^"']+)\3/gi;

const isExternal = (ref: string): boolean => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\$\{|\{\{)/i.test(ref) || ref === "";

function splitSuffix(ref: string): [string, string] {
	const at = ref.search(/[?#]/);
	return at === -1 ? [ref, ""] : [ref.slice(0, at), ref.slice(at)];
}

/**
 * References in `text` (an HTML or CSS file at `file`) to `from`, rewritten to point at `to`; and,
 * when `file` itself is the moved file, its own relative references re-based onto its new location.
 */
function rewriteReferences(
	text: string,
	file: string,
	context: { from: string; to: string; roots: string[] },
	selfMove: boolean,
): TextEdit[] {
	const edits: TextEdit[] = [];
	const newHome = selfMove ? context.to : file;
	const consider = (ref: string, start: number): void => {
		if (isExternal(ref)) {
			return;
		}
		const [bare, tail] = splitSuffix(ref);
		const rootAbsolute = bare.startsWith("/");
		if (rootAbsolute) {
			const root = context.roots.find((r) => path.join(r, bare) === context.from) ?? undefined;
			if (root && !selfMove) {
				const rebased = `/${posix(path.relative(root, context.to))}${tail}`;
				edits.push({ start, end: start + ref.length, newText: rebased });
			}
			return;
		}
		const target = path.resolve(path.dirname(file), bare);
		const points = selfMove ? target : target === context.from ? context.to : undefined;
		if (points === undefined) {
			return;
		}
		if (!selfMove || points !== target || path.dirname(newHome) !== path.dirname(file)) {
			const keepDot = bare.startsWith("./");
			let rel = posix(path.relative(path.dirname(newHome), points));
			if (keepDot && !rel.startsWith(".")) {
				rel = `./${rel}`;
			}
			const rewritten = rel + tail;
			if (rewritten !== ref) {
				edits.push({ start, end: start + ref.length, newText: rewritten });
			}
		}
	};
	if (file.toLowerCase().endsWith(".html")) {
		for (const m of text.matchAll(URL_ATTR)) {
			const value = m[3] as string;
			consider(value, (m.index as number) + m[0].length - 1 - value.length);
		}
	}
	for (const m of text.matchAll(CSS_URL)) {
		const value = (m[2] ?? m[4]) as string;
		const at = (m.index as number) + m[0].lastIndexOf(value);
		consider(value, at);
	}
	return edits;
}

async function moveFile(host: ToolHost, args: MoveArgs): Promise<string> {
	const from = resolveArgPath(host, requireText(args.filePath, "file_path"));
	let to = resolveArgPath(host, requireText(args.toFile, "`to_file`"));
	if (!fileExists(from)) {
		throw new ToolInputError(
			fs.existsSync(from) && fs.statSync(from).isDirectory()
				? `${args.filePath} is a directory; move its files one at a time.`
				: `File not found: ${args.filePath} (relative paths resolve against the workspace root).`,
		);
	}
	if (requireText(args.toFile, "`to_file`").endsWith("/") || (fs.existsSync(to) && fs.statSync(to).isDirectory())) {
		to = path.join(to, path.basename(from));
	}
	if (to === from) {
		throw new ToolInputError("to_file is the file's current location.");
	}
	if (fs.existsSync(to)) {
		throw new ToolInputError(`${relativeName(to, host.workspaceRoot)} already exists.`);
	}
	if (args.keepReexport) {
		throw new ToolInputError("`keep_reexport` only applies when moving a symbol (`name`).");
	}
	const root = host.workspaceRoot;
	const edits = new Map<string, TextEdit[]>();
	const addEdits = (file: string, list: readonly TextEdit[]): void => {
		const bucket = edits.get(file) ?? [];
		bucket.push(...list);
		edits.set(file, bucket);
	};
	const notes: string[] = [];
	const ext = path.extname(from).toLowerCase();
	if (SCRIPT_SUFFIXES.has(ext) || ext === ".json") {
		const client = await host.scriptClient();
		const proposed = parseWorkspaceEdit(await client.willRenameFiles([{ oldPath: from, newPath: to }]));
		for (const [file, list] of proposed.edits) {
			addEdits(file, list);
		}
	}
	const roots = [...new Set([...host.webRoots().map((r) => resolveReal(r.root)), resolveReal(root)])];
	const context = { from, to, roots };
	const sources = new Map<string, { text: string; bom: boolean }>();
	const textOf = (file: string): { text: string; bom: boolean } | undefined => {
		let hit = sources.get(file);
		if (!hit) {
			try {
				hit = readSource(file);
			} catch {
				return undefined;
			}
			sources.set(file, hit);
		}
		return hit;
	};
	for (const root0 of host.webRoots()) {
		for (const file of relevantFiles(root0.root)) {
			const suffix = path.extname(file).toLowerCase();
			if (suffix !== ".html" && suffix !== ".css") {
				continue;
			}
			const canonical = canonicalPath(file);
			const own = canonical === from;
			const source = textOf(canonical);
			if (!source) {
				continue;
			}
			const found = rewriteReferences(source.text, canonical, context, own);
			if (found.length > 0) {
				addEdits(canonical, found);
			}
		}
	}
	// The file may be outside every configured root (still in the workspace): its own references need re-basing.
	if ((ext === ".html" || ext === ".css") && !edits.has(from)) {
		const source = textOf(from);
		if (source) {
			addEdits(from, rewriteReferences(source.text, from, context, true));
		}
	}
	const changes: FileChange[] = [];
	let selfText: string | undefined;
	let selfBom = false;
	let original: { text: string; bom: boolean } | undefined;
	try {
		original = readSource(from);
	} catch {
		original = undefined;
	}
	for (const [file, list] of edits) {
		if (list.length === 0) {
			continue;
		}
		const source = textOf(file) ?? readSource(file);
		const next = applyEdits(source.text, list);
		if (file === from) {
			selfText = next;
			selfBom = source.bom;
		} else if (next !== source.text) {
			changes.push(modifyChange(file, source.text, next, source.bom));
		}
	}
	changes.push({
		path: to,
		kind: "rename",
		oldText: original?.text,
		newText: selfText !== undefined && selfText !== original?.text ? selfText : undefined,
		oldBom: original?.bom ?? false,
		newBom: selfBom || (original?.bom ?? false),
		renamedFrom: from,
	});
	const relFrom = relativeName(from, root);
	const relTo = relativeName(to, root);
	const rewritten = changes.length - 1;
	const name = path.basename(from);
	const covered = new Set(
		[...edits.keys()].flatMap((file) => {
			const text = textOf(file)?.text ?? "";
			return (edits.get(file) ?? []).map((e) => `${file}:${text.slice(0, e.start).split(/\r\n|\r|\n/).length}`);
		}),
	);
	notes.push(
		...formatMentions(
			findMentions(
				root,
				name,
				(file, line) => covered.has(`${canonicalPath(file)}:${line}`) || canonicalPath(file) === from,
			),
			name,
			"; configs, aliases, docs and string paths are not rewritten",
		),
	);
	const title = `Move ${relFrom} -> ${relTo}: ${rewritten} file(s) updated`;
	return (
		await finishPlan(host, new EditPlan(title, changes, notes), title, {
			apply: args.apply ?? true,
			maxNewErrors: newErrorLimit(args.maxNewErrors),
			allowLarge: args.allowLarge ?? false,
		})
	).text;
}

// -- symbol moves -----------------------------------------------------------------------

const MOVABLE_KINDS = new Set<number>([
	SymbolKinds.Class,
	SymbolKinds.Enum,
	SymbolKinds.Interface,
	SymbolKinds.Function,
	SymbolKinds.Variable,
	SymbolKinds.Constant,
	SymbolKinds.Namespace,
]);

interface Working {
	original: string | undefined;
	text: string;
	bom: boolean;
}

/** Statements in `text` (at `file`) that import or re-export from the module `target`. */
function statementsFrom(text: string, file: string, target: string): ImportStatement[] {
	return parseImports(text).filter((s) =>
		candidatePaths(file, s.specifier).some((c) => c === target || canonicalPath(c) === target),
	);
}

async function moveSymbol(host: ToolHost, args: MoveArgs): Promise<string> {
	const name = requireText(args.name, "`name`");
	const loc = await locateSymbol(host, name, args.filePath);
	if (!SCRIPT_SUFFIXES.has(path.extname(loc.file).toLowerCase())) {
		throw new ToolInputError("only JS/TS declarations can be moved.");
	}
	if (loc.parent !== undefined) {
		throw new ToolInputError(
			`${name} is a member of ${loc.parent.name}; move only moves top-level declarations (use edit_symbol to cut and paste a member).`,
		);
	}
	if (loc.node.kind === undefined || !MOVABLE_KINDS.has(loc.node.kind)) {
		throw new ToolInputError(
			`${name} is a ${kindLabel(loc.node.kind)}; move handles classes, functions, interfaces, enums, types and consts.`,
		);
	}
	const root = host.workspaceRoot;
	const to = resolveArgPath(host, requireText(args.toFile, "`to_file`"));
	if (!SCRIPT_SUFFIXES.has(path.extname(to).toLowerCase())) {
		throw new ToolInputError("to_file must be a JS/TS file.");
	}
	if (to === loc.file) {
		throw new ToolInputError(`${name} is already in ${relativeName(to, root)}.`);
	}
	const client = await host.scriptClient();
	const simple = String(loc.node.name ?? name)
		.split(".")
		.pop() as string;
	const ext = extentOf(loc.text, loc.node, name);
	const declaration = loc.text.slice(ext.start, ext.end);
	if (/^export\s+default\b/.test(declaration)) {
		throw new ToolInputError(
			`${name} is a default export; moving it changes how it is imported, so do it with \`edit\`.`,
		);
	}
	const exported = /^export\b/.test(declaration);
	const doc = loc.text.slice(ext.docStart, ext.start);
	const moved = doc + (exported ? declaration : `export ${declaration}`);
	const working = new Map<string, Working>();
	const get = (file: string): Working => {
		let w = working.get(file);
		if (!w) {
			if (fileExists(file)) {
				const { text, bom } = readSource(file);
				w = { original: text, text, bom };
			} else {
				w = { original: undefined, text: "", bom: false };
			}
			working.set(file, w);
		}
		return w;
	};
	const source = get(loc.file);
	const dest = get(to);
	const eol = detectEol(source.text);
	const notes: string[] = [];

	// Who refers to the symbol, grouped by file.
	const references = await client.references(loc.rel, loc.line + 1, loc.column + 1, { includeDeclaration: false });
	const referencingFiles = new Set<string>();
	let usedInSource = false;
	for (const ref of references) {
		const file = canonicalPath(uriToPath(ref.uri ?? ref.targetUri ?? ""));
		if (file !== loc.file) {
			referencingFiles.add(file);
			continue;
		}
		const start = ref.range?.start;
		const at = start ? positionToOffset(loc.text, start.line ?? 0, start.character ?? 0) : -1;
		if (at < ext.docStart || at >= ext.end) {
			usedInSource = true; // used elsewhere in the old file: it has to import it back
		}
	}

	// 1. Remove from the source file.
	source.text = removeDeclaration(source.text, ext.docStart, ext.end);

	// 2. Other files that import it from the old module now import it from the new one.
	const manual: string[] = [];
	for (const file of [...referencingFiles, ...(dest.original !== undefined ? [to] : [])]) {
		const w = get(file);
		const statements = statementsFrom(w.text, file, loc.file).filter((s) => s.named.some((b) => b.name === simple));
		for (const stmt of statements.reverse()) {
			const binding = stmt.named.find((b) => b.name === simple);
			if (!binding) {
				continue;
			}
			const current = parseImports(w.text).find((s) => s.start === stmt.start && s.kind === stmt.kind);
			if (!current) {
				continue;
			}
			const specifierNow = moduleSpecifier(file, to, stmt.specifier);
			const onlyThis = current.named.length === 1 && !current.defaultName && !current.namespaceName;
			if (onlyThis && file !== to) {
				// The statement carries nothing else: repoint it where it stands.
				const rendered = renderImport(
					{ ...current, specifier: specifierNow },
					{ quote: current.quote, semicolon: current.semicolon, spacedBraces: current.spacedBraces },
				);
				w.text = w.text.slice(0, current.start) + rendered + w.text.slice(current.end);
				continue;
			}
			w.text = removeBinding(w.text, current, binding.local);
			if (file === to) {
				if (binding.local !== simple) {
					manual.push(`${relativeName(file, root)} imported it as ${binding.local}`);
				}
				continue;
			}
			const specifier = moduleSpecifier(file, to, stmt.specifier);
			if (stmt.kind === "export") {
				const rendered = `export ${stmt.typeOnly ? "type " : ""}{ ${binding.typeOnly ? "type " : ""}${simple} } from ${stmt.quote}${specifier}${stmt.quote}${stmt.semicolon ? ";" : ""}`;
				w.text = `${w.text.replace(/\s*$/, "")}${eol}${rendered}${eol}`;
			} else {
				w.text = addImport(w.text, { specifier, named: [binding], typeOnly: stmt.typeOnly });
			}
		}
		const remaining = statementsFrom(w.text, file, loc.file).filter((s) => s.namespaceName || s.starExport);
		if (remaining.length > 0) {
			manual.push(`${relativeName(file, root)} reaches it through a namespace or \`export *\` of the old module`);
		}
	}

	// 3. The source file keeps using it: import it from the new home (and optionally re-export it).
	if (usedInSource || args.keepReexport) {
		const specifier = moduleSpecifier(loc.file, to, "");
		if (usedInSource) {
			source.text = addImport(source.text, { specifier, named: [{ name: simple, local: simple, typeOnly: false }] });
		}
		if (args.keepReexport) {
			source.text = `${source.text.replace(/\s*$/, "")}${eol}export { ${simple} } from ${JSON.stringify(specifier)};${eol}`;
		}
	}

	// 4. Put it in the destination, then let the language server add the imports it needs.
	const joined = dest.text.trim() === "" ? "" : `${dest.text.replace(/\s+$/, "")}${eol}${eol}`;
	dest.text = `${joined}${moved.replace(/\r\n|\n/g, eol)}${eol}`;
	const overlays = new Map([...working].map(([file, w]) => [file, w.text] as [string, string]));
	const wasUnused = await unusedImportNames(client, loc.file);
	const fixed = await host.exclusive(() =>
		client.withOverlay(overlays, async () => {
			const result = await fixFile(client, to, dest.text, {
				prefer: (action) => action.title.includes(JSON.stringify(moduleSpecifier(to, loc.file, "")).slice(1, -1)),
			});
			const cleaned = (await dropNewlyDeadImports(client, loc.file, source.text, wasUnused)).text;
			return { result, cleaned };
		}),
	);
	dest.text = fixed.result.text;
	source.text = fixed.cleaned;
	const cycle =
		statementsFrom(dest.text, to, loc.file).length > 0 && statementsFrom(source.text, loc.file, to).length > 0;
	if (cycle) {
		notes.push(
			`import cycle: ${relativeName(to, root)} imports from ${relativeName(loc.file, root)} and the other way round`,
		);
	}
	for (const u of fixed.result.unfixed) {
		notes.push(
			`in ${relativeName(to, root)}: ${u.diagnostic.message?.split("\n")[0]} (${u.why}); the moved code may use something private to the old file`,
		);
	}
	if (fixed.result.applied.length > 0) {
		notes.push(`imports added to ${relativeName(to, root)}: ${fixed.result.applied.length}`);
	}
	if (!exported) {
		notes.push(`it was not exported; it is now (\`export\` added)`);
	}
	notes.push(...manual.map((m) => `manual follow-up: ${m}`));
	notes.push(
		...formatMentions(
			findMentions(root, simple, (file) => working.has(canonicalPath(file))),
			simple,
			"; strings and docs are not rewritten",
		),
	);

	const changes: FileChange[] = [];
	for (const [file, w] of working) {
		if (w.original === undefined) {
			changes.push(createChange(file, w.text));
		} else if (w.text !== w.original) {
			changes.push(modifyChange(file, w.original, w.text, w.bom));
		}
	}
	const title = `Move ${name} from ${loc.rel} to ${relativeName(to, root)}: ${changes.length} file(s)`;
	return (
		await finishPlan(host, new EditPlan(title, changes, notes), title, {
			apply: args.apply ?? true,
			maxNewErrors: newErrorLimit(args.maxNewErrors),
			allowLarge: args.allowLarge ?? false,
		})
	).text;
}

export async function move(host: ToolHost, args: MoveArgs): Promise<string> {
	if (args.name) {
		return moveSymbol(host, args);
	}
	if (!args.filePath) {
		throw new ToolInputError("pass `name` (a declaration to move) or `file_path` (the file to move).");
	}
	return moveFile(host, args);
}
