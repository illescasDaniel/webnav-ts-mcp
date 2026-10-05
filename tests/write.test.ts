/** The write tools against real language servers (TypeScript 7 `tsc --lsp`, vscode HTML/CSS) and temporary projects. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Webnav } from "../src/webnav.js";
import { makeTree } from "./helpers.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/sample-app");
const T = 60_000;

const TSCONFIG = JSON.stringify({
	compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", target: "es2022", noEmit: true },
	include: ["src"],
});

let ws: string;
let webnav: Webnav;
const savedEnv = { ...process.env };

function useWorkspace(env: Record<string, string> = {}): Webnav {
	Object.assign(process.env, { WEBNAV_MCP_WORKSPACE: ws, ...env });
	webnav = new Webnav();
	return webnav;
}

/** The sample app (JS + TS + HTML + CSS). */
function startSample(env: Record<string, string> = {}): Webnav {
	ws = makeTree();
	fs.cpSync(fixture, ws, { recursive: true });
	return useWorkspace(env);
}

/** A project with a tsconfig and the given files. */
function startProject(files: Record<string, string>, env: Record<string, string> = {}): Webnav {
	ws = makeTree({ "tsconfig.json": TSCONFIG, ...files });
	return useWorkspace(env);
}

const read = (rel: string): string => fs.readFileSync(path.join(ws, rel), "utf8");
const exists = (rel: string): boolean => fs.existsSync(path.join(ws, rel));
const idOf = (text: string, prefix: "e" | "p"): string => {
	const found = new RegExp(`(${prefix}-[0-9a-f]{6})`).exec(text)?.[1];
	if (!found) throw new Error(`no ${prefix}- id in:\n${text}`);
	return found;
};

beforeEach(() => {
	for (const key of ["WEBNAV_MCP_ROOTS", "WEBNAV_MCP_EXCLUDE", "WEBNAV_MCP_READ_ONLY"]) delete process.env[key];
});

afterEach(async () => {
	await webnav?.dispose();
	for (const key of Object.keys(process.env)) {
		if (!(key in savedEnv)) delete process.env[key];
	}
	Object.assign(process.env, savedEnv);
});

describe("edit", () => {
	it(
		"given a CRLF file with a stretch of LF line endings, when editing it, then the stretch as written still matches",
		async () => {
			const w = startProject({
				"src/a.ts":
					"export const a = 1;\r\nexport const b = 2;\r\nexport const e = 5;\r\nexport const c = 3;\nexport const d = 4;\n",
			});
			await w.edit({ filePath: "src/a.ts", oldString: "c = 3;\nexport const d", newString: "c = 30;\nexport const d" });
			expect(read("src/a.ts")).toBe(
				"export const a = 1;\r\nexport const b = 2;\r\nexport const e = 5;\r\nexport const c = 30;\nexport const d = 4;\n",
			);
			await w.edit({ filePath: "src/a.ts", oldString: "a = 1;\nexport const b", newString: "a = 10;\nexport const b" });
			expect(read("src/a.ts")).toContain("a = 10;\r\nexport const b");
		},
		T,
	);

	it(
		"given a clean replacement, when applied, then the file is written, checked, and undo restores it",
		async () => {
			const w = startSample();
			const text = await w.edit({
				filePath: "src/app.ts",
				oldString: "export const afterEmoji = 1;",
				newString: "export const afterEmoji = 2;",
			});
			expect(text).toContain("Applied as edit");
			expect(text).toContain("0 new errors");
			expect(text).toContain("After writing: no errors in the edited files.");
			expect(read("src/app.ts")).toContain("afterEmoji = 2;");
			const undone = await w.undoEdit(idOf(text, "e"));
			expect(undone).toContain("Reverted edit");
			expect(read("src/app.ts")).toContain("afterEmoji = 1;");
		},
		T,
	);

	it(
		"given an edit that breaks an importer, when applied, then nothing is written until apply_edit accepts it",
		async () => {
			const w = startSample();
			const text = await w.edit({
				filePath: "src/shapes.ts",
				oldString: "export function totalArea(",
				newString: "export function totalAreas(",
			});
			expect(text).toContain("NOT applied: 2 new errors");
			expect(text).toContain("src/fancy.ts:1:10 [error 2724]");
			expect(read("src/shapes.ts")).toContain("export function totalArea(");
			const applied = await w.applyEdit(idOf(text, "p"));
			expect(applied).toContain("Applied edit");
			expect(read("src/shapes.ts")).toContain("totalAreas(");
		},
		T,
	);

	it(
		"given max_new_errors, when the new errors stay within it, then the edit is written",
		async () => {
			const w = startSample();
			const text = await w.edit({
				filePath: "src/shapes.ts",
				oldString: "export function totalArea(",
				newString: "export function totalAreas(",
				maxNewErrors: 2,
			});
			expect(text).toContain("Applied as edit");
			expect(text).toContain("2 new errors");
		},
		T,
	);

	it(
		"given text that does not parse, when applied with no error limit, then it is still refused",
		async () => {
			const w = startSample();
			const text = await w.edit({
				filePath: "src/app.ts",
				oldString: "export const afterEmoji = 1;",
				newString: "export const afterEmoji = ;;(",
				maxNewErrors: null,
			});
			expect(text).toContain("would not parse");
			expect(read("src/app.ts")).toContain("afterEmoji = 1;");
		},
		T,
	);

	it(
		"given a CRLF file, when edited with LF text, then the line endings stay CRLF",
		async () => {
			const w = startProject({ "src/a.ts": "export const a = 1;\r\nexport const b = 2;\r\n" });
			const text = await w.edit({
				filePath: "src/a.ts",
				oldString: "export const a = 1;\nexport const b = 2;",
				newString: "export const a = 10;\nexport const c = 3;",
			});
			expect(text).toContain("Applied as edit");
			expect(read("src/a.ts")).toBe("export const a = 10;\r\nexport const c = 3;\r\n");
		},
		T,
	);

	it(
		"given new_text for a missing file, when applied, then the file and its folders are created and undo removes them",
		async () => {
			const w = startProject({ "src/a.ts": "export const a = 1;\n" });
			const text = await w.edit({
				filePath: "src/deep/b.ts",
				newText: 'import { a } from "../a";\nexport const b = a + 1;\n',
			});
			expect(text).toContain("Create src/deep/b.ts");
			expect(text).toContain("Applied as edit");
			expect(exists("src/deep/b.ts")).toBe(true);
			await w.undoEdit();
			expect(exists("src/deep")).toBe(false);
		},
		T,
	);

	it(
		"given an old_string that is missing or ambiguous, when editing, then the message says why",
		async () => {
			const w = startProject({ "src/a.ts": "const x = 1;\nconst y = 1;\nconst z = 2;\n" });
			expect(await w.edit({ filePath: "src/a.ts", oldString: "const q = 1;", newString: "x" })).toBe(
				"old_string was not found in src/a.ts.",
			);
			expect(await w.edit({ filePath: "src/a.ts", oldString: "const x = 1;\nconst z = 2;", newString: "x" })).toContain(
				"Its first line does appear",
			);
			expect(await w.edit({ filePath: "src/a.ts", oldString: "= 1;", newString: "= 3;" })).toBe(
				"old_string matches 2 times in src/a.ts; make it unique or pass replace_all=true.",
			);
			const all = await w.edit({ filePath: "src/a.ts", oldString: "= 1;", newString: "= 3;", replaceAll: true });
			expect(all).toContain("(2 replacements)");
			expect(read("src/a.ts")).toBe("const x = 3;\nconst y = 3;\nconst z = 2;\n");
		},
		T,
	);

	it(
		"given a preview and a file that changed afterwards, when applying it, then it refuses and writes nothing",
		async () => {
			const w = startProject({ "src/a.ts": "export const a = 1;\n" });
			const preview = await w.edit({ filePath: "src/a.ts", oldString: "a = 1", newString: "a = 2", apply: false });
			expect(preview).toContain("Preview only, nothing written.");
			expect(preview).toContain("-export const a = 1;\n+export const a = 2;");
			expect(read("src/a.ts")).toBe("export const a = 1;\n");
			fs.writeFileSync(path.join(ws, "src/a.ts"), "export const a = 99;\n");
			expect(await w.applyEdit(idOf(preview, "p"))).toContain("changed since the preview");
			expect(read("src/a.ts")).toBe("export const a = 99;\n");
		},
		T,
	);

	it(
		"given files the tools must not write, when editing them, then each refusal names the rule",
		async () => {
			const w = startProject(
				{
					"src/a.ts": "export {};\n",
					"README.md": "# hi\n",
					"node_modules/p/i.js": "x\n",
					"dist/out.js": "x\n",
				},
				{ WEBNAV_MCP_EXCLUDE: "dist" },
			);
			const edit = (filePath: string) => w.edit({ filePath, newText: "export {};\n" });
			expect(await edit("README.md")).toContain("only edit");
			expect(await edit("node_modules/p/i.js")).toContain("node_modules/");
			expect(await edit("dist/out.js")).toContain("inside 'dist/'");
			expect(await edit("../outside.ts")).toContain("outside the workspace");
		},
		T,
	);

	it(
		"given generated output (WEBNAV_MCP_EXCLUDE) outside the usual folders, when editing it, then it is refused",
		async () => {
			const w = startProject({ "gen/a.js": "export const a = 1;\n" }, { WEBNAV_MCP_EXCLUDE: "gen" });
			expect(await w.edit({ filePath: "gen/a.js", oldString: "1", newString: "2" })).toContain("generated output");
			expect(read("gen/a.js")).toBe("export const a = 1;\n");
		},
		T,
	);

	it(
		"given WEBNAV_MCP_READ_ONLY, when editing, then it previews, and apply_edit and undo_edit refuse",
		async () => {
			const w = startProject({ "src/a.ts": "export const a = 1;\n" }, { WEBNAV_MCP_READ_ONLY: "1" });
			const text = await w.edit({ filePath: "src/a.ts", oldString: "a = 1", newString: "a = 2" });
			expect(text).toContain("NOT applied: writes are disabled");
			expect(read("src/a.ts")).toBe("export const a = 1;\n");
			expect(await w.applyEdit(idOf(text, "p"))).toContain("writes are disabled");
			expect(await w.undoEdit()).toContain("writes are disabled");
		},
		T,
	);

	it(
		"given CSS and HTML, when edited, then their servers check them: broken CSS is refused, valid HTML goes through",
		async () => {
			const w = startSample();
			const bad = await w.edit({
				filePath: "styles.css",
				oldString: ".widget {",
				newString: ".widget {{{",
				maxNewErrors: null,
			});
			expect(bad).toContain("would not parse");
			expect(read("styles.css")).toContain(".widget {\n");
			const good = await w.edit({
				filePath: "index.html",
				oldString: '<h1 class="title">Hi</h1>',
				newString: '<h1 class="title">Hello</h1>',
			});
			expect(good).toContain("Applied as edit");
			expect(read("index.html")).toContain("Hello");
		},
		T,
	);

	it(
		"given a parameter-less call, when editing, then hints come back as text",
		async () => {
			const w = startProject({});
			expect(await w.edit({})).toBe("`file_path` is required.");
			expect(await w.edit({ filePath: "src/a.ts" })).toContain("pass new_text");
			expect(await w.edit({ filePath: "src/a.ts", newText: "x", oldString: "y" })).toContain("not both");
		},
		T,
	);
});

describe("edit_symbol", () => {
	const SHOP = [
		'import { fmt } from "./fmt";',
		"",
		"/** A cart. */",
		"export class Cart {",
		"\tprivate items: number[] = [];",
		"",
		"\ttotal(): number {",
		"\t\treturn this.items.reduce((a, b) => a + b, 0);",
		"\t}",
		"",
		"\tlabel(): string {",
		"\t\treturn fmt(this.total());",
		"\t}",
		"}",
		"",
		"/** Doubles a number. */",
		"export function double(n: number): number {",
		"\treturn n * 2;",
		"}",
		"",
		"export const LIMIT = 10;",
		"",
	].join("\n");
	const FMT = "export function fmt(n: number): string {\n\treturn `$${n}`;\n}\n";

	it(
		"given a method, when replaced with space-indented source, then it keeps the file's tabs, place and doc comment",
		async () => {
			const w = startProject({ "src/shop.ts": SHOP, "src/fmt.ts": FMT });
			const text = await w.editSymbol({
				action: "replace",
				name: "Cart.total",
				source: "total(): number {\n  return this.items.length === 0 ? 0 : this.items.reduce((a, b) => a + b);\n}",
			});
			expect(text).toContain("Applied as edit");
			expect(read("src/shop.ts")).toContain(
				"\ttotal(): number {\n\t\treturn this.items.length === 0 ? 0 : this.items.reduce((a, b) => a + b);\n\t}\n\n\tlabel()",
			);
			const doc = await w.editSymbol({
				action: "replace",
				name: "double",
				source: "function double(n: number): number {\n  return n + n;\n}",
			});
			expect(doc).toContain("Applied as edit");
			expect(read("src/shop.ts")).toContain(
				"/** Doubles a number. */\nfunction double(n: number): number {\n\treturn n + n;\n}",
			);
		},
		T,
	);

	it(
		"given a replacement, when it brings its own doc comment or drops decorators and changes the name, then notes say so",
		async () => {
			const w = startProject({ "src/shop.ts": SHOP, "src/fmt.ts": FMT });
			const text = await w.editSymbol({
				action: "replace",
				name: "double",
				source: "/** Triples. */\nexport function triple(n: number): number {\n  return n * 3;\n}",
				apply: false,
			});
			expect(text).toContain("the definition is now called triple; references to double are NOT updated");
			expect(text).toContain("+/** Triples. */");
			expect(text).toContain("-/** Doubles a number. */");
		},
		T,
	);

	it(
		"given a replacement that changes a signature used elsewhere, when applied, then the call-site errors block it",
		async () => {
			const w = startProject({ "src/shop.ts": SHOP, "src/fmt.ts": FMT });
			const text = await w.editSymbol({
				action: "replace",
				name: "fmt",
				source: "export function fmt(n: number, cur: string): string {\n  return cur + n;\n}",
			});
			expect(text).toContain("NOT applied");
			expect(text).toContain("signature changed");
			expect(text).toContain("src/shop.ts:12");
		},
		T,
	);

	it(
		"given insert positions, when used, then code lands after, before, into and at the end with spacing and imports",
		async () => {
			const w = startProject({ "src/shop.ts": SHOP, "src/fmt.ts": FMT });
			await w.editSymbol({
				action: "insert",
				filePath: "src/shop.ts",
				name: "Cart.total",
				source: "count(): number {\n  return this.items.length;\n}",
			});
			expect(read("src/shop.ts")).toContain(
				"\t\treturn this.items.reduce((a, b) => a + b, 0);\n\t}\n\n\tcount(): number {\n\t\treturn this.items.length;\n\t}\n\n\tlabel()",
			);
			await w.editSymbol({
				action: "insert",
				filePath: "src/shop.ts",
				name: "double",
				position: "before",
				source: "export function half(n: number): number {\n  return n / 2;\n}",
			});
			expect(read("src/shop.ts")).toContain(
				"}\n\nexport function half(n: number): number {\n\treturn n / 2;\n}\n\n/** Doubles a number. */\nexport function double",
			);
			await w.editSymbol({
				action: "insert",
				filePath: "src/shop.ts",
				name: "Cart",
				position: "into",
				source: "clear(): void {\n  this.items = [];\n}",
			});
			expect(read("src/shop.ts")).toContain(
				"\t\treturn fmt(this.total());\n\t}\n\n\tclear(): void {\n\t\tthis.items = [];\n\t}\n}\n",
			);
			const end = await w.editSymbol({
				action: "insert",
				filePath: "src/shop.ts",
				source: "export const dollars = (n: number): string => money(n);",
				imports: ['import { money } from "./money";'],
			});
			expect(end).toContain("Cannot find module './money'");
			await w.editSymbol({
				action: "insert",
				filePath: "src/shop.ts",
				source: "export const dollars = (n: number): string => fmt(n);",
				imports: ['import { fmt } from "./fmt";'],
			});
			const finalText = read("src/shop.ts");
			expect(finalText.startsWith('import { fmt } from "./fmt";\n')).toBe(true);
			expect(finalText.match(/import \{ fmt \}/g)).toHaveLength(1);
			expect(finalText.endsWith("export const dollars = (n: number): string => fmt(n);\n")).toBe(true);
		},
		T,
	);

	it(
		"given a name that already exists, when inserting, then it refuses and points to replace",
		async () => {
			const w = startProject({ "src/shop.ts": SHOP, "src/fmt.ts": FMT });
			const text = await w.editSymbol({
				action: "insert",
				filePath: "src/shop.ts",
				source: "export const LIMIT = 11;",
			});
			expect(text).toContain("already defines 'LIMIT'");
			expect(
				await w.editSymbol({
					action: "insert",
					filePath: "src/shop.ts",
					position: "into",
					name: "LIMIT",
					source: "x(): void {}",
				}),
			).toContain("needs a class");
			expect(
				await w.editSymbol({ action: "insert", filePath: "src/shop.ts", position: "end", name: "Cart", source: "x" }),
			).toContain("drop `name`");
		},
		T,
	);

	it(
		"given a used symbol, when deleting, then the users are listed; unused ones are removed with their now-dead imports",
		async () => {
			const w = startProject({
				"src/shop.ts": SHOP,
				"src/fmt.ts": FMT,
				"src/use.ts":
					'import { double } from "./shop";\nimport { fmt } from "./fmt";\nexport const a = double(2);\nexport function show(): string {\n\treturn fmt(a);\n}\n',
			});
			const refused = await w.editSymbol({ action: "delete", name: "double" });
			expect(refused).toContain("still used in 1 place(s); nothing was changed");
			expect(refused).toContain("src/use.ts");
			const removed = await w.editSymbol({ action: "delete", name: "show" });
			expect(removed).toContain("Applied as edit");
			expect(read("src/use.ts")).toBe('import { double } from "./shop";\nexport const a = double(2);\n');
			expect(removed).toContain("removed imports that only the deleted code used: fmt");
			const label = await w.editSymbol({ action: "delete", name: "Cart.label" });
			expect(label).toContain("Applied as edit");
			expect(read("src/shop.ts")).not.toContain("import { fmt }");
			expect(read("src/shop.ts")).toContain("\t}\n}\n");
		},
		T,
	);

	it(
		"given an import statement whose every binding only the deleted code used, when deleting, then the statement goes",
		async () => {
			const w = startProject({
				"src/util.ts": "export const a = 1;\nexport const b = 2;\n",
				"src/main.ts":
					'import { a, b } from "./util";\n\nexport function keep() {\n\treturn 1;\n}\n\nexport function gone() {\n\treturn a + b;\n}\n',
			});
			const text = await w.editSymbol({ action: "delete", name: "gone" });
			expect(text).toContain("removed imports that only the deleted code used: a, b");
			expect(read("src/main.ts")).toBe("export function keep() {\n\treturn 1;\n}\n");
		},
		T,
	);

	it(
		"given force, when deleting a used symbol, then it is deleted and the breakage shown",
		async () => {
			const w = startProject({
				"src/shop.ts": SHOP,
				"src/fmt.ts": FMT,
				"src/use.ts": 'import { double } from "./shop";\nexport const a = double(2);\n',
			});
			const text = await w.editSymbol({ action: "delete", name: "double", force: true });
			expect(text).toContain("NOT applied");
			expect(text).toContain("deleted although 1 place(s) still use it");
			expect(text).toContain("src/use.ts:1:10");
		},
		T,
	);

	it(
		"given a name mentioned in a string or doc, when deleting, then it previews instead of applying",
		async () => {
			const w = startProject({
				"src/shop.ts": SHOP,
				"src/fmt.ts": FMT,
				"docs.md": "call `double` for twice the fun\n",
			});
			const text = await w.editSymbol({ action: "delete", name: "double" });
			expect(text).toContain("Previewed instead of applied");
			expect(text).toContain("docs.md:1");
			expect(read("src/shop.ts")).toContain("export function double");
		},
		T,
	);

	it(
		"given a variable among several declarators, when replaced, then it points to edit",
		async () => {
			const w = startProject({ "src/a.ts": "export const a = 1, b = 2;\nexport const c = 3;\n" });
			expect(await w.editSymbol({ action: "replace", name: "b", source: "const b = 5;" })).toContain(
				"shares its declaration",
			);
			const ok = await w.editSymbol({ action: "replace", name: "c", source: "export const c = 30;" });
			expect(ok).toContain("Applied as edit");
			expect(read("src/a.ts")).toBe("export const a = 1, b = 2;\nexport const c = 30;\n");
		},
		T,
	);

	it(
		"given wrong arguments, when calling, then each mistake gets a one-line answer",
		async () => {
			const w = startProject({ "src/a.ts": "export const c = 3;\n" });
			expect(await w.editSymbol({})).toContain("unknown action");
			expect(await w.editSymbol({ action: "replace", name: "c" })).toContain("needs `name` and `source`");
			expect(await w.editSymbol({ action: "delete", name: "c", source: "x" })).toBe(
				'`source` do not apply to action="delete".',
			);
			expect(await w.editSymbol({ action: "replace", name: "nothere", source: "const nothere = 1;" })).toContain(
				"No symbol found",
			);
		},
		T,
	);
});

describe("rename_symbol: JS/TS", () => {
	it(
		"given an interface method, when renamed, then every implementation and call follows across files",
		async () => {
			const w = startSample();
			const text = await w.renameSymbol({ name: "Shape.area", newName: "surface" });
			expect(text).toContain("Rename area -> surface (Shape.area)");
			expect(text).toContain("Applied as edit");
			const shapes = read("src/shapes.ts");
			expect(shapes).toContain("surface(): number;");
			expect(shapes).toContain("abstract surface(): number;");
			expect(shapes).toContain("this.surface()");
			expect(shapes).not.toMatch(/\barea\(/);
			expect(shapes).toContain("totalArea"); // a different identifier is untouched
		},
		T,
	);

	it(
		"given a class, when renamed with preview, then the diff shows declarations and heritage clauses and nothing is written",
		async () => {
			const w = startSample();
			const text = await w.renameSymbol({ name: "Base", newName: "Root", apply: false });
			expect(text).toContain("Rename Base -> Root (Base): 2 edit(s) in 1 file(s)");
			expect(text).toContain("-export class Base {\n+export class Root {");
			expect(read("src/app.ts")).toContain("class Base");
		},
		T,
	);

	it(
		"given a parameter, when renamed by function name, then its uses follow but a same-named variable elsewhere does not",
		async () => {
			const w = startProject({
				"src/a.ts": "export function f(count: number): number {\n\treturn count + 1;\n}\nexport const count = 5;\n",
			});
			const text = await w.renameSymbol({ name: "f", parameter: "count", newName: "n" });
			expect(text).toContain("(f(count))");
			expect(read("src/a.ts")).toBe(
				"export function f(n: number): number {\n\treturn n + 1;\n}\nexport const count = 5;\n",
			);
			expect(await w.renameSymbol({ name: "f", parameter: "zzz", newName: "n" })).toContain("has no parameter");
		},
		T,
	);

	it(
		"given a position, when renamed, then file_path with line and column addresses the symbol",
		async () => {
			const w = startProject({ "src/a.ts": "export const alpha = 1;\nexport const beta = alpha + 1;\n" });
			const text = await w.renameSymbol({ filePath: "src/a.ts", line: 2, column: 22, newName: "first" });
			expect(text).toContain("Rename alpha -> first");
			expect(read("src/a.ts")).toBe("export const first = 1;\nexport const beta = first + 1;\n");
		},
		T,
	);

	it(
		"given bad names and bad targets, when renaming, then each is refused in one line",
		async () => {
			const w = startProject({ "src/a.ts": "export const alpha = 1;\nconsole.log(alpha);\n" });
			expect(await w.renameSymbol({ name: "alpha", newName: "class" })).toContain("not a valid JavaScript identifier");
			expect(await w.renameSymbol({ name: "alpha", newName: "alpha" })).toContain("same as the current name");
			expect(await w.renameSymbol({ name: "alpha" })).toBe("`new_name` is required.");
			expect(await w.renameSymbol({ newName: "x" })).toContain("give `name`");
			expect(await w.renameSymbol({ filePath: "src/a.ts", line: 2, column: 3, newName: "x" })).toContain(
				"cannot be renamed here",
			);
			expect(await w.renameSymbol({ name: "nothere", newName: "x" })).toContain("No symbol found");
		},
		T,
	);

	it(
		"given a rename that collides with an existing name, when applied, then the type check blocks it",
		async () => {
			const w = startProject({
				"src/a.ts": "export const alpha = 1;\nexport const beta = 2;\nexport const sum = alpha + beta;\n",
			});
			const text = await w.renameSymbol({ name: "alpha", newName: "beta" });
			expect(text).toMatch(/NOT applied|nothing to rename|already/);
			expect(read("src/a.ts")).toContain("const alpha");
		},
		T,
	);

	it(
		"given the old name in a string and a doc, when renaming, then they are listed, not edited",
		async () => {
			const w = startProject({
				"src/a.ts": "export function loadUser(): void {}\nloadUser();\nconst msg = 'call loadUser first';\n",
				"README.md": "Use loadUser() to start.\n",
			});
			const text = await w.renameSymbol({ name: "loadUser", newName: "fetchUser" });
			expect(text).toContain("'loadUser' still appears in 2 place(s)");
			expect(text).toContain("README.md:1");
			expect(read("src/a.ts")).toContain("'call loadUser first'");
			expect(read("README.md")).toBe("Use loadUser() to start.\n");
		},
		T,
	);
});

describe("rename_symbol: CSS custom properties, ids and classes", () => {
	it(
		"given a custom property, when renamed, then CSS, inline style, HTML and script usages all follow",
		async () => {
			const w = startSample();
			const text = await w.renameSymbol({ name: "--accent", newName: "--brand" });
			expect(text).toContain("Rename --accent -> --brand: 4 edit(s) in 3 file(s)");
			expect(read("styles.css")).toContain("--brand: #06c;");
			expect(read("styles.css")).toContain("color: var(--brand);");
			expect(read("index.html")).toContain('style="color: var(--brand)"');
			expect(read("src/util.js")).toContain('getPropertyValue("--brand")');
			expect(read("styles.css")).not.toContain("--accent");
		},
		T,
	);

	it(
		"given a class, when renamed, then selectors, class attributes, classList and querySelector follow; other classes do not",
		async () => {
			const w = startSample();
			await w.renameSymbol({ name: ".widget", newName: "gadget" });
			expect(read("styles.css")).toContain(".gadget {");
			expect(read("styles.css")).toContain(".gadget .title {");
			expect(read("index.html")).toContain('class="gadget is-active"');
			expect(read("src/app.ts")).toContain('classList.add("gadget", "is-active")');
			expect(read("src/app.ts")).toContain('querySelector<HTMLElement>(".gadget .title")');
			expect(read("styles.css")).toContain(".unused-class {");
		},
		T,
	);

	it(
		"given an id, when renamed, then CSS, markup and getElementById follow; a string literal and a dynamic id are only reported",
		async () => {
			const w = startSample();
			const text = await w.renameSymbol({ name: "#btn-save", newName: "btn-store", apply: false });
			expect(text).toContain('1 script string literal(s) equal "btn-save" were left alone');
			expect(text).toContain("src/util.js:19");
			const withLiterals = await w.renameSymbol({
				name: "#btn-save",
				newName: "#btn-store",
				includeStringLiterals: true,
			});
			expect(withLiterals).toContain("Applied as edit");
			expect(read("src/util.js")).toContain('onClick("btn-store"');
			expect(read("index.html")).toContain('id="btn-store"');
			const dynamic = await w.renameSymbol({ name: "#view-home", newName: "#view-start", apply: false });
			expect(dynamic).toContain("build the name dynamically");
			expect(dynamic).toContain('id="view-start"');
		},
		T,
	);

	it(
		"given the new name already exists or an invalid one, when renaming, then it is refused unless forced",
		async () => {
			const w = startSample();
			expect(await w.renameSymbol({ name: ".widget", newName: "title" })).toContain("already exists");
			expect(await w.renameSymbol({ name: "--bg", newName: "--accent" })).toContain("already exists");
			expect(await w.renameSymbol({ name: ".widget", newName: "#x" })).toContain("must start with '.'");
			expect(await w.renameSymbol({ name: ".widget", newName: "9x" })).toContain("not a valid class name");
			expect(await w.renameSymbol({ name: "--bg", newName: "--bad name" })).toContain("not a valid custom property");
			expect(await w.renameSymbol({ name: ".nope", newName: "yes" })).toBe("No occurrences of .nope found.");
			const forced = await w.renameSymbol({ name: "--bg", newName: "--accent", force: true, apply: false });
			expect(forced).toContain("Preview only");
		},
		T,
	);

	it(
		"given several roots with the same token, when renaming without file_path, then it asks which root; with it, only that root changes",
		async () => {
			const w = startProject(
				{
					"app/a.css": ":root { --c: red; }\n.x { color: var(--c); }\n",
					"design/b.css": ":root { --c: blue; }\n.x { color: var(--c); }\n",
				},
				{ WEBNAV_MCP_ROOTS: "app=app,design=design" },
			);
			expect(await w.renameSymbol({ name: "--c", newName: "--k" })).toContain("appears in several roots (app, design)");
			const text = await w.renameSymbol({ name: "--c", newName: "--k", filePath: "design/b.css" });
			expect(text).toContain("(root design)");
			expect(read("design/b.css")).toBe(":root { --k: blue; }\n.x { color: var(--k); }\n");
			expect(read("app/a.css")).toBe(":root { --c: red; }\n.x { color: var(--c); }\n");
		},
		T,
	);

	it(
		"given generated output holding the token, when renaming, then those files are listed but not edited",
		async () => {
			const w = startProject(
				{
					"a.css": ".k { color: red; }\n",
					"gen/a.js": "el.classList.add('k');\n",
					"page.html": '<p class="k">x</p>\n',
				},
				{ WEBNAV_MCP_EXCLUDE: "gen" },
			);
			const text = await w.renameSymbol({ name: ".k", newName: "kk" });
			expect(text).toContain("not edited (generated output");
			expect(read("gen/a.js")).toBe("el.classList.add('k');\n");
			expect(read("a.css")).toBe(".kk { color: red; }\n");
		},
		T,
	);

	it(
		"given the class used by another template language, when renaming, then those files are listed as mentions",
		async () => {
			const w = startProject({
				"a.css": ".k { color: red; }\n",
				"View.vue": '<template><p class="k">x</p></template>\n',
			});
			const text = await w.renameSymbol({ name: ".k", newName: "kk" });
			expect(text).toContain("View.vue:1");
			expect(read("View.vue")).toContain('class="k"');
		},
		T,
	);
});

describe("move: files", () => {
	const PROJECT = {
		"src/util.ts":
			'import { helper } from "./lib";\nexport const LIMIT = 10;\nexport function double(x: number): number {\n\treturn helper(x) * 2 + LIMIT;\n}\n',
		"src/lib.ts": "export function helper(x: number): number {\n\treturn x;\n}\n",
		"src/ui/view.ts":
			'import { double } from "../util";\nimport { helper } from "../lib";\nexport const v = double(helper(1));\n',
		"src/main.ts": 'import { double } from "./util.js";\nexport { double };\n',
		"public/index.html":
			'<!doctype html>\n<link rel="stylesheet" href="../src/theme.css">\n<script type="module" src="../src/main.ts"></script>\n<script type="module" src="/src/util.ts"></script>\n<script src="https://cdn.example/x.js"></script>\n',
		"src/theme.css": '@import "./base.css";\nbody { background: url(../public/bg.png); }\n',
		"src/base.css": "a { color: red; }\n",
		"public/bg.png": "PNG",
	};

	it(
		"given a module, when moved, then imports, re-exports and HTML script tags follow and its own imports are re-based",
		async () => {
			const w = startProject(PROJECT);
			const text = await w.move({ filePath: "src/util.ts", toFile: "src/core/util.ts" });
			expect(text).toContain("Applied as edit");
			expect(text).toContain("0 new errors");
			expect(exists("src/util.ts")).toBe(false);
			expect(read("src/core/util.ts")).toContain('import { helper } from "../lib";');
			expect(read("src/ui/view.ts")).toContain('import { double } from "../core/util";');
			expect(read("src/main.ts")).toContain('import { double } from "./core/util.js";');
			expect(read("public/index.html")).toContain('src="/src/core/util.ts"');
			expect(read("public/index.html")).toContain('src="../src/main.ts"');
			expect(read("public/index.html")).toContain("https://cdn.example/x.js");
			await w.undoEdit();
			expect(read("src/util.ts")).toContain("export const LIMIT");
			expect(exists("src/core")).toBe(false);
			expect(read("src/ui/view.ts")).toContain('from "../util"');
		},
		T,
	);

	it(
		"given a stylesheet, when moved, then HTML links follow and its own @import and url() are re-based",
		async () => {
			const w = startProject(PROJECT);
			const text = await w.move({ filePath: "src/theme.css", toFile: "src/styles/theme.css" });
			expect(text).toContain("Applied as edit");
			expect(read("public/index.html")).toContain('href="../src/styles/theme.css"');
			expect(read("src/styles/theme.css")).toBe(
				'@import "../base.css";\nbody { background: url(../../public/bg.png); }\n',
			);
		},
		T,
	);

	it(
		"given a non-text asset, when moved into a directory, then bytes and the stylesheet reference follow",
		async () => {
			const w = startProject(PROJECT);
			const text = await w.move({ filePath: "public/bg.png", toFile: "public/img/" });
			expect(text).toContain("Applied as edit");
			expect(read("public/img/bg.png")).toBe("PNG");
			expect(read("src/theme.css")).toContain("url(../public/img/bg.png)");
		},
		T,
	);

	it(
		"given a move onto an existing file, a directory or a missing file, when called, then it refuses in one line",
		async () => {
			const w = startProject(PROJECT);
			expect(await w.move({ filePath: "src/util.ts", toFile: "src/lib.ts" })).toContain("already exists");
			expect(await w.move({ filePath: "src/nothere.ts", toFile: "src/x.ts" })).toContain("File not found");
			expect(await w.move({ filePath: "src/ui", toFile: "src/x" })).toContain("is a directory");
			expect(await w.move({ toFile: "src/x.ts" })).toContain("pass `name`");
			expect(await w.move({ filePath: "src/util.ts" })).toBe("`to_file` is required.");
			expect(await w.move({ filePath: "src/util.ts", toFile: "src/x.ts", keepReexport: true })).toContain(
				"only applies when moving a symbol",
			);
		},
		T,
	);
});

describe("move: symbols", () => {
	const PROJECT = {
		"src/util.ts": [
			'import { helper } from "./lib";',
			"",
			"export const LIMIT = 10;",
			"",
			"/** Doubles. */",
			"export function double(x: number): number {",
			"\treturn helper(x) * 2 + LIMIT;",
			"}",
			"",
			"export function other(): string {",
			'\treturn "o" + double(1);',
			"}",
			"",
		].join("\n"),
		"src/lib.ts": "export function helper(x: number): number {\n\treturn x;\n}\n",
		"src/ui/view.ts":
			'import { double, other } from "../util";\nimport { helper } from "../lib";\nexport const v = [double(helper(1)), other()];\n',
		"src/main.ts": 'import { double } from "./util.js";\nexport { double };\n',
	};

	it(
		"given a function, when moved, then it gets its imports, importers are repointed and the old file imports it back",
		async () => {
			const w = startProject(PROJECT);
			const text = await w.move({ name: "double", toFile: "src/math/calc.ts", maxNewErrors: 0 });
			expect(text).toContain("Applied as edit");
			expect(text).toContain("0 new errors");
			expect(text).toContain("import cycle");
			const calc = read("src/math/calc.ts");
			expect(calc).toContain('import { helper } from "../lib";');
			expect(calc).toContain('import { LIMIT } from "../util";');
			expect(calc).toContain("/** Doubles. */\nexport function double(x: number): number {");
			const util = read("src/util.ts");
			expect(util).toContain('import { double } from "./math/calc";');
			expect(util).not.toContain("helper");
			expect(util).not.toContain("function double");
			expect(read("src/ui/view.ts")).toContain(
				'import { other } from "../util";\nimport { helper } from "../lib";\nimport { double } from "../math/calc";',
			);
			expect(read("src/main.ts")).toBe('import { double } from "./math/calc.js";\nexport { double };\n');
			await w.undoEdit();
			expect(exists("src/math")).toBe(false);
			expect(read("src/util.ts")).toBe(PROJECT["src/util.ts"]);
		},
		T,
	);

	it(
		"given a declaration moved with keep_reexport, when applied, then the old module re-exports it and still uses it; a private one becomes exported",
		async () => {
			const w = startProject({
				"src/a.ts": "const secret = 1;\nexport const pub = 2;\nexport const sum = secret + pub;\n",
				"src/user.ts": 'import { pub } from "./a";\nexport const u = pub;\n',
			});
			const text = await w.move({ name: "pub", toFile: "src/b.ts", keepReexport: true });
			expect(text).toContain("Applied as edit");
			expect(read("src/a.ts")).toBe(
				'import { pub } from "./b";\n\nconst secret = 1;\nexport const sum = secret + pub;\nexport { pub } from "./b";\n',
			);
			expect(read("src/user.ts")).toContain('import { pub } from "./b";');
			const moved = await w.move({ name: "secret", toFile: "src/c.ts" });
			expect(moved).toContain("it was not exported; it is now");
			expect(read("src/c.ts")).toBe("export const secret = 1;\n");
			expect(read("src/a.ts")).toContain('import { secret } from "./c";');
		},
		T,
	);

	it(
		"given a moved declaration that uses something private to its old file, when moved, then the broken reference blocks the write",
		async () => {
			const w = startProject({
				"src/a.ts":
					"const hidden = 1;\nexport function f(): number {\n\treturn hidden;\n}\nexport const keep = hidden;\n",
			});
			const text = await w.move({ name: "f", toFile: "src/b.ts" });
			expect(text).toContain("NOT applied");
			expect(text).toContain("Cannot find name 'hidden'");
			expect(exists("src/b.ts")).toBe(false);
		},
		T,
	);

	it(
		"given members, default exports and bad targets, when moving, then it refuses and says what to use",
		async () => {
			const w = startProject({
				"src/a.ts": "export class C {\n\tm(): void {}\n}\nexport default function d(): void {}\n",
			});
			expect(await w.move({ name: "C.m", toFile: "src/b.ts" })).toContain("move only moves top-level declarations");
			expect(await w.move({ name: "d", toFile: "src/b.ts" })).toContain("default export");
			expect(await w.move({ name: "C", toFile: "src/a.ts" })).toContain("already in");
			expect(await w.move({ name: "C", toFile: "README.md" })).toContain("must be a JS/TS file");
		},
		T,
	);
});

describe("quick_fix", () => {
	const PROJECT = {
		"src/lib.ts":
			"export const a = 1;\nexport function helper(x: number): number {\n\treturn x;\n}\nexport type Pt = { x: number };\n",
		"src/m.ts": 'import { a } from "./lib";\n\nconsole.log(a, helper(2));\nconst p: Pt = { x: 1 };\nexport { p };\n',
		"src/u.ts": 'import { b, a } from "./lib";\nimport { helper } from "./lib";\nconsole.log(a);\n',
	};

	it(
		"given missing imports, when fixing, then they are added and the errors disappear",
		async () => {
			const w = startProject(PROJECT);
			const text = await w.quickFix({ filePath: "src/m.ts" });
			expect(text).toContain("2 fix(es)");
			expect(text).toContain("2 errors fixed");
			expect(read("src/m.ts")).toContain('import { a, helper, Pt } from "./lib";');
		},
		T,
	);

	it(
		"given source actions, when used, then unused imports are removed and imports organised",
		async () => {
			const w = startProject(PROJECT);
			const removed = await w.quickFix({ filePath: "src/u.ts", action: "remove_unused_imports" });
			expect(removed).toContain("Applied as edit");
			expect(read("src/u.ts")).toBe('import { a } from "./lib";\nconsole.log(a);\n');
			expect(await w.quickFix({ filePath: "src/u.ts", action: "organize_imports" })).toContain("No changes");
		},
		T,
	);

	it(
		"given an error nothing can fix and an other-language file, when fixing, then it says so",
		async () => {
			const w = startProject({ ...PROJECT, "src/e.ts": "export const n: number = 'x';\n", "a.css": "a{}" });
			const text = await w.quickFix({ filePath: "src/e.ts" });
			expect(text).toContain("not fixed:");
			expect(await w.quickFix({ filePath: "src/lib.ts" })).toContain("no errors to fix");
			expect(await w.quickFix({ filePath: "a.css" })).toContain("works on JS/TS files");
			expect(await w.quickFix({ filePath: "src/missing.ts" })).toContain("File not found");
		},
		T,
	);

	it(
		"given a line, when fixing, then only errors on that line are touched",
		async () => {
			const w = startProject(PROJECT);
			const text = await w.quickFix({ filePath: "src/m.ts", line: 4 });
			expect(text).toContain("1 fix(es)");
			expect(read("src/m.ts")).toContain("Pt");
			expect(read("src/m.ts")).toContain("helper(2)");
			expect(read("src/m.ts")).not.toContain("helper }");
		},
		T,
	);
});

describe("verify_changes", () => {
	it(
		"given edits made outside the tools, when verified against HEAD, then new and fixed errors and untracked files are reported",
		async () => {
			const w = startSample();
			const git = (...args: string[]): void => {
				execFileSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
			};
			git("init", "-q");
			git("add", ".");
			git("commit", "-qm", "init");
			expect(await w.verifyChanges()).toBe("No JS/TS/HTML/CSS files differ from HEAD.");
			fs.writeFileSync(
				path.join(ws, "src/shapes.ts"),
				read("src/shapes.ts").replace("export function totalArea(", "export function totalAreas("),
			);
			fs.writeFileSync(path.join(ws, "src/new.ts"), "export const q: number = 'x';\n");
			fs.writeFileSync(path.join(ws, "src/broken.ts"), 'import { makeWidget } from "./app.ts";\nmakeWidget("ok");\n');
			fs.rmSync(path.join(ws, "src/util.js"));
			const text = await w.verifyChanges();
			expect(text).toContain("Changed since HEAD:");
			expect(text).toContain("src/new.ts");
			expect(text).toContain("src/shapes.ts:39:16 [error 2552]");
			expect(text).toContain("src/fancy.ts:1:10 [error 2724]");
			expect(text).toContain("src/new.ts:1:14 [error 2322]");
			expect(text).toContain("Errors fixed:");
			expect(text).toContain("src/broken.ts");
			expect(await w.verifyChanges({ since: "--evil" })).toContain("invalid revision");
		},
		T,
	);

	it(
		"given a directory that is not a git repository, when verified, then the git error is returned as text",
		async () => {
			const w = startProject({ "src/a.ts": "export {};\n" });
			expect(await w.verifyChanges()).toMatch(/^git rev-parse --show-toplevel failed/);
		},
		T,
	);
});

describe("consistency with the read tools", () => {
	it(
		"given a blocked preview, when diagnosing and searching afterwards, then the servers see the disk, not the overlay",
		async () => {
			const w = startSample();
			const baseline = await w.diagnostics("src/fancy.ts");
			expect(await w.diagnostics("src/shapes.ts")).toBe("No diagnostics.");
			const preview = await w.edit({
				filePath: "src/shapes.ts",
				oldString: "export function totalArea(",
				newString: "export function totalAreas(",
			});
			expect(preview).toContain("NOT applied");
			expect(await w.diagnostics("src/shapes.ts")).toBe("No diagnostics.");
			expect(await w.diagnostics("src/fancy.ts")).toBe(baseline);
			expect(await w.searchSymbol({ query: "totalArea" })).toContain("totalArea");
			expect(await w.searchSymbol({ query: "totalAreas" })).not.toContain("totalAreas  [Function]");
		},
		T,
	);

	it(
		"given an applied rename, when asking symbol_info, then the new name resolves and the old one does not",
		async () => {
			const w = startSample();
			expect(await w.symbolInfo({ name: "makeWidget" })).toContain("makeWidget  [Function]");
			await w.renameSymbol({ name: "makeWidget", newName: "buildWidget" });
			expect(await w.symbolInfo({ name: "buildWidget" })).toContain("buildWidget  [Function]");
			expect(await w.symbolInfo({ name: "makeWidget" })).toBe("No symbol found matching 'makeWidget'.");
			expect(read("src/broken.ts")).toContain("buildWidget(42)");
		},
		T,
	);

	it(
		"given two previews started at once, when both finish, then each reports on its own edit",
		async () => {
			const w = startSample();
			const [a, b] = await Promise.all([
				w.edit({
					filePath: "src/shapes.ts",
					oldString: "export function totalArea(",
					newString: "export function totalAreas(",
					apply: false,
				}),
				w.edit({
					filePath: "src/app.ts",
					oldString: "export const afterEmoji = 1;",
					newString: "export const afterEmoji = 'x';",
					apply: false,
				}),
			]);
			expect(a).toContain("src/fancy.ts:1:10 [error 2724]");
			expect(a).not.toContain("afterEmoji");
			expect(b).toContain("0 new errors");
		},
		T,
	);
});
