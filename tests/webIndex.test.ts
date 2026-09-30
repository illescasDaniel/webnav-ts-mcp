import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as wi from "../src/webIndex.js";
import { makeTree } from "./helpers.js";

const index = (files: Record<string, string>): wi.RootIndex => {
	const dir = makeTree(files);
	return wi.buildRootIndex(dir, "web");
};
const lines = (hits: { line: number }[] | undefined): number[] => (hits ?? []).map((h) => h.line);

describe("css scanning", () => {
	it("given nested media query, when scanned, then declaration carries a context breadcrumb", () => {
		const idx = index({
			"a.css": ":root { --bg: white; }\n@media (prefers-color-scheme: dark) {\n\t:root { --bg: #111; }\n}\n",
		});
		const decls = idx.varDeclarations.get("--bg") ?? [];
		expect(decls.map((d) => [d.line, d.context, d.value])).toEqual([
			[1, ":root", "white"],
			[3, "@media (prefers-color-scheme: dark) › :root", "#111"],
		]);
	});

	it("given var usages with and without fallback, when scanned, then hasFallback is set correctly", () => {
		const idx = index({ "a.css": "a { color: var(--x); }\nb { color: var(--y, red); }\n" });
		expect(idx.varUsages.get("--x")?.[0]?.hasFallback).toBe(false);
		expect(idx.varUsages.get("--y")?.[0]?.hasFallback).toBe(true);
	});

	it("given a declaration inside a css comment, when scanned, then it is ignored but line numbers hold", () => {
		const idx = index({ "a.css": "/* --ghost: 1;\n */\n:root { --real: 2; }\n" });
		expect(idx.varDeclarations.has("--ghost")).toBe(false);
		expect(lines(idx.varDeclarations.get("--real"))).toEqual([3]);
	});

	it("given a declaration before a nested rule, when scanned, then its value is not read as the selector", () => {
		const idx = index({ "a.css": ".a { color: #abc; .b { margin: 0; } }\n" });
		expect([...idx.selectorHits.keys()].sort()).toEqual([".a", ".b"]);
	});

	it("given a class twice in one rule line, when formatted, then the line is listed once", () => {
		const idx = index({ "a.css": ".a.x, .a .y { color: red; }\n" });
		expect(wi.formatSelector([idx], ".a")).toContain("a.css: L1 (CSS rule)");
		expect(wi.formatSelector([idx], ".a")).not.toContain("L1 (CSS rule), L1");
	});
});

describe("html scanning", () => {
	it("given style block and style attribute, when scanned, then vars are found at the right lines", () => {
		const idx = index({
			"a.html": '<html>\n<style>\n:root { --a: 1; }\n</style>\n<p style="margin: var(--a)">x</p>\n</html>\n',
		});
		expect(lines(idx.varDeclarations.get("--a"))).toEqual([3]);
		expect(lines(idx.varUsages.get("--a"))).toEqual([5]);
	});

	it("given id and class attributes, when scanned, then selector hits are html-kind", () => {
		const idx = index({ "a.html": '<div id="main" class="card wide"></div>\n' });
		expect(idx.selectorHits.get("#main")?.[0]).toMatchObject({ kind: "html", detail: "id attribute", line: 1 });
		expect(idx.selectorHits.has(".card")).toBe(true);
		expect(idx.selectorHits.has(".wide")).toBe(true);
	});

	it("given data- prefixed attributes, when scanned, then they are not indexed as id or class", () => {
		const idx = index({ "a.html": '<p data-id="x" data-class="y" data-style="color: var(--z)">t</p>\n' });
		expect(idx.selectorHits.size).toBe(0);
		expect(idx.varUsages.size).toBe(0);
	});

	it("given a commented-out element, when scanned, then it is ignored", () => {
		const idx = index({ "a.html": '<!-- <div id="ghost"></div> -->\n<div id="real"></div>\n' });
		expect(idx.selectorHits.has("#ghost")).toBe(false);
		expect(lines(idx.selectorHits.get("#real"))).toEqual([2]);
	});

	it("given a script with src, when scanned, then no body is scanned", () => {
		const idx = index({ "a.html": '<script src="x.js">document.getElementById("nope")</script>\n' });
		expect(idx.selectorHits.has("#nope")).toBe(false);
	});

	it("given an inline script, when scanned, then hits carry the html file line", () => {
		const idx = index({ "a.html": '<p></p>\n<script>\n\tel.className = "on";\n</script>\n' });
		expect(idx.selectorHits.get(".on")?.[0]).toMatchObject({ kind: "js", detail: "className", line: 3 });
	});
});

describe("js scanning", () => {
	const hitsOf = (src: string, token: string) => index({ "a.js": src }).selectorHits.get(token) ?? [];

	it("given classList.add with several tokens, when scanned, then each is recorded", () => {
		const idx = index({ "a.js": 'el.classList.add("a", "b c");\n' });
		expect([...idx.selectorHits.keys()].sort()).toEqual([".a", ".b", ".c"]);
	});

	it("given querySelectorAll with a compound selector, when scanned, then every token is recorded", () => {
		const idx = index({ "a.js": 'document.querySelectorAll(".x > .y#z");\n' });
		expect([...idx.selectorHits.keys()].sort()).toEqual([".x", ".y", "#z"].sort());
	});

	it("given a typescript type argument, when scanned, then the class is still recorded", () => {
		expect(hitsOf('el.querySelector<HTMLElement>(".t");\n', ".t")).toHaveLength(1);
	});

	it("given a comparison expression, when scanned, then it is not mistaken for a type argument", () => {
		expect(hitsOf('if (a < b && closest > (".t")) {}\n', ".t")).toHaveLength(0);
	});

	it("given getElementById with concatenation, when scanned, then it is tagged as a dynamic partial match", () => {
		const [hit] = hitsOf('document.getElementById("view-" + id);\n', "#view-");
		expect(hit).toMatchObject({ dynamic: true, detail: "getElementById" });
	});

	it("given a static getElementById, when scanned, then it is not dynamic", () => {
		expect(hitsOf('document.getElementById("main");\n', "#main")[0]?.dynamic).toBe(false);
	});

	it("given a template literal, when scanned, then only the static prefix is indexed as dynamic", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is JS source under test, not ours
		const [hit] = hitsOf("document.getElementById(`tab-${id}`);\n", "#tab-");
		expect(hit?.dynamic).toBe(true);
	});

	it("given className assigned with concatenation, when scanned, then only the last token is dynamic", () => {
		const idx = index({ "a.js": 'el.className = "row row-" + id;\n' });
		expect(idx.selectorHits.get(".row")?.[0]?.dynamic).toBe(false);
		expect(idx.selectorHits.get(".row-")?.[0]?.dynamic).toBe(true);
	});

	it("given a trailing space before the concatenation, when scanned, then nothing is dynamic", () => {
		const idx = index({ "a.js": 'el.className = "row " + extra;\n' });
		expect(idx.selectorHits.get(".row")?.[0]?.dynamic).toBe(false);
	});

	it("given a class variable built with +=, when scanned, then tokens are recorded", () => {
		const idx = index({ "a.js": 'let mediaClass = "";\nmediaClass += " slide-in";\n' });
		expect(idx.selectorHits.get(".slide-in")?.[0]?.detail).toBe("class-var +=");
	});

	it("given markup inside a JS string, when scanned, then id and class attributes are recorded", () => {
		const idx = index({ "a.js": 'el.innerHTML = \'<span id="s" class="k"></span>\';\n' });
		expect(idx.selectorHits.get("#s")?.[0]?.detail).toBe("id attribute in JS string");
		expect(idx.selectorHits.get(".k")?.[0]?.detail).toBe("class attribute in JS string");
	});

	it("given setProperty and getPropertyValue, when scanned, then var usages are recorded with fallback", () => {
		const idx = index({ "a.js": 'el.style.setProperty("--a", 1);\ngetComputedStyle(el).getPropertyValue("--b");\n' });
		expect(idx.varUsages.get("--a")?.[0]?.hasFallback).toBe(true);
		expect(idx.varUsages.get("--b")?.[0]?.hasFallback).toBe(true);
	});

	it("given a comment marker inside a string, when scanned, then the rest of the line is still indexed", () => {
		expect(hitsOf('const u = "http://x"; document.getElementById("after");\n', "#after")).toHaveLength(1);
	});

	it("given commented-out code, when scanned, then it is ignored", () => {
		expect(hitsOf('// document.getElementById("ghost")\n/* el.className = "ghost2" */\n', "#ghost")).toHaveLength(0);
	});

	it("given ts, mts, jsx and tsx files, when indexed, then all are scanned", () => {
		const idx = index({
			"a.ts": 'x.className = "t";\n',
			"b.mts": 'x.className = "m";\n',
			"c.jsx": 'x.className = "j";\n',
			"d.tsx": 'x.className = "x";\n',
		});
		expect([...idx.selectorHits.keys()].sort()).toEqual([".j", ".m", ".t", ".x"]);
	});
});

describe("string literal helper hits", () => {
	const src = 'onClick("btn-save", () => {});\ndocument.getElementById("main");\n';

	it("given an id passed to a project helper, when formatted, then reported as a string literal", () => {
		const idx = index({ "a.js": src });
		expect(wi.formatSelector([idx], "#btn-save")).toContain("L1 (string literal)");
	});

	it("given a literal already seen by a DOM API, when formatted, then it is not double reported", () => {
		const idx = index({ "a.js": src });
		expect(wi.formatSelector([idx], "#main")).not.toContain("string literal");
	});

	it("given a concatenated literal, when scanned, then it is not recorded as a bare name", () => {
		const idx = index({ "a.js": 'log("prefix-" + x);\n' });
		expect(idx.stringLiterals.has("prefix-")).toBe(false);
	});

	it("given a class used only via a helper literal, when diagnosing, then it is not unreferenced", () => {
		const idx = index({ "a.css": ".only-helper { color: red; }\n", "a.js": 'toggle("only-helper");\n' });
		expect(wi.unreferencedSelectors(idx)).toEqual([]);
	});
});

describe("diagnostics", () => {
	it("given var without fallback and no declaration, when diagnosing, then it warns", () => {
		const idx = index({ "a.css": "a { color: var(--nope); }\n" });
		expect(wi.diagnosticsForFile(idx, "a.css")).toEqual(["1:1 [warning] var(--nope) is never defined in web"]);
	});

	it("given var with fallback and no declaration, when diagnosing, then it does not warn", () => {
		const idx = index({ "a.css": "a { color: var(--nope, red); }\n" });
		expect(wi.diagnosticsForFile(idx, "a.css")).toEqual([]);
	});

	it("given an unreferenced css rule, when diagnosing, then it warns; once referenced from html, it does not", () => {
		const css = ".orphan { color: red; }\n";
		expect(wi.diagnosticsForFile(index({ "a.css": css }), "a.css")).toEqual([
			"1:1 [warning] .orphan is never referenced in web's HTML/JS",
		]);
		expect(wi.diagnosticsForFile(index({ "a.css": css, "a.html": '<i class="orphan"></i>' }), "a.css")).toEqual([]);
	});

	it("given only a dynamic js hit, when finding unreferenced selectors, then a matching css rule is not flagged", () => {
		const idx = index({ "a.css": "#view-home { margin: 0; }\n", "a.js": 'document.getElementById("view-" + id);\n' });
		expect(wi.unreferencedSelectors(idx)).toEqual([]);
	});
});

describe("formatting", () => {
	it("given a var declared and used, when formatted, then definitions and usages are grouped per root", () => {
		const idx = index({ "a.css": ":root { --a: 1; }\nb { margin: var(--a); }\n", "b.css": "c { top: var(--a); }\n" });
		expect(wi.formatCssVar([idx], "a")).toBe(
			"--a\n\n== web ==\nDefinitions:\n  a.css:1  (:root)  = 1\nUsages (2 in 2 file(s)):\n  a.css: L2\n  b.css: L1",
		);
	});

	it("given a var never seen, when formatted, then it says so", () => {
		expect(wi.formatCssVar([index({})], "--x")).toBe("--x is not defined or used anywhere under web.");
	});

	it("given a token without # or ., when formatted as selector, then it explains the requirement", () => {
		expect(wi.formatSelector([index({})], "btn")).toBe("'btn' must start with '#' (id) or '.' (class).");
	});

	it("given a dynamic prefix hit, when querying a longer id, then it is surfaced as a partial match", () => {
		const idx = index({ "a.js": 'document.getElementById("view-" + id);\n' });
		expect(wi.formatSelector([idx], "#view-components")).toContain("dynamic partial match via '#view-'");
	});

	it("given a hit in generated output, when formatted, then the file is labelled [generated]", () => {
		const idx = index({ "out/a.js": 'el.className = "g";\n' });
		expect(wi.formatSelector([idx], ".g", { generated: ["out"] })).toContain("out/a.js [generated]");
	});

	it("given definitionsOnly, when formatting a class, then only css rules are shown", () => {
		const idx = index({ "a.css": ".k { color: red; }\n", "a.html": '<i class="k"></i>' });
		const text = wi.formatSelector([idx], ".k", { definitionsOnly: true });
		expect(text).toContain("CSS (1)");
		expect(text).not.toContain("HTML");
	});
});

describe("token lookup", () => {
	it("given columns on tokens, when resolving, then var, class and id are found", () => {
		expect(wi.tokenAtPosition("  color: var(--bg);", 15)).toBe("--bg");
		expect(wi.tokenAtPosition(".card-title { }", 3)).toBe(".card-title");
		expect(wi.tokenAtPosition("#main { }", 2)).toBe("#main");
	});

	it("given a column inside an html class attribute, when resolving, then that word is the class", () => {
		const line = '<div class="alpha beta">';
		expect(wi.tokenAtPosition(line, line.indexOf("beta") + 2)).toBe(".beta");
		expect(wi.tokenAtPosition(line, line.indexOf(" beta") + 1)).toBeUndefined();
	});

	it("given a column inside an html id attribute, when resolving, then it is the id", () => {
		const line = '<div id="main">';
		expect(wi.tokenAtPosition(line, line.indexOf("main") + 1)).toBe("#main");
	});

	it("given a column outside any token, when resolving, then undefined", () => {
		expect(wi.tokenAtPosition("  color: red;", 3)).toBeUndefined();
	});

	it("given selector-like strings, when asking token kind, then id/class/undefined", () => {
		expect([wi.tokenKind("#a"), wi.tokenKind(".a"), wi.tokenKind("a")]).toEqual(["id", "class", undefined]);
	});
});

describe("roots and caching", () => {
	it("given no roots, when building the workspace index, then one default root spans the tree", () => {
		const dir = makeTree({ "a.css": ":root { --a: 1; }", "sub/b.css": "b { top: var(--a); }" });
		const [only, ...rest] = wi.buildWorkspaceIndex(dir);
		expect(rest).toEqual([]);
		expect(only?.name).toBe("web");
		expect([...(only?.varUsages.keys() ?? [])]).toEqual(["--a"]);
	});

	it("given named roots, when building, then they stay separate with workspace-relative paths", () => {
		const dir = makeTree({ "app/a.css": ":root { --a: 1; }", "design/b.css": ":root { --a: 2; }" });
		const roots = wi.parseRootsEnv("app=app, design=design", dir);
		const [app, design] = wi.buildWorkspaceIndex(dir, roots);
		expect(app?.varDeclarations.get("--a")?.[0]).toMatchObject({ file: "app/a.css", value: "1" });
		expect(design?.varDeclarations.get("--a")?.[0]).toMatchObject({ file: "design/b.css", value: "2" });
	});

	it("given an entry without equals, when parsing roots, then it throws with the expected shape", () => {
		expect(() => wi.parseRootsEnv("oops", "/x")).toThrow("expected label=relative/path");
	});

	it("given a file in a named root, when locating its index, then the recorded path matches", () => {
		const dir = makeTree({ "app/a.css": "a { top: 0; }" });
		const indexes = wi.buildWorkspaceIndex(dir, wi.parseRootsEnv("app=app", dir));
		const located = wi.rootIndexForFile(indexes, path.join(dir, "app/a.css"));
		expect(located?.[0].name).toBe("app");
		expect(located?.[1]).toBe("app/a.css");
		expect(wi.rootIndexForFile(indexes, path.join(dir, "elsewhere.css"))).toBeUndefined();
	});

	it("given unchanged files, when building twice, then the parsed index is reused; after an edit it is rebuilt", () => {
		const dir = makeTree({ "a.css": ":root { --a: 1; }" });
		const first = wi.buildRootIndex(dir, "web");
		expect(wi.buildRootIndex(dir, "web")).toBe(first);
		fs.writeFileSync(path.join(dir, "a.css"), ":root { --a: 1; --b: 2; }");
		const second = wi.buildRootIndex(dir, "web");
		expect(second).not.toBe(first);
		expect(second.varDeclarations.has("--b")).toBe(true);
	});

	it("given a non-utf8 file, when building, then it is skipped instead of failing", () => {
		const dir = makeTree({ "ok.css": ":root { --ok: 1; }" });
		fs.writeFileSync(path.join(dir, "bad.css"), Buffer.from([0x3a, 0xff, 0xfe, 0x7b]));
		expect(wi.buildRootIndex(dir, "web").varDeclarations.has("--ok")).toBe(true);
	});

	it("given files under node_modules, when building, then they are not indexed", () => {
		const idx = index({ "node_modules/pkg/a.css": ":root { --vendored: 1; }", "a.css": ":root { --own: 1; }" });
		expect([...idx.varDeclarations.keys()]).toEqual(["--own"]);
	});
});
