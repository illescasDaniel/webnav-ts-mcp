#!/usr/bin/env node
/** Console entry point: serve over stdio. */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

function packageVersion(): string {
	try {
		const url = new URL("../package.json", import.meta.url);
		return (JSON.parse(fs.readFileSync(fileURLToPath(url), "utf8")) as { version?: string }).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const { server, webnav } = createServer(packageVersion());

let closing = false;
async function shutdown(code: number): Promise<void> {
	if (closing) {
		return;
	}
	closing = true;
	await webnav.dispose();
	process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
server.server.onclose = () => void shutdown(0);
// The SDK's stdio transport never reports EOF as a close. A host that disconnects
// (or a wrapper like `npx` that doesn't forward signals) would otherwise leave
// this process and its language servers running.
process.stdin.on("end", () => void shutdown(0));
process.stdin.on("close", () => void shutdown(0));

await server.connect(new StdioServerTransport());
