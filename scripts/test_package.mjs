#!/usr/bin/env node
// Install the published package from the npm registry into a throwaway project (outside this
// checkout) and run an MCP stdio handshake plus real tool calls against its bin.
//
//   node scripts/test_package.mjs [--version X.Y.Z] [--retries N]
//
// Defaults to the version in package.json. A just-published version can take a moment to show
// up on the registry, so installs are retried (default 6 x 10 s).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const version = opt("--version", pkg.version);
const retries = Number(opt("--retries", 6));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const work = fs.mkdtempSync(path.join(os.tmpdir(), "webnav-ts-mcp-test-"));
const project = path.join(work, "project");
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, "package.json"), '{"name":"throwaway","private":true}\n');
fs.writeFileSync(path.join(project, "app.ts"), "export function hello(): string {\n\treturn 'hi';\n}\nhello();\n");
fs.writeFileSync(path.join(project, "app.css"), ".card { color: red; }\n");
fs.writeFileSync(path.join(project, "index.html"), '<div class="card"></div>\n');

let failed = false;
try {
	console.log(`Installing ${pkg.name}@${version} from the registry`);
	let installed = false;
	for (let attempt = 1; attempt <= retries && !installed; attempt++) {
		const result = spawnSync(
			"npm",
			["install", "--no-audit", "--no-fund", "--prefer-online", `${pkg.name}@${version}`],
			{
				cwd: project,
				encoding: "utf8",
			},
		);
		installed = result.status === 0;
		if (!installed) {
			console.log(`  attempt ${attempt}/${retries} failed: ${result.stderr.trim().split("\n").at(-1)}`);
			if (attempt < retries) await sleep(10_000);
		}
	}
	if (!installed) throw new Error("install failed");

	const bin = path.join(project, "node_modules", ".bin", pkg.name);
	const child = spawn(bin, [], {
		cwd: project,
		env: { ...process.env, WEBNAV_MCP_WORKSPACE: project },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	let buffer = "";
	const waiting = new Map();
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
			const message = JSON.parse(buffer.slice(0, nl));
			buffer = buffer.slice(nl + 1);
			waiting.get(message.id)?.(message);
		}
	});
	let nextId = 1;
	const request = (method, params) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
			waiting.set(id, (message) => {
				clearTimeout(timer);
				resolve(message);
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	const call = async (name, toolArgs) => {
		const reply = await request("tools/call", { name, arguments: toolArgs });
		if (!reply.result || reply.result.isError) throw new Error(`${name} failed: ${JSON.stringify(reply)}`);
		return reply.result.content.map((c) => c.text).join("\n");
	};

	try {
		const init = await request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "smoke", version: "0" },
		});
		if (!init.result) throw new Error(`initialize failed: ${JSON.stringify(init)}`);
		if (init.result.serverInfo.version !== version) {
			throw new Error(`server reports ${init.result.serverInfo.version}, installed ${version}`);
		}
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		const tools = (await request("tools/list", {})).result.tools.map((t) => t.name).sort();
		for (const needed of ["symbol_info", "outline", "callers", "selector", "css_var"]) {
			if (!tools.includes(needed)) throw new Error(`missing tool ${needed}: ${tools}`);
		}
		console.log(`initialize ok, ${tools.length} tools (${tools.join(", ")})`);

		// Real language-server round trips, so a broken bundled tsc / html / css server fails here.
		const info = await call("symbol_info", { name: "hello" });
		if (!info.includes("app.ts")) throw new Error(`symbol_info did not find hello: ${info}`);
		const selector = await call("selector", { name: ".card" });
		if (!selector.includes("app.css") || !selector.includes("index.html")) {
			throw new Error(`selector missed a file: ${selector}`);
		}
		const diagnostics = await call("diagnostics", { file_path: "index.html" });
		console.log(`symbol_info, selector and HTML diagnostics ok (${diagnostics.split("\n")[0]})`);
	} finally {
		child.kill();
		if (stderr.trim()) console.error(`[${pkg.name} stderr]\n${stderr.trim().slice(-600)}`);
	}
	console.log("OK");
} catch (error) {
	failed = true;
	console.error(`FAILED: ${error.message}`);
} finally {
	fs.rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
