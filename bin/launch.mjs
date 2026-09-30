#!/usr/bin/env node
// Checkout launcher: makes `node <checkout>/bin/launch.mjs` work on a fresh clone
// by installing dependencies and building `dist/` when they are missing or older than
// `src/`, then starting the server. stdout carries the MCP protocol, so every child inherits
// stderr for its output. Published installs run `dist/cli.js` directly and never use this.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "cli.js");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** Newest modification time (ms) of any `.ts` file below `dir`. */
function newestSource(dir) {
	let newest = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		newest = Math.max(
			newest,
			entry.isDirectory() ? newestSource(full) : full.endsWith(".ts") ? fs.statSync(full).mtimeMs : 0,
		);
	}
	return newest;
}

function run(args) {
	console.error(`webnav: npm ${args.join(" ")}`);
	const result = spawnSync(npm, args, {
		cwd: root,
		stdio: ["ignore", process.stderr, process.stderr],
		shell: process.platform === "win32",
	});
	if (result.status !== 0) {
		console.error(
			`webnav: 'npm ${args.join(" ")}' failed; run \`npm run setup:webnav\` from the repository root to see why.`,
		);
		process.exit(1);
	}
}

const installed = fs.existsSync(path.join(root, "node_modules", "typescript", "package.json"));
const built = fs.existsSync(entry);
if (!installed) {
	run(["ci"]);
}
if (!installed || !built || newestSource(path.join(root, "src")) > fs.statSync(entry).mtimeMs) {
	run(["run", "build"]);
}
await import(pathToFileURL(entry).href);
