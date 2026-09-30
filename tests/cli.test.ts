/** The built executable: it must exit by itself when the host goes away. Needs `npm run build` (the `pretest` script does it). */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { makeTree } from "./helpers.js";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "../dist/cli.js");

describe("cli", () => {
	// A running language server keeps the event loop alive, so this is the case where
	// the server itself must notice that its host is gone (an idle process exits anyway).
	it("given a live language server, when the host closes stdin, then the process exits on its own with code 0", async () => {
		const workspace = makeTree({ "a.ts": "export const a = 1;\n" });
		const child = spawn(process.execPath, [cli], {
			cwd: workspace,
			env: { ...process.env, WEBNAV_MCP_WORKSPACE: "" },
			stdio: ["pipe", "pipe", "ignore"],
		});
		let buffered = "";
		const waiters: ((line: string) => void)[] = [];
		child.stdout.on("data", (chunk: Buffer) => {
			buffered += chunk.toString();
			for (let nl = buffered.indexOf("\n"); nl !== -1; nl = buffered.indexOf("\n")) {
				waiters.shift()?.(buffered.slice(0, nl));
				buffered = buffered.slice(nl + 1);
			}
		});
		const send = (message: object): void => void child.stdin.write(`${JSON.stringify(message)}\n`);
		const reply = (): Promise<string> => new Promise((resolve) => waiters.push(resolve));

		const initialized = reply();
		send({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
		});
		expect(await initialized).toContain('"serverInfo":{"name":"webnav"');
		send({ jsonrpc: "2.0", method: "notifications/initialized" });

		const outlined = reply();
		send({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: "outline", arguments: { file_path: "a.ts" } },
		});
		expect(await outlined).toContain("a  [Variable]");

		const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
		child.stdin.end();
		const outcome = await Promise.race([
			exited,
			new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 8000)),
		]);
		if (outcome === "still running") child.kill();
		expect(outcome).toBe(0);
	}, 30_000);
});
