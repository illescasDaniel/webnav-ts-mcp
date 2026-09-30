#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Drives the Python webnav-mcp and this TypeScript port over real MCP stdio with
// identical calls and diffs the tool text.
//
//   node scripts/parity.mjs [--scenario spacemaker|fixture|all] [--verbose]
//                           [--workspace DIR]  SpaceMaker checkout (default: ../SpaceMaker next to the MCPs dir)
//                           [--py-dir DIR]     Python webnav-mcp checkout
//
// `spacemaker` runs read-only calls against a SpaceMaker checkout (a real web project) with the same env as
// .cursor/mcp.json. `fixture` copies tests/fixtures/sample-app to a temp dir and
// also mutates it between calls (edit, create, delete, config change).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const scenarioArg = opt("--scenario", "all");
const spacemaker = path.resolve(opt("--workspace", path.join(here, "../../../SpaceMaker")));
const pyDir = path.resolve(opt("--py-dir", path.join(here, "../../webnav-mcp")));
const verbose = args.includes("--verbose");

const servers = {
	python: { command: "uv", args: ["run", "--directory", pyDir, "webnav-mcp"] },
	typescript: { command: process.execPath, args: [path.join(here, "../dist/cli.js")] },
};

// Calls where the TS server is deliberately better than the Python one; they are shown, not failed.
const intentional = {
	'symbol_info {"name":"Widget.greet"}':
		"TS resolves members inherited from a base class (Python: type hierarchy, unsupported by tsc LSP)",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 1-indexed line/column (UTF-16) of `needle` in a file, `nth` occurrence, `shift` chars into it. */
function at(ws, file, needle, { shift = 0, nth = 0 } = {}) {
	const lines = fs.readFileSync(path.join(ws, file), "utf8").split(/\r?\n/);
	let seen = 0;
	for (const [i, line] of lines.entries()) {
		for (let from = line.indexOf(needle); from !== -1; from = line.indexOf(needle, from + 1)) {
			if (seen++ === nth) {
				return { file_path: file, line: i + 1, column: from + 1 + shift };
			}
		}
	}
	throw new Error(`${needle} not found in ${file}`);
}

const S = "src/spacemaker/adapters/inbound/web/static";
const scenarios = {
	spacemaker: {
		workspace: spacemaker,
		env: {
			WEBNAV_MCP_WORKSPACE: spacemaker,
			WEBNAV_MCP_ROOTS: `web=web/src,static=${S},wireframes=wireframes`,
			WEBNAV_MCP_EXCLUDE: `${S}/js`,
		},
		steps: () => [
			["workspace", {}],
			["css_var", { name: "--border" }],
			["css_var", { name: "ease-standard" }],
			["css_var", { name: "--nope" }],
			["css_var", {}],
			["selector", { name: ".btn" }],
			["selector", { name: "#btn-timeline" }],
			["selector", { name: "#view-gallery" }],
			["selector", { query: ".folder-hint" }],
			["selector", { name: "btn" }],
			["selector", { name: ".does-not-exist" }],
			["outline", { file_path: "web/src/gallery.ts" }],
			["outline", { file_path: "web/src/gallery.ts", detailed: true }],
			["outline", { file_path: "web/src/state.ts" }],
			["outline", { file_path: `${S}/theme.css` }],
			["outline", { file_path: `${S}/js/gallery.js` }],
			["symbol_info", { name: "bindGalleryUi" }],
			["symbol_info", { name: "bindGalleryUi", include_references: false }],
			["symbol_info", { query: "onClick" }],
			["symbol_info", { name: "NoSuchSymbolAnywhere" }],
			["symbol_info", {}],
			["search_symbol", { query: "gallery" }],
			["search_symbol", { name: "onClick", kind: "function" }],
			["search_symbol", { query: "gallery", path: "web/src/**/*.ts" }],
			["search_symbol", { query: "gallery", kind: "bogus" }],
			["hover", { file_path: "web/src/gallery.ts", line: 8, column: 10 }],
			["hover", { file_path: "web/src/gallery.ts", line: 9999, column: 1 }],
			["hover", { file_path: "web/src/missing.ts", line: 1, column: 1 }],
			["hover", { file_path: "README.md", line: 1, column: 1 }],
			["definition", { file_path: "web/src/gallery.ts", line: 4, column: 12 }],
			["references", { file_path: "web/src/gallery.ts", line: 8, column: 10 }],
			["references", { file_path: "web/src/dom.ts", line: 1, column: 1 }],
			["definition", { file_path: `${S}/shell-layout.css`, line: 1, column: 1 }],
			["diagnostics", { file_path: "web/src/gallery.ts" }],
			["diagnostics", { file_path: `${S}/theme.css` }],
			["diagnostics", { file_path: `${S}/index.html` }],
			["diagnostics", { file_path: `${S}/js/gallery.js` }],
		],
	},
	fixture: {
		prepare() {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webnav-parity-"));
			fs.cpSync(path.join(here, "../tests/fixtures/sample-app"), dir, { recursive: true });
			return dir;
		},
		env: (ws) => ({ WEBNAV_MCP_WORKSPACE: ws }),
		steps: (ws) => [
			["workspace", {}],
			["outline", { file_path: "src/app.ts" }],
			["outline", { file_path: "src/app.ts", detailed: true }],
			["outline", { file_path: "src/util.js" }],
			["outline", { file_path: "src/crlf.ts" }],
			["symbol_info", { name: "Widget" }],
			["symbol_info", { name: "Widget.render" }],
			["symbol_info", { name: "Widget.greet" }],
			["symbol_info", { name: "Base.greet", include_references: false }],
			["symbol_info", { name: "Widget.nope" }],
			["symbol_info", { name: "makeWidget", file_path: "src/app.ts" }],
			["symbol_info", { name: "makeWidget", file_path: "src/util.js" }],
			["symbol_info", { name: "debounce" }],
			["symbol_info", { name: "crlfFunction" }],
			["symbol_info", { name: "Options" }],
			["symbol_info", { name: "label" }],
			["search_symbol", { query: "widget" }],
			["search_symbol", { query: "widget", fuzzy: true }],
			["search_symbol", { query: "widget", kind: "class" }],
			["search_symbol", { query: "e", path: "src/*.js" }],
			["search_symbol", { query: "render", kind: "method,function" }],
			["hover", at(ws, "src/app.ts", "class Base", { shift: 6 })],
			["hover", at(ws, "src/app.ts", "afterEmoji")],
			["hover", { ...at(ws, "src/app.ts", "afterEmoji"), column: 9999 }],
			["definition", at(ws, "src/app.ts", "extends Base", { shift: 8 })],
			["references", at(ws, "src/app.ts", "makeWidget")],
			["references", at(ws, "src/crlf.ts", "crlfFunction")],
			["diagnostics", { file_path: "src/broken.ts" }],
			["diagnostics", { file_path: "src/app.ts" }],
			["diagnostics", { file_path: "src/badutf8.ts" }],
			["diagnostics", { file_path: "index.html" }],
			["diagnostics", { file_path: "styles.css" }],
			["css_var", { name: "--accent" }],
			["css_var", { name: "bg" }],
			["css_var", { name: "--row-height" }],
			["css_var", { name: "--missing" }],
			["css_var", { name: "--fg" }],
			["css_var", { name: "--inline-var" }],
			["css_var", { name: "--nope" }],
			["selector", { name: ".widget" }],
			["selector", { name: "#main-panel" }],
			["selector", { name: "#view-home" }],
			["selector", { name: "#view-other" }],
			["selector", { name: "#tab-1" }],
			["selector", { name: ".row-1" }],
			["selector", { name: ".row" }],
			["selector", { name: "#btn-save" }],
			["selector", { name: ".btn" }],
			["selector", { name: "#commented-out" }],
			["selector", { name: "#commented-id" }],
			["selector", { name: ".commented-class" }],
			["selector", { name: ".unused-class" }],
			["selector", { name: ".title" }],
			["selector", { name: ".is-active" }],
			["selector", { name: ".inline-rule" }],
			["selector", { name: "#not-an-id" }],
			["references", at(ws, "styles.css", ".widget")],
			["definition", at(ws, "styles.css", ".widget")],
			["references", at(ws, "styles.css", "--accent", { shift: 3 })],
			["definition", at(ws, "styles.css", "var(--bg", { shift: 6 })],
			["references", at(ws, "index.html", 'id="main-panel"', { shift: 6 })],
			["definition", at(ws, "index.html", "btn", { shift: 1 })],
			["references", at(ws, "styles.css", "#06c", { shift: 1 })], // a colour, not a selector: falls through to the language server
			// -- edits behind the servers' backs --------------------------------
			{
				label: "fix broken.ts",
				mutate: () =>
					fs.writeFileSync(
						path.join(ws, "src/broken.ts"),
						'import { makeWidget } from "./app.ts";\n\nconst n: number = 1;\nmakeWidget("ok");\n',
					),
			},
			["diagnostics", { file_path: "src/broken.ts" }],
			{
				label: "create newfile.ts",
				mutate: () =>
					fs.writeFileSync(
						path.join(ws, "src/newfile.ts"),
						"export function brandNewFn(): string {\n\treturn 'x';\n}\n",
					),
			},
			["search_symbol", { query: "brandNewFn" }],
			["symbol_info", { name: "brandNewFn" }],
			{ label: "delete newfile.ts", mutate: () => fs.rmSync(path.join(ws, "src/newfile.ts")) },
			["search_symbol", { query: "brandNewFn" }],
			{
				label: "edit styles.css",
				mutate: () =>
					fs.appendFileSync(
						path.join(ws, "styles.css"),
						".added-later { color: var(--added-var); }\n:root { --added-var: 1; }\n",
					),
			},
			["css_var", { name: "--added-var" }],
			["selector", { name: ".added-later" }],
			{
				label: "change jsconfig.json",
				mutate: () =>
					fs.writeFileSync(
						path.join(ws, "jsconfig.json"),
						JSON.stringify({ compilerOptions: { allowJs: true, target: "ES2022" }, include: ["src/**/*"] }),
					),
			},
			["outline", { file_path: "src/app.ts" }],
			["outline", { file_path: "src/app.ts" }],
		],
	},
};

async function connect(spec, env) {
	const client = new Client({ name: "parity", version: "0" });
	await client.connect(new StdioClientTransport({ ...spec, env: { ...process.env, ...env }, stderr: "ignore" }));
	return client;
}

async function call(client, name, params) {
	const started = performance.now();
	try {
		const result = await client.callTool({ name, arguments: params });
		return { text: result.content.map((c) => c.text).join("\n"), ms: Math.round(performance.now() - started) };
	} catch (error) {
		return { text: `<<protocol error: ${error.message}>>`, ms: Math.round(performance.now() - started) };
	}
}

let failed = false;
for (const [scenarioName, scenario] of Object.entries(scenarios)) {
	if (scenarioArg !== "all" && scenarioArg !== scenarioName) continue;
	if (scenarioName === "spacemaker" && !fs.existsSync(spacemaker)) {
		console.log(`\n##### scenario: ${scenarioName} (skipped: no checkout at ${spacemaker}; use --workspace)`);
		continue;
	}
	console.log(`\n##### scenario: ${scenarioName}`);
	const ws = scenario.prepare ? scenario.prepare() : scenario.workspace;
	const env = typeof scenario.env === "function" ? scenario.env(ws) : scenario.env;
	// The invalid-UTF-8 reason is a codec detail (Python: "invalid start byte"); the rest must match.
	const normalize = (text) =>
		text
			.replaceAll(fs.realpathSync(ws), "<ws>")
			.replaceAll(ws, "<ws>")
			.replace(/(Cannot read file as UTF-8 text:) [^\n]*/, "$1 <reason>");
	const clients = {};
	for (const [name, spec] of Object.entries(servers)) clients[name] = await connect(spec, env);

	const toolNames = {};
	for (const [name, client] of Object.entries(clients))
		toolNames[name] = (await client.listTools()).tools.map((t) => t.name).sort();
	// The TS server may grow tools the Python one never had (callers, implementations);
	// it must still offer every Python tool, and only shared tools are compared below.
	const missing = toolNames.python.filter((t) => !toolNames.typescript.includes(t));
	const extra = toolNames.typescript.filter((t) => !toolNames.python.includes(t));
	console.log(
		`tools: ${missing.length === 0 ? "TS covers every Python tool" : `TS MISSING ${missing}`}${extra.length ? `; TS-only: ${extra.join(", ")}` : ""}`,
	);
	if (missing.length > 0) failed = true;

	let same = 0;
	let total = 0;
	const diffs = [];
	const timings = { python: 0, typescript: 0 };
	for (const step of scenario.steps(ws)) {
		if (!Array.isArray(step)) {
			step.mutate();
			console.log(`~ ${step.label}`);
			await sleep(1200); // mtime granularity + let servers settle
			continue;
		}
		const [tool, params] = step;
		total++;
		const label = `${tool} ${JSON.stringify(params)}`;
		const py = await call(clients.python, tool, params);
		const ts = await call(clients.typescript, tool, params);
		timings.python += py.ms;
		timings.typescript += ts.ms;
		const a = normalize(py.text);
		const b = normalize(ts.text);
		if (intentional[label]) {
			same++;
			console.log(`≠ ${label}  (intentional: ${intentional[label]})`);
		} else if (a === b) {
			same++;
			console.log(`= ${label}  [py ${py.ms}ms / ts ${ts.ms}ms]`);
			if (verbose)
				console.log(
					a
						.split("\n")
						.slice(0, 8)
						.map((l) => `    ${l}`)
						.join("\n"),
				);
		} else {
			diffs.push({ label, a, b });
			console.log(`! ${label}  [py ${py.ms}ms / ts ${ts.ms}ms]`);
		}
	}
	for (const { label, a, b } of diffs) console.log(`\n=== DIFF ${label}\n--- python\n${a}\n--- typescript\n${b}`);
	console.log(`\n${same}/${total} identical; total time py ${timings.python}ms, ts ${timings.typescript}ms`);
	if (diffs.length > 0) failed = true;
	for (const client of Object.values(clients)) await client.close();
	if (scenario.prepare) fs.rmSync(ws, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
