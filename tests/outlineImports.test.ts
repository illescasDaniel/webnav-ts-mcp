import { describe, expect, it } from "vitest";
import { dropImportSymbols, importLines } from "../src/outlineImports.js";
import type { LspSymbol } from "../src/shared/lspTypes.js";

const at = (name: string, line: number): LspSymbol => ({
	name,
	kind: 13,
	range: { start: { line, character: 0 }, end: { line, character: 1 } },
});

describe("import statements", () => {
	it("given single- and multi-line imports, when scanned, then every line of each statement is covered", () => {
		const source = 'import a from "a";\nimport {\n\tb,\n\tc,\n} from "b"\nimport "side-effect";\nconst x = 1;\n';
		expect([...importLines(source)]).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it("given import-equals, attributes and a type import, when scanned, then each is one statement", () => {
		const source =
			'import fs = require("fs");\nimport Foo = Bar.Baz;\nimport j from "./j.json" with { type: "json" };\nimport type { T } from "t";\nlet y;\n';
		expect([...importLines(source)]).toEqual([0, 1, 2, 3]);
	});

	it("given an indented or partial line that only mentions import, when scanned, then it is not an import", () => {
		expect(importLines('const importantly = 1;\n\tawait import("x");\nimportant();\n').size).toBe(0);
	});

	it("given symbols on import lines, when dropped, then only the file's own declarations remain", () => {
		const source = 'import { a,\n b } from "x";\nexport const c = 1;\n';
		expect(dropImportSymbols([at("a", 0), at("b", 1), at("c", 2)], source).map((s) => s.name)).toEqual(["c"]);
	});
});
