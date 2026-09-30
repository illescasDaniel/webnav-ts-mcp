import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	formatToolError,
	InvalidPositionError,
	isToolError,
	LspRequestError,
	LspTimeoutError,
	ToolInputError,
	Utf8DecodeError,
} from "../src/shared/errors.js";
import { isExcluded } from "../src/shared/exclude.js";
import * as fmt from "../src/shared/format.js";
import type { LspSymbol } from "../src/shared/lspTypes.js";
import { NoticeBoard } from "../src/shared/notices.js";
import { resolveNameQuery } from "../src/shared/params.js";
import { heritageNames } from "../src/shared/resolve.js";
import { readTextStrict } from "../src/shared/text.js";
import { WorkspaceSelector } from "../src/shared/workspace.js";
import { makeTree } from "./helpers.js";

const uri = (p: string): string => pathToFileURL(p).href;
const sym = (name: string, kind: number, file: string, line = 0, col = 0): LspSymbol => ({
	name,
	kind,
	location: { uri: uri(file), range: { start: { line, character: col }, end: { line, character: col + name.length } } },
});

describe("uris and locations", () => {
	it("given a uri under the workspace, when made relative, then forward slashes are used", () => {
		expect(fmt.uriToRelative(uri("/ws/src/a.ts"), "/ws")).toBe("src/a.ts");
	});

	it("given a uri outside the workspace, when made relative, then the absolute path is kept", () => {
		expect(fmt.uriToRelative(uri("/other/a.ts"), "/ws")).toBe("/other/a.ts");
	});

	it("given a location, when formatted, then the header has 1-indexed line and column and a numbered snippet", () => {
		const dir = makeTree({ "a.ts": "one\ntwo\nthree\nfour\nfive\n" });
		const text = fmt.formatLocation(
			{ uri: uri(path.join(dir, "a.ts")), range: { start: { line: 2, character: 1 }, end: { line: 2, character: 3 } } },
			dir,
		);
		expect(text).toBe("a.ts:3:2\n    1 | one\n    2 | two\n    3 | three\n    4 | four\n    5 | five");
	});

	it("given a location link, when formatted, then the selection range wins", () => {
		const dir = makeTree({ "a.ts": "x\ny\n" });
		const text = fmt.formatLocation(
			{
				targetUri: uri(path.join(dir, "a.ts")),
				targetRange: { start: { line: 0, character: 0 } },
				targetSelectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
			},
			dir,
		);
		expect(text.split("\n")[0]).toBe("a.ts:2:1");
	});
});

describe("workspace symbol positions", () => {
	const place = (source: string, name: string, start: [number, number], end?: number): [number, number] => {
		const dir = makeTree({ "a.ts": source });
		const s = {
			name,
			location: {
				uri: uri(path.join(dir, "a.ts")),
				range: { start: { line: start[0], character: start[1] }, end: { line: end ?? start[0] } },
			},
		};
		const [, line, col] = fmt.workspaceSymbolPosition(s);
		return [line, col];
	};

	it("given a range starting at the class keyword, when positioned, then the column lands on the name", () => {
		expect(place("export class Foo {}\n", "Foo", [0, 0])).toEqual([0, 13]);
	});

	it("given a selectionRange, when positioned, then it is used directly", () => {
		expect(
			fmt.workspaceSymbolPosition({
				name: "x",
				location: { uri: "file:///a" },
				selectionRange: { start: { line: 4, character: 2 } },
			}),
		).toEqual(["file:///a", 4, 2]);
	});

	it("given the name is missing from the lines, when positioned, then the range start is returned", () => {
		expect(place("nothing here\n", "Foo", [0, 3])).toEqual([0, 3]);
	});

	it("given a decorator line mentioning the name, when positioned, then the declaration line wins", () => {
		expect(place('@validator("id")\nfunction id() {}\n', "id", [0, 0], 1)).toEqual([1, 9]);
	});

	it("given the name inside a longer identifier, when positioned, then only the whole word matches", () => {
		expect(place("const valid = uuid; const id = 1;\n", "id", [0, 0])).toEqual([0, 26]);
	});

	it("given an astral character before the name, when positioned, then the column counts UTF-16 units", () => {
		expect(place('const s = "😀"; const target = 1;\n', "target", [0, 0])).toEqual([0, 22]);
	});
});

describe("ranking and filtering", () => {
	it("given hits in every tier, when ranked, then exact, case-insensitive, prefix, substring, fuzzy", () => {
		const names = ["xFooBar", "Foo", "FooBar", "foo", "fxoxo"];
		const ranked = fmt
			.rankWorkspaceSymbols(
				names.map((n) => sym(n, 12, "/ws/a.ts")),
				"Foo",
			)
			.map((s) => s.name);
		expect(ranked).toEqual(["Foo", "foo", "FooBar", "xFooBar", "fxoxo"]);
	});

	it("given tests and production hits in one tier, when ranked, then production comes first", () => {
		const ranked = fmt.rankWorkspaceSymbols([sym("run", 12, "/ws/tests/a.ts"), sym("run", 12, "/ws/src/a.ts")], "run");
		expect(ranked.map((s) => s.location?.uri)).toEqual([uri("/ws/src/a.ts"), uri("/ws/tests/a.ts")]);
	});

	it("given properties before a function in a tier, when ranked, then the function is first", () => {
		const ranked = fmt.rankWorkspaceSymbols([sym("go", 7, "/ws/a.ts"), sym("go", 12, "/ws/a.ts")], "go");
		expect(ranked.map((s) => s.kind)).toEqual([12, 7]);
	});

	it("given a function and its export-list variable in one file, when filtered, then the variable is dropped", () => {
		const out = fmt.filterWorkspaceSymbols([
			sym("foo", 12, "/ws/a.ts"),
			sym("foo", 13, "/ws/a.ts"),
			sym("foo", 13, "/ws/b.ts"),
		]);
		expect(out.map((s) => [s.kind, path.basename(fmt.uriToPath(s.location?.uri ?? ""))])).toEqual([
			[12, "a.ts"],
			[13, "b.ts"],
		]);
	});

	it("given duplicate property hits, when filtered, then one remains", () => {
		expect(fmt.filterWorkspaceSymbols([sym("p", 7, "/ws/a.ts"), sym("p", 7, "/ws/a.ts")])).toHaveLength(1);
	});

	it("given kind labels, when parsed, then case-insensitive numbers; unknown labels list the valid ones", () => {
		expect([...(fmt.parseKindFilter("Class, function") ?? [])]).toEqual([5, 12]);
		expect(fmt.parseKindFilter("  ")).toBeUndefined();
		expect(() => fmt.parseKindFilter("bogus")).toThrow(/unknown symbol kind 'bogus'; use one or more of: .*class/);
	});

	it("given kind and path filters, when filtering, then only matching symbols stay (prefix and fnmatch glob)", () => {
		const symbols = [sym("A", 5, "/ws/src/a.ts"), sym("b", 12, "/ws/src/deep/b.ts"), sym("C", 5, "/ws/lib/c.ts")];
		const names = (list: LspSymbol[]): (string | undefined)[] => list.map((s) => s.name);
		expect(names(fmt.filterSymbolsByKindAndPath(symbols, "/ws", { kinds: new Set([5]) }))).toEqual(["A", "C"]);
		expect(names(fmt.filterSymbolsByKindAndPath(symbols, "/ws", { path: "src/" }))).toEqual(["A", "b"]);
		expect(names(fmt.filterSymbolsByKindAndPath(symbols, "/ws", { path: "src/**/*.ts" }))).toEqual(["b"]); // fnmatch: `**/` needs a directory
		expect(names(fmt.filterSymbolsByKindAndPath(symbols, "/ws", { path: "*.ts", kinds: new Set([5]) }))).toEqual([
			"A",
			"C",
		]);
	});

	it("given more hits than the cap, when formatted, then a note names the omitted count", () => {
		const many = Array.from({ length: 5 }, (_, i) => sym(`fn${i}`, 12, "/ws/a.ts", i));
		const text = fmt.formatWorkspaceSymbols(many, "/ws", { query: "fn", limit: 3 });
		expect(text.split("\n")).toHaveLength(4);
		expect(text).toContain("… and 2 more (showing first 3); narrow with kind=… or path=…");
	});

	it("given real and fuzzy hits, when formatted, then fuzzy ones are summarised unless requested", () => {
		const symbols = [sym("Foo", 12, "/ws/a.ts"), sym("fxoxo", 12, "/ws/a.ts")];
		expect(fmt.formatWorkspaceSymbols(symbols, "/ws", { query: "Foo" })).toContain(
			"(1 looser fuzzy match whose names don't contain 'Foo' hidden; pass fuzzy=true to list them)",
		);
		expect(fmt.formatWorkspaceSymbols(symbols, "/ws", { query: "Foo", fuzzy: true })).toContain("fxoxo");
		expect(fmt.formatWorkspaceSymbols([sym("fxoxo", 12, "/ws/a.ts")], "/ws", { query: "Foo" })).toContain("fxoxo");
	});
});

describe("diagnostics formatting", () => {
	it("given no items, then a fixed message", () => {
		expect(fmt.formatDiagnostics([])).toBe("No diagnostics.");
	});

	it("given a code and a multi-line message, when formatted, then the tag has the code and continuations are indented", () => {
		const text = fmt.formatDiagnostic({
			range: { start: { line: 2, character: 4 } },
			severity: 2,
			code: "W1",
			message: "first\nsecond",
		});
		expect(text).toBe("3:5 [warning W1] first\n    second");
	});

	it("given no code, then the tag is the severity only", () => {
		expect(fmt.formatDiagnostic({ range: { start: {} }, severity: 1, message: "m" })).toBe("1:1 [error] m");
	});

	it("given more items than the limit, when formatted, then it caps with a note", () => {
		const items = Array.from({ length: 5 }, (_, i) => ({
			range: { start: { line: i } },
			severity: 1,
			message: `m${i}`,
		}));
		expect(fmt.formatDiagnostics(items, 2)).toBe("1:1 [error] m0\n2:1 [error] m1\n… and 3 more (showing first 2)");
	});
});

describe("references formatting", () => {
	const loc = (file: string, line: number, character = 0) => ({
		uri: uri(file),
		range: { start: { line, character } },
	});

	it("given locations, when grouped, then per-file lines are sorted and counted", () => {
		const text = fmt.formatReferencesGrouped(
			[loc("/ws/b.ts", 4), loc("/ws/a.ts", 9), loc("/ws/a.ts", 1), loc("/ws/a.ts", 1)],
			"/ws",
		);
		expect(text).toBe("3 reference(s) in 2 file(s):\na.ts: L2, L10\nb.ts: L5");
	});

	it("given more files than the limit, when grouped, then the omission is noted", () => {
		const locs = ["a", "b", "c"].map((f) => loc(`/ws/${f}.ts`, 0));
		expect(fmt.formatReferencesGrouped(locs, "/ws", { fileLimit: 2 })).toContain("… and 1 more file(s)");
	});

	it("given hits over the snippet limit, when formatted, then the compact list with columns is used", () => {
		const locs = Array.from({ length: 3 }, (_, i) => loc("/ws/a.ts", i, i));
		expect(fmt.formatReferences(locs, "/ws", 2)).toBe(
			"(compact list: 3 > 2 hits)\n3 reference(s) in 1 file(s):\na.ts: L1:1, L2:2, L3:3",
		);
	});

	it("given no locations, then each formatter has its own message", () => {
		expect(fmt.formatReferences([], "/ws")).toBe("No references found at that position.");
		expect(fmt.formatReferencesGrouped([], "/ws")).toBe("No references found.");
	});
});

describe("outline", () => {
	const ds = (name: string, kind: number, s: number, e: number, children: LspSymbol[] = []): LspSymbol => ({
		name,
		kind,
		range: { start: { line: s }, end: { line: e } },
		selectionRange: { start: { line: s } },
		children,
	});

	it("given hierarchical symbols in alphabetical order, when formatted, then source order with spans", () => {
		const text = fmt.formatOutline([
			ds("Zed", 5, 10, 20, [ds("b", 6, 15, 16), ds("a", 6, 11, 11)]),
			ds("Alpha", 12, 0, 4),
		]);
		expect(text).toBe("Alpha  [Function]  :1-5\nZed  [Class]  :11-21\n  a  [Method]  :12\n  b  [Method]  :16-17");
	});

	it("given locals inside a function, when collapsed, then they are hidden but class members stay", () => {
		const symbols = [ds("fn", 12, 0, 5, [ds("local", 13, 1, 1)]), ds("K", 5, 6, 9, [ds("m", 6, 7, 8)])];
		expect(fmt.formatOutline(symbols, { collapseKinds: fmt.LOCALS_HOLDER_KINDS })).toBe(
			"fn  [Function]  :1-6\nK  [Class]  :7-10\n  m  [Method]  :8-9",
		);
		expect(fmt.formatOutline(symbols)).toContain("local  [Variable]");
	});

	it("given flat symbol information, when normalised, then nesting follows range containment", () => {
		const flat = [
			sym("Inner", 6, "/ws/a.ts", 2),
			{
				...sym("Outer", 5, "/ws/a.ts", 0),
				location: { uri: uri("/ws/a.ts"), range: { start: { line: 0 }, end: { line: 5 } } },
			},
		];
		expect(fmt.formatOutline(flat)).toBe("Outer  [Class]  :1-6\n  Inner  [Method]  :3");
	});

	it("given no symbols, then a message", () => {
		expect(fmt.formatOutline([])).toBe("No symbols found.");
		expect(fmt.isHierarchicalDocumentSymbols([])).toBe(false);
	});
});

describe("errors and params", () => {
	it("given each expected failure, when formatted, then the text is actionable", () => {
		expect(formatToolError(new LspRequestError("textDocument/hover", -1, "boom"))).toBe(
			"LSP error on textDocument/hover: boom",
		);
		expect(formatToolError(new LspTimeoutError("x"))).toContain("timed out");
		expect(formatToolError(new InvalidPositionError("line 9 is out of range"))).toBe("line 9 is out of range");
		expect(formatToolError(new Utf8DecodeError("bad"))).toBe("Cannot read file as UTF-8 text: bad.");
	});

	it("given a filesystem error, when formatted, then missing files and spawn failures read differently", () => {
		const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/x/a.ts'"), {
			code: "ENOENT",
			syscall: "open",
			path: "/x/a.ts",
		});
		expect(formatToolError(missing)).toBe(
			"File not found: /x/a.ts (relative paths resolve against the workspace root).",
		);
		const spawn = Object.assign(new Error("spawn node ENOENT"), {
			code: "ENOENT",
			syscall: "spawn node",
			path: "node",
		});
		expect(formatToolError(spawn)).toMatch(/^Cannot start language server \(file not found\)/);
		expect(isToolError(missing)).toBe(true);
		expect(isToolError(new TypeError("bug"))).toBe(false);
	});

	it("given name/query aliases, when resolved, then the preferred wins and the alias is the fallback", () => {
		expect(resolveNameQuery({ preferred: "name", example: "X", params: { name: "a", query: "b" } })).toBe("a");
		expect(resolveNameQuery({ preferred: "name", example: "X", params: { name: undefined, query: "b" } })).toBe("b");
	});

	it("given neither, when resolved, then the hint names the preferred param and the alias", () => {
		expect(() => resolveNameQuery({ preferred: "name", example: "Foo", params: { query: undefined } })).toThrow(
			new ToolInputError("Pass `name` (e.g. name='Foo'); `query` is accepted as an alias."),
		);
	});
});

describe("text and excludes", () => {
	it("given invalid utf-8, when read strictly, then it throws; a BOM is preserved", () => {
		const dir = makeTree();
		fs.writeFileSync(path.join(dir, "bad.txt"), Buffer.from([0x61, 0xff]));
		fs.writeFileSync(path.join(dir, "bom.txt"), Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
		expect(() => readTextStrict(path.join(dir, "bad.txt"))).toThrow(Utf8DecodeError);
		expect(readTextStrict(path.join(dir, "bom.txt"))).toBe("﻿a");
	});

	it("given a path under an excluded directory name, then it is excluded", () => {
		expect(isExcluded("/ws/node_modules/x/a.js", "/ws")).toBe(true);
		expect(isExcluded("/ws/src/a.js", "/ws")).toBe(false);
	});
});

describe("notice board", () => {
	it("given posted notices, when annotating, then they are appended once and drained", () => {
		const board = new NoticeBoard("webnav", []);
		board.post("restarted");
		board.post("restarted");
		expect(board.annotate("result")).toBe("result\n\n[webnav] restarted");
		expect(board.annotate("result")).toBe("result");
	});

	it("given the server's own source changing, when annotating, then a sticky stale-code notice appears", () => {
		const dir = makeTree({ "a.js": "1" });
		const board = new NoticeBoard("webnav", [dir], 0);
		expect(board.annotate("r")).toBe("r");
		fs.writeFileSync(path.join(dir, "a.js"), "22");
		const text = board.annotate("r");
		expect(text).toContain("the webnav server's own code changed since it started");
		expect(board.annotate("r")).toContain("own code changed");
	});
});

describe("workspace selection", () => {
	it("given the pinned env var, when selecting, then client roots are ignored", async () => {
		const dir = makeTree();
		process.env.WEBNAV_TEST_WS = dir;
		try {
			const selector = new WorkspaceSelector("WEBNAV_TEST_WS");
			const chosen = await selector.select(async () => [uri(makeTree())]);
			expect(chosen).toEqual({ root: dir, source: "WEBNAV_TEST_WS" });
			expect(selector.explain(chosen.source)).toBe("pinned by $WEBNAV_TEST_WS; client roots are ignored");
		} finally {
			delete process.env.WEBNAV_TEST_WS;
		}
	});

	it("given an unrelated client root, when selecting, then the configured base is kept", async () => {
		const base = makeTree();
		process.env.WEBNAV_TEST_BASE = base;
		delete process.env.WEBNAV_TEST_WS;
		const saved = process.env.CLAUDE_PROJECT_DIR;
		process.env.CLAUDE_PROJECT_DIR = base;
		try {
			const selector = new WorkspaceSelector("WEBNAV_TEST_WS");
			const chosen = await selector.select(async () => [uri(makeTree())]);
			expect(chosen.root).toBe(base);
			expect(chosen.source).toBe("CLAUDE_PROJECT_DIR");
			expect((await selector.select(async () => [uri(base)])).source).toBe("client roots");
		} finally {
			delete process.env.WEBNAV_TEST_BASE;
			if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
			else process.env.CLAUDE_PROJECT_DIR = saved;
		}
	});

	it("given a failing roots provider, when selecting, then the base is kept", async () => {
		const selector = new WorkspaceSelector("WEBNAV_TEST_WS");
		const chosen = await selector.select(async () => {
			throw new Error("no roots");
		});
		expect(chosen.root).toBe(selector.base);
	});
});

describe("heritage clauses", () => {
	const names = (text: string): string[] => heritageNames(text).map((h) => h.name);

	it("given extends and implements, when parsed, then every base is listed in order with its offset", () => {
		const text = "Widget extends Base implements A, B {\n}";
		expect(heritageNames(text)).toEqual([
			{ name: "Base", offset: text.indexOf("Base") },
			{ name: "A", offset: text.indexOf("A,") },
			{ name: "B", offset: text.indexOf("B {") },
		]);
	});

	it("given generics, when parsed, then type arguments and constraints are not mistaken for bases", () => {
		expect(names("Box<T extends Item> extends Base<Map<string, Item>> implements Sized<T> {")).toEqual([
			"Base",
			"Sized",
		]);
	});

	it("given an object type inside type parameters, when parsed, then the bases after it are still found", () => {
		expect(names("Foo<T extends { a: number }, U extends () => void> extends Base implements Sized<T> {")).toEqual([
			"Base",
			"Sized",
		]);
		expect(names("Foo extends Base<{ a: 1 }> {\n\tx = { extends: Other };\n}")).toEqual(["Base"]);
	});

	it("given a qualified name, when parsed, then the last segment is the base", () => {
		expect(names("A extends ns.sub.Base {")).toEqual(["Base"]);
	});

	it("given a mixin call, when parsed, then it is skipped since there is no class to follow", () => {
		expect(names("A extends mixin(Base, Other) {")).toEqual([]);
	});

	it("given an interface extending several, when parsed, then all are listed; a class without heritage has none", () => {
		expect(names("Shape extends A, B {")).toEqual(["A", "B"]);
		expect(names("Plain {\n\tmethod() {}\n}")).toEqual([]);
	});

	it("given braces after the header, when parsed, then the body's words are ignored", () => {
		expect(names("A extends B { x = 1; extends = 2; }")).toEqual(["B"]);
	});
});
