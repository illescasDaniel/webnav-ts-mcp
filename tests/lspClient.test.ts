import { describe, expect, it } from "vitest";
import { formatToolError, isToolError, LanguageServerExitedError, LspTimeoutError } from "../src/shared/errors.js";
import { LspClient } from "../src/shared/lspClient.js";
import { makeTree } from "./helpers.js";

const client = (command: string[], extra: { requestTimeoutMs?: number } = {}): LspClient =>
	new LspClient({ workspaceRoot: makeTree(), command, languageId: "javascript", ...extra });

describe("lsp client failure modes", () => {
	it("given a server that exits immediately, when starting, then the error carries its stderr tail", async () => {
		const c = client([process.execPath, "-e", "console.error('kaboom: bad config'); process.exit(3)"]);
		const error = await c.start().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(LanguageServerExitedError);
		expect((error as Error).message).toContain("Its last stderr output:\nkaboom: bad config");
		expect(c.isAlive).toBe(false);
	}, 15_000);

	it("given a missing executable, when starting, then it is a tool error that reads as a spawn failure", async () => {
		const c = client(["/definitely/not/a/binary"]);
		const error = await c.start().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(isToolError(error)).toBe(true);
		expect(formatToolError(error as Error)).toMatch(/^Cannot start language server/);
	}, 15_000);

	it("given a server that never answers, when a request outlives its deadline, then it times out and the process is reaped", async () => {
		const c = client([process.execPath, "-e", "setInterval(() => {}, 1000)"], { requestTimeoutMs: 300 });
		const error = await c.start().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(LspTimeoutError);
		expect(formatToolError(error as Error)).toContain("timed out");
		expect(c.isAlive).toBe(false);
	}, 15_000);
});
