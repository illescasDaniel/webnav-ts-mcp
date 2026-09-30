#!/usr/bin/env node
// Speed/memory comparison of the Python webnav-mcp and this TypeScript port over real MCP stdio.
//
//   node scripts/bench.mjs [--runs 5] [--warm 15] [--workspace DIR] [--py-dir DIR] [--json]
//
// Per run and server: spawn -> initialize handshake ("cold start"), the first call of each kind
// (includes spawning the language server), then `--warm` repeats of each call with varied arguments,
// then the resident memory of the whole process tree (server + language servers). Runs alternate
// between the servers so machine noise hits both equally. Python is started from its venv binary,
// not `uv run`, so uv's own overhead is excluded (it is reported separately).
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const runs = Number(opt("--runs", 5));
const warm = Number(opt("--warm", 15));
const workspace = path.resolve(opt("--workspace", path.join(here, "../../../SpaceMaker")));
const pyDir = path.resolve(opt("--py-dir", path.join(here, "../../webnav-mcp")));
const S = "src/spacemaker/adapters/inbound/web/static";
const env = {
	...process.env,
	WEBNAV_MCP_WORKSPACE: workspace,
	WEBNAV_MCP_ROOTS: `web=web/src,static=${S},wireframes=wireframes`,
	WEBNAV_MCP_EXCLUDE: `${S}/js`,
};
const servers = {
	python: { command: path.join(pyDir, ".venv/bin/webnav-mcp"), args: [] },
	typescript: { command: process.execPath, args: [path.join(here, "../dist/cli.js")] },
};

const names = [
	"renderGalleryItemStage",
	"showGalleryItem",
	"loadGalleryItemDetail",
	"applyGalleryExport",
	"formatDuration",
];
const vars = ["--accent", "--bg", "--text", "--border", "--radius"];
const classes = [".gallery-item-media", ".gallery-grid", ".app-shell", ".btn", ".toolbar"];
const pick = (list, i) => list[i % list.length];
const calls = {
	symbol_info: (i) => ({ name: pick(names, i) }),
	outline: (i) => ({ file_path: pick(["web/src/gallery-item.ts", "web/src/shell.ts", "web/src/types.ts"], i) }),
	search_symbol: (i) => ({ query: pick(["Gallery", "render", "Export", "format", "shift"], i) }),
	references: () => ({ file_path: "web/src/gallery-item.ts", line: 135, column: 10 }),
	hover: () => ({ file_path: "web/src/gallery-item.ts", line: 135, column: 10 }),
	diagnostics_ts: (i) => ({ file_path: pick(["web/src/gallery-item.ts", "web/src/shell.ts"], i) }),
	diagnostics_html: () => ({ file_path: "wireframes/app.html" }),
	css_var: (i) => ({ name: pick(vars, i) }),
	selector: (i) => ({ name: pick(classes, i) }),
};
const toolOf = (k) => (k.startsWith("diagnostics") ? "diagnostics" : k);

/** Resident memory (MiB) of a process and all its descendants. */
function treeRssMiB(rootPid) {
	const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8" })
		.trim()
		.split("\n")
		.map((l) => l.trim().split(/\s+/).map(Number));
	const kids = new Map();
	for (const [pid, ppid, rss] of rows) (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push([pid, rss]);
	const rss = new Map(rows.map(([pid, , r]) => [pid, r]));
	let total = 0;
	const stack = [rootPid];
	while (stack.length) {
		const pid = stack.pop();
		total += rss.get(pid) ?? 0;
		for (const [kid] of kids.get(pid) ?? []) stack.push(kid);
	}
	return total / 1024;
}

async function oneRun(name) {
	const { command, args: a } = servers[name];
	const transport = new StdioClientTransport({ command, args: a, env, cwd: workspace, stderr: "ignore" });
	const client = new Client({ name: "bench", version: "0" });
	const t0 = performance.now();
	await client.connect(transport);
	const coldStart = performance.now() - t0;
	const first = {};
	const warmMs = {};
	for (const [key, make] of Object.entries(calls)) {
		const s = performance.now();
		await client.callTool({ name: toolOf(key), arguments: make(0) });
		first[key] = performance.now() - s;
	}
	for (const [key, make] of Object.entries(calls)) {
		warmMs[key] = [];
		for (let i = 1; i <= warm; i++) {
			const s = performance.now();
			await client.callTool({ name: toolOf(key), arguments: make(i) });
			warmMs[key].push(performance.now() - s);
		}
	}
	const rss = treeRssMiB(transport.pid);
	const t1 = performance.now();
	await client.close();
	return { coldStart, first, warmMs, rss, closeMs: performance.now() - t1 };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.95) - 1)];
const results = { python: [], typescript: [] };
for (let r = 0; r < runs; r++) {
	for (const name of r % 2 ? ["typescript", "python"] : ["python", "typescript"]) {
		results[name].push(await oneRun(name));
		process.stderr.write(`run ${r + 1}/${runs} ${name} done\n`);
	}
}
const agg = (name, pick2) => results[name].map(pick2);
const out = { workspace, runs, warm, rows: {} };
const row = (label, py, ts) => {
	out.rows[label] = { python: py, typescript: ts };
};
row(
	"cold start: spawn -> initialize (ms, median)",
	median(agg("python", (x) => x.coldStart)),
	median(agg("typescript", (x) => x.coldStart)),
);
for (const key of Object.keys(calls)) {
	row(
		`first ${key} (ms, median)`,
		median(agg("python", (x) => x.first[key])),
		median(agg("typescript", (x) => x.first[key])),
	);
}
for (const key of Object.keys(calls)) {
	const all = (n) => results[n].flatMap((x) => x.warmMs[key]);
	row(`warm ${key} (ms, median)`, median(all("python")), median(all("typescript")));
	row(`warm ${key} (ms, p95)`, p95(all("python")), p95(all("typescript")));
}
const total = (n) =>
	median(
		results[n].map(
			(x) =>
				x.coldStart +
				Object.values(x.first).reduce((a, b) => a + b, 0) +
				Object.values(x.warmMs)
					.flat()
					.reduce((a, b) => a + b, 0),
		),
	);
row("whole session: connect + first + warm calls (ms, median)", total("python"), total("typescript"));
row(
	"memory: server + language servers (MiB, median)",
	median(agg("python", (x) => x.rss)),
	median(agg("typescript", (x) => x.rss)),
);
row(
	"shutdown after stdin close (ms, median)",
	median(agg("python", (x) => x.closeMs)),
	median(agg("typescript", (x) => x.closeMs)),
);

// uv's own overhead when launched the way README says (`uvx`/`uv run`), once.
const uvStart = performance.now();
spawnSync("uv", ["run", "--directory", pyDir, "python", "-c", "pass"], { stdio: "ignore" });
out.uvRunOverheadMs = performance.now() - uvStart;
out.pythonBinaryExists = fs.existsSync(servers.python.command);

if (args.includes("--json")) console.log(JSON.stringify(out, null, 2));
else {
	console.log(`workspace ${workspace}\nruns ${runs}, warm calls per kind ${warm}\n`);
	console.log("metric".padEnd(62) + "python".padStart(10) + "ts".padStart(10) + "  ratio");
	for (const [label, v] of Object.entries(out.rows)) {
		const f = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
		console.log(
			label.padEnd(62) +
				f(v.python).padStart(10) +
				f(v.typescript).padStart(10) +
				`  ${(v.python / v.typescript).toFixed(1)}x`,
		);
	}
	console.log(`\nuv run overhead (python -c pass): ${out.uvRunOverheadMs.toFixed(0)} ms`);
}
