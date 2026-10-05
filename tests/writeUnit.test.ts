/** Pure parts of the write tools: edit plans, the journal, import rewriting, token finding, snippet fitting. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { candidatePaths, findDependents, specifiersIn } from "../src/write/deps.js";
import { diffDiagnostics, entriesFromLsp, isSyntaxError } from "../src/write/diagnosticsDelta.js";
import {
	applyEdits,
	createChange,
	deleteChange,
	detectEol,
	EditPlan,
	lineStarts,
	modifyChange,
	offsetToPosition,
	parseWorkspaceEdit,
	positionToOffset,
	readSource,
} from "../src/write/edits.js";
import { addImport, parseImports, removeBinding, removeStatement, renderImport } from "../src/write/jsImports.js";
import { findMentions } from "../src/write/mentions.js";
import { declaredName, detectIndentUnit, fitSnippet } from "../src/write/symbolLookup.js";
import { removeDeclaration } from "../src/write/symbolTools.js";
import { EditJournal, PlanStore, WriteGuard } from "../src/write/transaction.js";
import { findTokenEdits, parseToken } from "../src/write/webTokens.js";
import { makeTree } from "./helpers.js";

const rename = (file: string, text: string, token: string, to: string) => {
	const parsed = parseToken(token);
	if (!parsed) throw new Error("bad token");
	const found = findTokenEdits(file, text, parsed, parsed.kind === "var" ? to : to.replace(/^[.#]/, ""));
	return { ...found, result: applyEdits(text, found.edits) };
};

describe("positions and edits", () => {
	it("given CRLF, CR and LF line breaks, when converting positions, then LSP line rules apply", () => {
		const text = "ab\r\ncd\refg\nh";
		expect(lineStarts(text)).toEqual([0, 4, 7, 11]);
		expect(positionToOffset(text, 1, 1)).toBe(5);
		expect(positionToOffset(text, 0, 99)).toBe(2);
		expect(positionToOffset(text, 9, 0)).toBe(text.length);
		expect(offsetToPosition(text, 8)).toEqual({ line: 2, character: 1 });
	});

	it("given edits, when applied out of order and with duplicates, then the result is as if applied together", () => {
		const out = applyEdits("0123456789", [
			{ start: 6, end: 8, newText: "X" },
			{ start: 1, end: 2, newText: "" },
			{ start: 1, end: 2, newText: "" },
		]);
		expect(out).toBe("02345X89");
	});

	it("given overlapping edits, when applied, then it refuses", () => {
		expect(() =>
			applyEdits("0123456789", [
				{ start: 1, end: 5, newText: "a" },
				{ start: 3, end: 6, newText: "b" },
			]),
		).toThrow(/overlap/);
	});

	it("given a mostly-CRLF text, when detecting its ending, then CRLF is reported", () => {
		expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
		expect(detectEol("a\nb\n")).toBe("\n");
		expect(detectEol("single")).toBe("\n");
	});

	it("given a changed file, when summarising and diffing a plan, then lines show what changed", () => {
		const root = "/ws";
		const plan = new EditPlan("t", [
			modifyChange(
				"/ws/a.ts",
				"one\ntwo\nthree\nfour\nfive\nsix\nseven\n",
				"one\ntwo\nTHREE\nfour\nfive\nsix\nseven\n",
			),
			createChange("/ws/b.ts", "x\n"),
			deleteChange("/ws/c.ts", "y\nz\n"),
		]);
		expect(plan.summary(root)).toBe("  M a.ts (+1 -1)\n  A b.ts (+1 -0)\n  D c.ts (+0 -2)");
		const diff = plan.diff(root);
		expect(diff).toContain("-three\n+THREE");
		expect(diff).toContain("--- b.ts\n@@ -1 +1 @@\n+x");
		expect(new EditPlan("t", [modifyChange("/ws/a.ts", "same", "same")]).isEmpty).toBe(true);
	});

	it("given a long diff, when capped, then the cut is announced", () => {
		const plan = new EditPlan("t", [createChange("/ws/a.ts", `${"line\n".repeat(50)}`)]);
		expect(plan.diff("/ws", 10)).toContain("more diff line(s) not shown");
	});
});

describe("WorkspaceEdit parsing", () => {
	it("given changes and documentChanges, when parsed, then edits are per file with offsets and renames apart", () => {
		const dir = makeTree({ "a.ts": "let abc = 1;\n", "b.ts": "x\n" });
		const uri = (name: string) => `file://${path.join(dir, name)}`;
		const parsed = parseWorkspaceEdit({
			changes: {
				[uri("a.ts")]: [{ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, newText: "z" }],
			},
			documentChanges: [
				{
					textDocument: { uri: uri("b.ts") },
					edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "y" }],
				},
				{ kind: "rename", oldUri: uri("a.ts"), newUri: uri("c.ts") },
				{ kind: "delete", uri: uri("b.ts") },
			],
		});
		expect([...parsed.edits.values()].map((e) => e[0]?.newText).sort()).toEqual(["y", "z"]);
		expect(parsed.edits.get(path.join(dir, "a.ts"))?.[0]).toMatchObject({ start: 4, end: 7 });
		expect(parsed.renames).toHaveLength(1);
		expect(parsed.other).toEqual([`delete ${path.join(dir, "b.ts")}`]);
	});
});

describe("write guard", () => {
	const guard = (root: string, extra = {}) => new WriteGuard({ root, ...extra });

	it("given paths outside the rules, when checked, then each is refused with its reason", () => {
		const root = makeTree({ "src/a.ts": "", "node_modules/p/i.js": "", "README.md": "" });
		const g = guard(root);
		expect(() => g.checkPath(path.join(root, "src/a.ts"))).not.toThrow();
		expect(() => g.checkPath(path.join(root, "src/new/dir/x.css"))).not.toThrow();
		expect(() => g.checkPath(path.join(root, "../outside.ts"))).toThrow(/outside the workspace/);
		expect(() => g.checkPath(path.join(root, "node_modules/p/i.js"))).toThrow(/node_modules/);
		expect(() => g.checkPath(path.join(root, "README.md"))).toThrow(/only edit/);
		expect(() => g.checkPath(path.join(root, "README.md"), { anySuffix: true })).not.toThrow();
	});

	it("given a symlink, when checked, then it is refused whether it points in or out", () => {
		const root = makeTree({ "src/a.ts": "" });
		const outside = makeTree({ "o.ts": "" });
		fs.symlinkSync(path.join(outside, "o.ts"), path.join(root, "src/link.ts"));
		fs.symlinkSync(path.join(root, "src/a.ts"), path.join(root, "src/alias.ts"));
		expect(() => guard(root).checkPath(path.join(root, "src/link.ts"))).toThrow(/symbolic link/);
		expect(() => guard(root).checkPath(path.join(root, "src/alias.ts"))).toThrow(/symbolic link/);
	});

	it("given a forbidden predicate and read-only mode, when checked, then both are honoured", () => {
		const root = makeTree({ "gen/a.js": "" });
		const g = guard(root, {
			isForbidden: (p: string) => (p.includes("/gen/") ? "is generated" : undefined),
			readOnly: true,
		});
		expect(() => g.checkPath(path.join(root, "gen/a.js"))).toThrow(/is generated/);
		expect(() => g.checkWritable()).toThrow(/disabled/);
	});
});

describe("edit journal", () => {
	function setup(files: Record<string, string>) {
		const root = makeTree(files);
		const g = new WriteGuard({ root });
		return { root, journal: new EditJournal(g), file: (n: string) => path.join(root, n) };
	}

	it("given a plan, when applied and undone, then files go there and back, keeping CRLF and BOM", () => {
		const { journal, file } = setup({ "a.ts": "﻿a\r\nb\r\n" });
		const { text, bom } = readSource(file("a.ts"));
		expect(bom).toBe(true);
		const plan = new EditPlan("t", [
			modifyChange(file("a.ts"), text, "A\r\nb\r\n", bom),
			createChange(file("new/dir/n.ts"), "n\n"),
		]);
		const entry = journal.apply(plan);
		expect(fs.readFileSync(file("a.ts"), "utf8")).toBe("﻿A\r\nb\r\n");
		expect(fs.readFileSync(file("new/dir/n.ts"), "utf8")).toBe("n\n");
		journal.undo(entry.id);
		expect(fs.readFileSync(file("a.ts"), "utf8")).toBe("﻿a\r\nb\r\n");
		expect(fs.existsSync(file("new"))).toBe(false);
	});

	it("given a file changed after the preview, when applying, then nothing is written", () => {
		const { journal, file } = setup({ "a.ts": "one", "b.ts": "two" });
		const plan = new EditPlan("t", [
			modifyChange(file("a.ts"), "one", "ONE"),
			modifyChange(file("b.ts"), "two", "TWO"),
		]);
		fs.writeFileSync(file("b.ts"), "changed");
		expect(() => journal.apply(plan)).toThrow(/b\.ts changed since the preview/);
		expect(fs.readFileSync(file("a.ts"), "utf8")).toBe("one");
	});

	it("given an edit applied and then touched, when undoing, then it refuses to overwrite later work", () => {
		const { journal, file } = setup({ "a.ts": "one" });
		journal.apply(new EditPlan("t", [modifyChange(file("a.ts"), "one", "two")]));
		fs.writeFileSync(file("a.ts"), "three");
		expect(() => journal.undo()).toThrow(/changed after the edit/);
		expect(fs.readFileSync(file("a.ts"), "utf8")).toBe("three");
	});

	it("given a write that fails part-way, when applying, then files already written are restored", () => {
		const { journal, file } = setup({ "a.ts": "one", "b.ts": "two" });
		// `b.ts` is a file, so a new file "inside" it can pass verification but cannot be written.
		const plan = new EditPlan("t", [modifyChange(file("a.ts"), "one", "ONE"), createChange(file("b.ts/x.ts"), "x")]);
		expect(() => journal.apply(plan)).toThrow();
		expect(fs.readFileSync(file("a.ts"), "utf8")).toBe("one");
		expect(fs.readFileSync(file("b.ts"), "utf8")).toBe("two");
	});

	it("given a move, when applied and undone, then content and location round-trip", () => {
		const { journal, file } = setup({ "a.ts": "export {}\n", "other.png": "PNG" });
		const entry = journal.apply(
			new EditPlan("t", [
				{
					path: file("sub/a.ts"),
					kind: "rename",
					oldText: "export {}\n",
					newText: "export const x = 1\n",
					oldBom: false,
					newBom: false,
					renamedFrom: file("a.ts"),
				},
				{
					path: file("img/other.png"),
					kind: "rename",
					oldText: undefined,
					newText: undefined,
					oldBom: false,
					newBom: false,
					renamedFrom: file("other.png"),
				},
			]),
		);
		expect(fs.existsSync(file("a.ts"))).toBe(false);
		expect(fs.readFileSync(file("sub/a.ts"), "utf8")).toBe("export const x = 1\n");
		expect(fs.readFileSync(file("img/other.png"), "utf8")).toBe("PNG");
		journal.undo(entry.id);
		expect(fs.readFileSync(file("a.ts"), "utf8")).toBe("export {}\n");
		expect(fs.readFileSync(file("other.png"), "utf8")).toBe("PNG");
		expect(fs.existsSync(file("sub"))).toBe(false);
	});

	it("given more files than the large-edit limit, when applying, then allow_large is required", () => {
		const files = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`f${i}.ts`, "a"]));
		const { journal, file } = setup(files);
		const plan = new EditPlan(
			"t",
			Object.keys(files).map((n) => modifyChange(file(n), "a", "b")),
		);
		expect(() => journal.apply(plan)).toThrow(/allow_large/);
		expect(() => journal.apply(plan, { allowLarge: true })).not.toThrow();
	});

	it("given read-only mode, when applying, then it refuses", () => {
		const root = makeTree({ "a.ts": "x" });
		const journal = new EditJournal(new WriteGuard({ root, readOnly: true }));
		expect(() => journal.apply(new EditPlan("t", [modifyChange(path.join(root, "a.ts"), "x", "y")]))).toThrow(
			/disabled/,
		);
	});

	it("given the plan store, when asking for an unknown id, then the error says what to do", () => {
		const store = new PlanStore();
		const id = store.add(new EditPlan("t", []));
		expect(store.get(id).description).toBe("t");
		store.discard(id);
		expect(() => store.get(id)).toThrow(/No pending preview/);
	});
});

describe("diagnostics delta", () => {
	const item = (line: number, message: string, severity = 1, code: string | number = 2322) => ({
		range: { start: { line, character: 0 }, end: { line, character: 1 } },
		severity,
		code,
		message,
	});

	it("given an error that only moved lines, when diffed, then it is not new", () => {
		const before = entriesFromLsp("a.ts", "x\nlet a: string = 1;\n", [item(1, "bad")]);
		const after = entriesFromLsp("a.ts", "new\nx\nlet a: string = 1;\n", [item(2, "bad")]);
		const delta = diffDiagnostics(before, after);
		expect(delta.newErrors).toEqual([]);
		expect(delta.fixedErrors).toEqual([]);
	});

	it("given an old error on a line the edit rewrote, when diffed, then it is still the same error", () => {
		const before = entriesFromLsp("a.ts", "import { a } from './x.ts';\n", [item(0, "extension not allowed", 1, 5097)]);
		const after = entriesFromLsp("a.ts", "import { b } from './x.ts';\n", [item(0, "extension not allowed", 1, 5097)]);
		const delta = diffDiagnostics(before, after);
		expect(delta.newErrors).toEqual([]);
		expect(delta.fixedErrors).toEqual([]);
	});

	it("given new and fixed errors, warnings and hints, when diffed, then each lands in its bucket and hints vanish", () => {
		const before = entriesFromLsp("a.ts", "a\nb\n", [item(0, "old error"), item(1, "hint", 4, 6133)]);
		const after = entriesFromLsp("a.ts", "a\nb\n", [
			item(0, "new error"),
			item(1, "warn", 2, 1),
			item(1, "hint2", 4, 6133),
		]);
		const delta = diffDiagnostics(before, after);
		expect(delta.newErrors.map((e) => e.message)).toEqual(["new error"]);
		expect(delta.fixedErrors.map((e) => e.message)).toEqual(["old error"]);
		expect(delta.newWarnings.map((e) => e.message)).toEqual(["warn"]);
	});

	it("given parse errors, when classified, then TS 1xxx and CSS errors count as syntax", () => {
		const [ts] = entriesFromLsp("a.ts", "x", [item(0, "';' expected", 1, 1005)]);
		const [tsType] = entriesFromLsp("a.ts", "x", [item(0, "type", 1, 2322)]);
		const [css] = entriesFromLsp("a.css", "x", [item(0, "} expected", 1, "css-rcurlyexpected")]);
		expect([ts, tsType, css].map((e) => e && isSyntaxError(e))).toEqual([true, false, true]);
	});
});

describe("import statements", () => {
	it("given varied imports, when parsed, then bindings, style and positions are recovered", () => {
		const text = [
			'// import { fake } from "x";',
			'import def, { a, b as c, type T } from "./m";',
			"import * as ns from './n'",
			'import "./side-effect";',
			'import type { Only } from "./types";',
			'export { a as z } from "./m";',
			"export * from './all';",
			"const s = import('./dyn');",
		].join("\n");
		const found = parseImports(text);
		expect(found.map((s) => [s.kind, s.specifier])).toEqual([
			["import", "./m"],
			["import", "./n"],
			["import", "./side-effect"],
			["import", "./types"],
			["export", "./m"],
			["export", "./all"],
		]);
		expect(found[0]).toMatchObject({ defaultName: "def", quote: '"', semicolon: true });
		expect(found[0]?.named).toEqual([
			{ name: "a", local: "a", typeOnly: false },
			{ name: "b", local: "c", typeOnly: false },
			{ name: "T", local: "T", typeOnly: true },
		]);
		expect(found[1]).toMatchObject({ namespaceName: "ns", quote: "'", semicolon: false });
		expect(found[3]?.typeOnly).toBe(true);
		expect(found[5]?.starExport).toBe(true);
	});

	it("given an existing import of the module, when adding a name, then it is merged, not duplicated", () => {
		const text = 'import { a } from "./m";\nconsole.log(a);\n';
		expect(addImport(text, { specifier: "./m", named: [{ name: "b", local: "b", typeOnly: false }] })).toBe(
			'import { a, b } from "./m";\nconsole.log(a);\n',
		);
		expect(addImport(text, { specifier: "./m", named: [{ name: "a", local: "a", typeOnly: false }] })).toBe(text);
	});

	it("given no import of the module, when adding, then it follows the last import in the file's own style", () => {
		const text = "import {a} from './m'\nimport x from './x'\n\ncode();\n";
		expect(addImport(text, { specifier: "./n", named: [{ name: "n", local: "n", typeOnly: false }] })).toBe(
			"import {a} from './m'\nimport x from './x'\nimport {n} from './n'\n\ncode();\n",
		);
	});

	it("given a file without imports, when adding, then it goes below the header comment and use-strict", () => {
		const text = '#!/usr/bin/env node\n"use strict";\n// header\n\nrun();\n';
		const out = addImport(text, { specifier: "./n", named: [{ name: "n", local: "n", typeOnly: false }] });
		expect(out).toBe('#!/usr/bin/env node\n"use strict";\n// header\n\nimport { n } from "./n";\n\nrun();\n');
		expect(addImport("", { specifier: "./n", defaultName: "n" })).toBe('import n from "./n";\n');
	});

	it("given a multi-line import, when a binding is removed, then the layout stays multi-line", () => {
		const text = 'import {\n\ta,\n\tb,\n\tc,\n} from "./m";\n';
		const stmt = parseImports(text)[0];
		expect(stmt?.multiline).toBe(true);
		expect(removeBinding(text, stmt as NonNullable<typeof stmt>, "b")).toBe('import {\n\ta,\n\tc,\n} from "./m";\n');
	});

	it("given the last binding, when removed, then the whole statement and its line go", () => {
		const text = 'import { a } from "./m";\nkeep();\n';
		expect(removeBinding(text, parseImports(text)[0] as never, "a")).toBe("keep();\n");
		const mixed = 'import def, { a } from "./m";\n';
		expect(removeBinding(mixed, parseImports(mixed)[0] as never, "a")).toBe('import def from "./m";\n');
		expect(removeStatement("a\r\nb\r\n", { start: 0, end: 1 })).toBe("b\r\n");
	});

	it("given a re-export, when rendered, then it keeps its own form", () => {
		const [stmt] = parseImports('export type { T } from "./t";\n');
		expect(renderImport(stmt as never, { quote: '"', semicolon: true, spacedBraces: true })).toBe(
			'export type { T } from "./t";',
		);
	});
});

describe("import resolution", () => {
	it("given specifiers in several syntaxes, when scanned, then all are found", () => {
		const text = 'import a from "./a"; export * from "./b"; const c = require("./c"); import("./d"); import "./e";';
		expect(specifiersIn(text).sort()).toEqual(["./a", "./b", "./c", "./d", "./e"]);
	});

	it("given a specifier, when resolved, then the .js-for-.ts, extensionless and index forms are candidates", () => {
		const c = candidatePaths("/p/src/x.ts", "./lib/util.js");
		expect(c).toContain("/p/src/lib/util.ts");
		expect(candidatePaths("/p/src/x.ts", "./lib")).toContain("/p/src/lib/index.ts");
		expect(candidatePaths("/p/src/x.ts", "react")).toEqual([]);
	});

	it("given a tree, when asking for importers, then only direct importers are returned", () => {
		const root = makeTree({
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts": 'import { a } from "./a.js";\n',
			"src/c.ts": 'import { b } from "./b";\n',
			"src/sub/d.ts": 'import "../a";\n',
			"node_modules/p/e.ts": 'import "../../src/a";\n',
		});
		expect(findDependents(root, [path.join(root, "src/a.ts")]).map((f) => path.relative(root, f))).toEqual([
			"src/b.ts",
			"src/sub/d.ts",
		]);
	});
});

describe("snippets", () => {
	it("given indented code with an unindented first line, when fitted, then relative nesting is kept", () => {
		expect(fitSnippet("f() {\n    return 1;\n}\n", "\t", "\t")).toBe("\tf() {\n\t\treturn 1;\n\t}");
		expect(fitSnippet("\n\n    a\n      b\n\n", "  ", "  ")).toBe("  a\n    b");
	});

	it("given a tab-indented file, when a two-space snippet is fitted, then its levels become tabs", () => {
		expect(fitSnippet("if (a) {\n  b();\n  if (c) {\n    d();\n  }\n}", "", "\t")).toBe(
			"if (a) {\n\tb();\n\tif (c) {\n\t\td();\n\t}\n}",
		);
	});

	it("given files in different styles, when detecting the indent unit, then it matches", () => {
		expect(detectIndentUnit("a\n\tb\n\t\tc\n")).toBe("\t");
		expect(detectIndentUnit("a\n    b\n        c\n")).toBe("    ");
		expect(detectIndentUnit("a\n  b\n")).toBe("  ");
		expect(detectIndentUnit("a\nb\n")).toBe("  ");
	});

	it("given snippets, when asking the declared name, then keywords, modifiers and members are understood", () => {
		expect(declaredName("export async function foo() {}")).toBe("foo");
		expect(declaredName("/** doc */\n@dec()\nexport default class K {}")).toBe("K");
		expect(declaredName("export const x = 1;")).toBe("x");
		expect(declaredName("interface I { a: string }")).toBe("I");
		expect(declaredName("private static async load(): void {}")).toBe("load");
		expect(declaredName("get value() { return 1; }")).toBe("value");
		expect(declaredName("name: string;")).toBe("name");
	});

	it("given a declaration, when removed, then blank lines collapse around it", () => {
		const text = "a();\n\nfunction f() {}\n\nb();\n";
		const start = text.indexOf("function");
		expect(removeDeclaration(text, start, start + "function f() {}".length)).toBe("a();\n\nb();\n");
		const last = "a();\n\nfunction f() {}\n";
		const s2 = last.indexOf("function");
		expect(removeDeclaration(last, s2, s2 + "function f() {}".length)).toBe("a();\n");
		const first = "function f() {}\n\nb();\n";
		expect(removeDeclaration(first, 0, "function f() {}".length)).toBe("b();\n");
		const crlf = "a();\r\n\r\nfunction f() {}\r\n\r\nb();\r\n";
		const s3 = crlf.indexOf("function");
		expect(removeDeclaration(crlf, s3, s3 + "function f() {}".length)).toBe("a();\r\n\r\nb();\r\n");
	});
});

describe("web token renaming", () => {
	it("given custom properties in CSS, when renamed, then declarations, var() and @property change but not longer names or comments", () => {
		const css = "/* --a: 1 */\n:root { --a: 1; --a-long: 2; --b: var(--a, red); }\n@property --a { syntax: '*'; }\n";
		const r = rename("s.css", css, "--a", "--z");
		expect(r.result).toBe(
			"/* --a: 1 */\n:root { --z: 1; --a-long: 2; --b: var(--z, red); }\n@property --z { syntax: '*'; }\n",
		);
	});

	it("given class selectors in CSS, when renamed, then only selector positions change", () => {
		const css =
			".card, div.card:hover > .card-title, [data-x='.card'] { margin: .5em; }\n.card .a { color: red }\n@media (min-width: 1px) { .card { x: 1 } }\n/* .card */\n";
		const r = rename("s.css", css, ".card", ".tile");
		expect(r.result).toBe(
			".tile, div.tile:hover > .card-title, [data-x='.card'] { margin: .5em; }\n.tile .a { color: red }\n@media (min-width: 1px) { .tile { x: 1 } }\n/* .card */\n",
		);
	});

	it("given HTML, when renaming an id, then id, for, aria and fragment references follow, and classes do not", () => {
		const html = [
			'<!-- <div id="x"> -->',
			'<label for="x">L</label><input id="x" aria-describedby="y x" class="x">',
			'<a href="#x">go</a><a href="#xy">no</a><svg><use xlink:href="#x"/></svg><rect fill="url(#x)"/>',
			'<p data-id="x"></p>',
		].join("\n");
		const r = rename("i.html", html, "#x", "#w");
		expect(r.result).toContain('<label for="w">L</label><input id="w" aria-describedby="y w" class="x">');
		expect(r.result).toContain(
			'<a href="#w">go</a><a href="#xy">no</a><svg><use xlink:href="#w"/></svg><rect fill="url(#w)"/>',
		);
		expect(r.result).toContain('data-id="x"');
		expect(r.result).toContain('<!-- <div id="x"> -->');
	});

	it("given HTML with style and script blocks, when renaming a class, then each language's rules apply", () => {
		const html = [
			"<style>.btn { color: red } .btn-big { x: 1 }</style>",
			'<button class="btn btn-big other">x</button>',
			"<script>document.querySelector('.btn').classList.add('btn', 'x');</script>",
		].join("\n");
		const r = rename("i.html", html, ".btn", "button");
		expect(r.result).toBe(
			[
				"<style>.button { color: red } .btn-big { x: 1 }</style>",
				'<button class="button btn-big other">x</button>',
				"<script>document.querySelector('.button').classList.add('button', 'x');</script>",
			].join("\n"),
		);
	});

	it("given scripts, when renaming a class, then the known DOM APIs, className and markup strings follow", () => {
		const js = [
			"el.classList.add('on', 'sel'); el.classList.toggle(\"sel\");",
			"el.className = 'row sel';",
			"el.className += ' sel';",
			'const html = `<div class="sel x"></div>`;',
			"document.querySelectorAll('li.sel, #sel');",
			"const mode = 'sel';",
			"el.classList.add('sel-' + n);",
			"el.classList.add(`sel-$" + "{n}`);",
			"// el.classList.add('sel')",
		].join("\n");
		const r = rename("a.js", js, ".sel", "chosen");
		expect(r.result).toBe(
			[
				"el.classList.add('on', 'chosen'); el.classList.toggle(\"chosen\");",
				"el.className = 'row chosen';",
				"el.className += ' chosen';",
				'const html = `<div class="chosen x"></div>`;',
				"document.querySelectorAll('li.chosen, #sel');",
				"const mode = 'sel';",
				"el.classList.add('sel-' + n);",
				"el.classList.add(`sel-$" + "{n}`);",
				"// el.classList.add('sel')",
			].join("\n"),
		);
		expect(r.literals).toHaveLength(1);
		expect(js.slice(r.literals[0]?.start, r.literals[0]?.end)).toBe("sel");
	});

	it("given ids in scripts, when renamed, then getElementById and selectors follow and dynamic prefixes are only reported", () => {
		const js =
			"document.getElementById('main');\ndocument.getElementById('main' + n);\ndocument.querySelector(`#main-$" +
			"{n}`);\nquery('#main');\n";
		const r = rename("a.ts", js, "#main", "#root");
		expect(r.result).toBe(
			"document.getElementById('root');\ndocument.getElementById('main' + n);\ndocument.querySelector(`#main-$" +
				"{n}`);\nquery('#main');\n",
		);
		expect(r.dynamic.length).toBeGreaterThanOrEqual(1);
	});

	it("given custom properties in scripts, when renamed, then only string contents change, not decrements", () => {
		const js =
			"el.style.setProperty('--w', '1');\nconst v = getComputedStyle(el).getPropertyValue(\"--w\");\nlet n = 3; --n;\nconst css = `width: var(--w); --w: 2`;\n";
		const r = rename("a.js", js, "--w", "--wide");
		expect(r.result).toBe(
			"el.style.setProperty('--wide', '1');\nconst v = getComputedStyle(el).getPropertyValue(\"--wide\");\nlet n = 3; --n;\nconst css = `width: var(--wide); --wide: 2`;\n",
		);
	});

	it("given JSX and template nesting, when renaming a class, then className attributes follow and braces do not derail the scan", () => {
		const tsx =
			'const a = <div className="k j">{items.map((i) => <b className={`k $' +
			"{i}`}>x</b>)}</div>;\nel.classList.add('k');\n";
		const r = rename("a.tsx", tsx, ".k", "kk");
		expect(r.result).toContain('className="kk j"');
		expect(r.result).toContain("classList.add('kk')");
	});

	it("given a raw token, when parsed, then kinds are recognised", () => {
		expect(parseToken("--x")).toEqual({ kind: "var", name: "--x" });
		expect(parseToken("#id")).toEqual({ kind: "id", name: "id" });
		expect(parseToken(".c")).toEqual({ kind: "class", name: "c" });
		expect(parseToken("Cart.total")).toBeUndefined();
		expect(parseToken("--")).toBeUndefined();
	});
});

describe("mentions", () => {
	it("given a tree, when searching a name, then whole-word hits are listed and skippable", () => {
		const root = makeTree({
			"a.ts": "const foo = 1;\n// foo here\nfoobar();\nfoo-bar\n",
			"docs/readme.md": "use foo\n",
			"node_modules/x/i.js": "foo\n",
		});
		const all = findMentions(root, "foo");
		expect(all.mentions.map((m) => `${m.file}:${m.line}`)).toEqual(["a.ts:1", "a.ts:2", "docs/readme.md:1"]);
		const skipped = findMentions(root, "foo", (file, line) => file.endsWith("a.ts") && line === 1);
		expect(skipped.total).toBe(2);
	});

	it("given a git work tree with ignored output and minified files, when searching, then only source is listed", () => {
		const root = makeTree({
			".gitignore": "site/\n",
			"a.ts": "foo\n",
			"site/page.html": "foo\n",
			"static/app.min.js": "foo\n",
		});
		execFileSync("git", ["init", "-q"], { cwd: root });
		expect(findMentions(root, "foo").mentions.map((m) => m.file)).toEqual(["a.ts"]);
	});

	it("given a workspace inside a directory its repository ignores, when searching, then the tree is walked", () => {
		const outer = makeTree({ ".gitignore": "ws/\n", "ws/a.ts": "foo\n" });
		execFileSync("git", ["init", "-q"], { cwd: outer });
		expect(findMentions(path.join(outer, "ws"), "foo").mentions.map((m) => m.file)).toEqual(["a.ts"]);
	});
});
