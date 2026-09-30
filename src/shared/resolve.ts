/**
 * Name-based symbol resolution for the composite tools (`symbol_info`): a
 * `workspace/symbol` lookup with tiered ranking, dotted `Class.method`
 * resolution via `documentSymbol`, and disambiguation by `file_path`, so the
 * tools take a name instead of a hand-computed position.
 */

import path from "node:path";
import { isToolError, ToolInputError } from "./errors.js";
import { isExcluded } from "./exclude.js";
import {
	filterWorkspaceSymbols,
	isHierarchicalDocumentSymbols,
	matchTier,
	pyRepr,
	rankWorkspaceSymbols,
	symbolKindLabel,
	toSymbolTree,
	uriToPath,
	uriToRelative,
	workspaceSymbolPosition,
} from "./format.js";
import type { LspClient } from "./lspClient.js";
import type { LspLocation, LspSymbol, SymbolNode } from "./lspTypes.js";
import { LINE_BREAK_RE, readTextStrict } from "./text.js";

// SymbolKind values that are class members: a candidate with one of these gets
// qualified as `Class.member` in an ambiguity listing.
const MEMBER_KINDS = new Set([6, 7, 9]); // Method, Property, Constructor
const CLASS_KIND = 5;

/** No single confident match for a name-based symbol query: not found, or ambiguous. */
export class SymbolResolutionError extends ToolInputError {
	override name = "SymbolResolutionError";
}

export interface ResolvedSymbol {
	name: string;
	kind: number | undefined;
	uri: string;
	/** 0-based, aimed at the identifier. */
	line: number;
	column: number;
	/** The symbol's full span (for dotted member lookup). */
	rangeStartLine: number;
	rangeEndLine: number;
}

function resolvedFromSymbol(sym: LspSymbol): ResolvedSymbol {
	const [uri, line, column] = workspaceSymbolPosition(sym);
	const rng = sym.location?.range ?? {};
	const startLine = rng.start?.line ?? line;
	const endLine = rng.end?.line ?? startLine;
	return {
		name: sym.name || "?",
		kind: sym.kind,
		uri,
		line,
		column,
		rangeStartLine: startLine,
		rangeEndLine: endLine,
	};
}

function memberSpan(sym: LspSymbol): [number, number] {
	const rng = sym.location?.range ?? {};
	const start = rng.start?.line ?? 0;
	return [start, rng.end?.line ?? start];
}

/** Hierarchical `DocumentSymbol` named `name` (any depth), preferring the one whose identifier sits on `line`. */
function findNamedNode(symbols: LspSymbol[], name: string, line: number): LspSymbol | undefined {
	const found: LspSymbol[] = [];
	const walk = (nodes: LspSymbol[]): void => {
		for (const node of nodes) {
			if (String(node.name) === name) {
				found.push(node);
			}
			walk(node.children ?? []);
		}
	};
	walk(symbols);
	for (const node of found) {
		const sel = (node.selectionRange ?? node.range)?.start;
		if ((sel?.line ?? -1) === line) {
			return node;
		}
	}
	return found[0];
}

function resolvedFromHierarchicalNode(memberName: string, node: LspSymbol, uri: string): ResolvedSymbol {
	const selStart = node.selectionRange?.start ?? node.range?.start ?? {};
	const rng = node.range ?? {};
	const startLine = rng.start?.line ?? 0;
	const endLine = rng.end?.line ?? startLine;
	return {
		name: memberName,
		kind: node.kind,
		uri,
		line: selStart.line ?? startLine,
		column: selStart.character ?? 0,
		rangeStartLine: startLine,
		rangeEndLine: endLine,
	};
}

/** The Class node of a `toSymbolTree` hierarchy whose range contains `targetLine`, innermost first. */
function enclosingClassName(nodes: SymbolNode[], targetLine: number): string | undefined {
	for (const node of nodes) {
		if (!(node.startLine <= targetLine && targetLine <= node.endLine)) {
			continue;
		}
		const inner = enclosingClassName(node.children, targetLine);
		if (inner !== undefined) {
			return inner;
		}
		return node.kind === CLASS_KIND ? node.name : undefined;
	}
	return undefined;
}

/** For Method/Property/Constructor candidates, resolve their enclosing class so an ambiguity listing can show `Class.member`. */
async function qualifyCandidates(
	client: LspClient,
	workspaceRoot: string,
	candidates: LspSymbol[],
): Promise<Map<number, string>> {
	const qualified = new Map<number, string>();
	const trees = new Map<string, SymbolNode[]>();
	for (const [i, sym] of candidates.entries()) {
		if (sym.kind === undefined || !MEMBER_KINDS.has(sym.kind)) {
			continue;
		}
		const rel = uriToRelative(sym.location?.uri ?? "", workspaceRoot);
		let tree = trees.get(rel);
		if (tree === undefined) {
			try {
				tree = toSymbolTree(await client.documentSymbol(rel));
			} catch (error) {
				if (!isToolError(error)) {
					throw error;
				}
				tree = [];
			}
			trees.set(rel, tree);
		}
		const className = enclosingClassName(tree, memberSpan(sym)[0]);
		if (className) {
			qualified.set(i, className);
		}
	}
	return qualified;
}

async function formatCandidates(client: LspClient, candidates: LspSymbol[], workspaceRoot: string): Promise<string> {
	const shown = candidates.slice(0, 10);
	const qualified = await qualifyCandidates(client, workspaceRoot, shown);
	return shown
		.map((sym, i) => {
			const name = sym.name || "?";
			const qualifier = qualified.get(i);
			const display = qualifier ? `${qualifier}.${name}` : name;
			const [uri, line, col] = workspaceSymbolPosition(sym);
			const rel = uri ? uriToRelative(uri, workspaceRoot) : "?";
			return `${display}  [${symbolKindLabel(sym.kind)}]  (${rel}:${line + 1}:${col + 1})`;
		})
		.join("\n");
}

const notFound = (query: string): SymbolResolutionError =>
	new SymbolResolutionError(`No symbol found matching ${pyRepr(query)}.`);

async function ambiguous(
	client: LspClient,
	query: string,
	candidates: LspSymbol[],
	workspaceRoot: string,
): Promise<SymbolResolutionError> {
	const sameFile = new Set(candidates.map((c) => c.location?.uri ?? "")).size === 1;
	// Narrowing by file_path still leaves several same-named symbols in one file
	// (a module-level function and a same-named class method), so point at the
	// position-based escape hatch instead of advice that won't help.
	const hint = sameFile
		? "these all live in the same file; use search_symbol to get exact line/column, then hover/definition/references with that position"
		: "pass file_path to disambiguate";
	return new SymbolResolutionError(
		`${candidates.length} symbols match ${pyRepr(query)}; ${hint}:\n${await formatCandidates(client, candidates, workspaceRoot)}`,
	);
}

function matchesFile(sym: LspSymbol, workspaceRoot: string, filePath: string): boolean {
	const rel = uriToRelative(sym.location?.uri ?? "", workspaceRoot);
	const target = filePath.replaceAll("\\", "/");
	return rel === target || rel.endsWith(`/${target}`) || target.endsWith(`/${rel}`);
}

async function exactCandidates(
	client: LspClient,
	workspaceRoot: string,
	name: string,
	filePath: string | undefined,
): Promise<LspSymbol[]> {
	const symbols = await client.workspaceSymbol(name);
	// Same filter as search_symbol: drop export-list Variable twins and identical
	// (name, kind, file) dupes so `symbol_info("foo")` isn't ambiguous between
	// `function foo` and `export { foo }`.
	const ranked = filterWorkspaceSymbols(rankWorkspaceSymbols(symbols, name));
	let exact = ranked.filter((s) => matchTier(s.name ?? "", name) <= 1);
	// Prefer a case-exact match over a merely case-insensitive one when both exist.
	const caseExact = exact.filter((s) => matchTier(s.name ?? "", name) === 0);
	if (caseExact.length > 0) {
		exact = caseExact;
	}
	if (filePath !== undefined) {
		const narrowed = exact.filter((s) => matchesFile(s, workspaceRoot, filePath));
		if (exact.length > 0 && narrowed.length === 0) {
			// Silently answering with a symbol from a different file than the one the
			// caller named would be a confidently wrong result.
			throw new SymbolResolutionError(
				`No symbol ${pyRepr(name)} in ${pyRepr(filePath)}; ${exact.length} match(es) elsewhere:\n` +
					(await formatCandidates(client, exact, workspaceRoot)),
			);
		}
		exact = narrowed;
	}
	return exact;
}

async function resolveSimple(
	client: LspClient,
	workspaceRoot: string,
	query: string,
	filePath: string | undefined,
): Promise<ResolvedSymbol> {
	const exact = await exactCandidates(client, workspaceRoot, query, filePath);
	const [only, ...rest] = exact;
	if (only === undefined) {
		throw notFound(query);
	}
	if (rest.length > 0) {
		throw await ambiguous(client, query, exact, workspaceRoot);
	}
	return resolvedFromSymbol(only);
}

async function resolveDotted(
	client: LspClient,
	workspaceRoot: string,
	query: string,
	filePath: string | undefined,
): Promise<ResolvedSymbol> {
	// `Outer.Inner.method`: the first segment is looked up workspace-wide, the
	// rest are walked down through that symbol's document-symbol tree.
	const [first = "", ...parts] = query.split(".");
	const memberName = parts[parts.length - 1] ?? "";
	const container = await resolveSimple(client, workspaceRoot, first, filePath);
	const relPath = uriToRelative(container.uri, workspaceRoot);
	const members = await client.documentSymbol(relPath);
	if (isHierarchicalDocumentSymbols(members)) {
		let found = findNamedNode(members, container.name, container.line);
		for (const part of parts) {
			found = (found?.children ?? []).find((c) => String(c.name) === part);
		}
		if (found) {
			return resolvedFromHierarchicalNode(memberName, found, container.uri);
		}
	} else {
		// Flat `SymbolInformation`: narrow by range containment one segment at a time.
		let span: [number, number] = [container.rangeStartLine, container.rangeEndLine];
		let match: LspSymbol | undefined;
		for (const part of parts) {
			const candidates = members.filter((m) => {
				const [start, end] = memberSpan(m);
				return (
					String(m.name ?? "") === part &&
					span[0] <= start &&
					start <= span[1] &&
					!(start === span[0] && end === span[1])
				);
			});
			if (candidates.length > 1) {
				throw await ambiguous(client, query, candidates, workspaceRoot);
			}
			const [only] = candidates;
			if (only === undefined) {
				match = undefined;
				break;
			}
			match = only;
			span = memberSpan(only);
		}
		if (match) {
			return resolvedFromSymbol(match);
		}
	}
	// Inherited members only make sense for a plain `Class.member` query.
	const inherited =
		parts.length === 1 ? await resolveInherited(client, workspaceRoot, container, memberName) : undefined;
	if (inherited === undefined) {
		throw notFound(query);
	}
	return inherited;
}

// Guards against pathological (or cyclic) hierarchies; real class graphs are far smaller.
const MAX_CLASSES_VISITED = 64;

interface ClassRef {
	uri: string;
	name: string;
	/** 0-based line of the class name, to tell same-named classes apart. */
	line: number;
}

/**
 * Names in the `extends`/`implements` clauses of a declaration, with their offsets in `text`.
 * `text` starts at the declaration's name; the clause list ends at the first `{` outside any `<...>`/`(...)`.
 * Generic arguments (`Base<T>`) are skipped, `a.B` yields `B`, and call expressions
 * (`extends mixin(Base)`) are ignored because there is no class to follow.
 */
export function heritageNames(text: string): { name: string; offset: number }[] {
	const found: { name: string; offset: number }[] = [];
	let inHeritage = false;
	let depth = 0;
	let candidate: { name: string; offset: number } | undefined;
	const flush = (): void => {
		if (candidate) {
			found.push(candidate);
		}
		candidate = undefined;
	};
	// `=>` is one token so its `>` doesn't close a type-parameter list (`<T extends () => void>`).
	for (const match of text.matchAll(/=>|[A-Za-z_$][\w$]*|[<>(){}[\],.]/g)) {
		const token = match[0];
		const offset = match.index ?? 0;
		if (token === "{" && depth === 0) {
			break; // the class/interface body; a `{` inside `<...>` is an object type and doesn't end the header
		}
		if (token === "<" || token === "(" || token === "{" || token === "[") {
			if (token === "(" && depth === 0) {
				candidate = undefined; // `extends mixin(Base)`
			}
			depth++;
		} else if (token === ">" || token === ")" || token === "}" || token === "]") {
			depth = Math.max(0, depth - 1);
		} else if (depth > 0 || token === "=>") {
			// inside type arguments or call arguments
		} else if (token === ",") {
			flush();
		} else if (token === ".") {
			// qualified name: the last segment replaces the previous one
		} else if (token === "extends" || token === "implements") {
			flush();
			inHeritage = true;
		} else if (inHeritage) {
			candidate = { name: token, offset };
		}
	}
	flush();
	return found;
}

function offsetToPosition(text: string, offset: number): { line: number; character: number } {
	const before = text.slice(0, offset);
	const line = before.split("\n").length - 1;
	return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

/** Where each class named in `node`'s `extends`/`implements` clauses is declared. */
async function heritageTargets(
	client: LspClient,
	workspaceRoot: string,
	relPath: string,
	node: LspSymbol,
): Promise<ClassRef[]> {
	const sel = (node.selectionRange ?? node.range)?.start;
	if (!sel) {
		return [];
	}
	const lines = readTextStrict(path.resolve(workspaceRoot, relPath)).split(LINE_BREAK_RE);
	const startOffset = lines.slice(0, sel.line ?? 0).reduce((sum, l) => sum + l.length + 1, 0) + (sel.character ?? 0);
	const source = lines.join("\n");
	const text = source.slice(startOffset, startOffset + 2000);
	const targets: ClassRef[] = [];
	for (const { name, offset } of heritageNames(text)) {
		const at = offsetToPosition(text, offset);
		const line = (sel.line ?? 0) + at.line;
		const character = at.line === 0 ? (sel.character ?? 0) + at.character : at.character;
		let locations: LspLocation[];
		try {
			locations = await client.definition(relPath, line + 1, character + 1);
		} catch (error) {
			if (!isToolError(error)) {
				throw error;
			}
			continue;
		}
		for (const loc of locations) {
			const uri = loc.uri ?? loc.targetUri ?? "";
			const rng = loc.targetSelectionRange ?? loc.range ?? loc.targetRange;
			const abs = uriToPath(uri);
			// Vendored/library bases (`extends HTMLElement`) have no source worth walking.
			if (!uri || isExcluded(abs, workspaceRoot) || abs.endsWith(".d.ts")) {
				continue;
			}
			targets.push({ uri, name, line: rng?.start?.line ?? 0 });
		}
	}
	return targets;
}

/**
 * `Class.member` where `member` is inherited. Follows `extends`/`implements`
 * clauses breadth-first (resolving each named base with `textDocument/definition`,
 * across files) and returns the first base that declares `member` directly.
 * TypeScript 7's language server has no type hierarchy request, so the
 * clauses are read from the source instead.
 */
async function resolveInherited(
	client: LspClient,
	workspaceRoot: string,
	container: ResolvedSymbol,
	memberName: string,
): Promise<ResolvedSymbol | undefined> {
	const queue: ClassRef[] = [{ uri: container.uri, name: container.name, line: container.line }];
	const seen = new Set<string>([`${container.uri}\0${container.name}\0${container.line}`]);
	while (queue.length > 0 && seen.size <= MAX_CLASSES_VISITED) {
		const current = queue.shift() as ClassRef;
		const relPath = uriToRelative(current.uri, workspaceRoot);
		let members: LspSymbol[];
		let bases: ClassRef[];
		try {
			members = await client.documentSymbol(relPath);
			const node = isHierarchicalDocumentSymbols(members)
				? findNamedNode(members, current.name, current.line)
				: undefined;
			bases = node ? await heritageTargets(client, workspaceRoot, relPath, node) : [];
		} catch (error) {
			if (!isToolError(error)) {
				throw error;
			}
			continue;
		}
		for (const base of bases) {
			const key = `${base.uri}\0${base.name}\0${base.line}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			queue.push(base);
			try {
				const baseMembers = await client.documentSymbol(uriToRelative(base.uri, workspaceRoot));
				if (!isHierarchicalDocumentSymbols(baseMembers)) {
					continue;
				}
				const baseNode = findNamedNode(baseMembers, base.name, base.line);
				const member = (baseNode?.children ?? []).find((c) => String(c.name) === memberName);
				if (member) {
					return resolvedFromHierarchicalNode(memberName, member, base.uri);
				}
			} catch (error) {
				if (!isToolError(error)) {
					throw error;
				}
			}
		}
	}
	return undefined;
}

/**
 * Resolve a name (or dotted `Class.method`) to a single symbol position.
 *
 * Throws `SymbolResolutionError` (a `ToolInputError`) when nothing matches or
 * several symbols tie on an exact name: callers should pass `file_path` to
 * disambiguate rather than guess.
 */
export function resolveSymbol(
	client: LspClient,
	workspaceRoot: string,
	query: string,
	filePath?: string,
): Promise<ResolvedSymbol> {
	return query.includes(".")
		? resolveDotted(client, workspaceRoot, query, filePath)
		: resolveSimple(client, workspaceRoot, query, filePath);
}
