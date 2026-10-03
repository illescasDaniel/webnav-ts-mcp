/** The MCP surface: tool registration, argument handling and roots-driven workspace selection, over an in-memory transport. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { makeTree } from "./helpers.js";

const savedEnv = { ...process.env };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
});

async function connect(roots?: () => string[]): Promise<Client> {
	const { server, webnav } = createServer("test");
	const client = new Client({ name: "test", version: "0" }, { capabilities: roots ? { roots: {} } : {} });
	if (roots) {
		client.setRequestHandler(ListRootsRequestSchema, async () => ({
			roots: roots().map((p) => ({ uri: pathToFileURL(p).href })),
		}));
	}
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	cleanups.push(async () => {
		await client.close();
		await webnav.dispose();
	});
	return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
	(result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

describe("tool surface", () => {
	it("given a client, when listing tools, then the read and write tools exist with snake_case parameters", async () => {
		const client = await connect();
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual([
			"apply_edit",
			"callers",
			"css_var",
			"definition",
			"diagnostics",
			"edit",
			"edit_symbol",
			"hover",
			"implementations",
			"move",
			"outline",
			"quick_fix",
			"references",
			"rename_symbol",
			"search_symbol",
			"selector",
			"symbol_info",
			"undo_edit",
			"verify_changes",
			"workspace",
		]);
		const props = (name: string): string[] =>
			Object.keys((tools.find((t) => t.name === name)?.inputSchema.properties as object) ?? {}).sort();
		expect(props("references")).toEqual(["column", "file_path", "include_declaration", "line"]);
		expect(props("symbol_info")).toEqual(["file_path", "include_references", "name", "query"]);
		expect(props("search_symbol")).toEqual(["fuzzy", "kind", "name", "path", "query"]);
		expect(props("edit")).toEqual([
			"apply",
			"file_path",
			"include_dependents",
			"max_new_errors",
			"new_string",
			"new_text",
			"old_string",
			"replace_all",
		]);
		expect(props("move")).toEqual([
			"allow_large",
			"apply",
			"file_path",
			"keep_reexport",
			"max_new_errors",
			"name",
			"to_file",
		]);
		expect(client.getInstructions()).toContain("Start with symbol_info");
		expect(client.getInstructions()).toContain("To change code, prefer the write tools");
	});

	it("given the write tools, when listing them, then only verify_changes is marked read-only and every write is destructive", async () => {
		const client = await connect();
		const { tools } = await client.listTools();
		const hint = (name: string) => tools.find((t) => t.name === name)?.annotations;
		expect(hint("verify_changes")).toMatchObject({ readOnlyHint: true });
		for (const name of ["edit", "edit_symbol", "rename_symbol", "move", "quick_fix", "apply_edit", "undo_edit"]) {
			expect(hint(name)).toMatchObject({ readOnlyHint: false, destructiveHint: true });
		}
	});

	it("given a missing name, when calling css_var, then a hint comes back as text instead of a schema error", async () => {
		process.env.WEBNAV_MCP_WORKSPACE = makeTree();
		const client = await connect();
		const result = await client.callTool({ name: "css_var", arguments: {} });
		expect(result.isError).toBeFalsy();
		expect(textOf(result)).toBe("Pass `name` (e.g. name='--bg'); `query` is accepted as an alias.");
	});

	it("given the alias, when calling selector with query, then it is accepted", async () => {
		process.env.WEBNAV_MCP_WORKSPACE = makeTree({ "a.css": ".k { color: red; }\n" });
		const client = await connect();
		expect(textOf(await client.callTool({ name: "selector", arguments: { query: ".k" } }))).toContain(
			"a.css: L1 (CSS rule)",
		);
	});

	it("given a wrongly typed argument, when calling hover, then the SDK rejects it as an error result", async () => {
		process.env.WEBNAV_MCP_WORKSPACE = makeTree();
		const client = await connect();
		const result = await client.callTool({ name: "hover", arguments: { file_path: "a.ts", line: "one", column: 1 } });
		expect(result.isError).toBe(true);
	});

	it("given an unsupported file type, when calling hover, then it is text and lists the supported extensions", async () => {
		process.env.WEBNAV_MCP_WORKSPACE = makeTree({ "a.md": "x" });
		const client = await connect();
		const text = textOf(await client.callTool({ name: "hover", arguments: { file_path: "a.md", line: 1, column: 1 } }));
		expect(text).toBe(
			"webnav has no language server for 'a.md' (supported: .cjs/.cts/.js/.jsx/.mjs/.mts/.ts/.tsx/.html/.css)",
		);
	});
});

describe("write tools over MCP", () => {
	it("given missing arguments, when calling the write tools, then each answers with a hint as text", async () => {
		process.env.WEBNAV_MCP_WORKSPACE = makeTree({ "a.ts": "export const a = 1;\n" });
		const client = await connect();
		const call = async (name: string, args: Record<string, unknown>) =>
			textOf(await client.callTool({ name, arguments: args }));
		expect(await call("edit", {})).toBe("`file_path` is required.");
		expect(await call("rename_symbol", { name: "a" })).toBe("`new_name` is required.");
		expect(await call("move", { name: "a" })).toBe("`to_file` is required.");
		expect(await call("apply_edit", {})).toBe("`id` is required: the preview id a write tool returned.");
		expect(await call("undo_edit", {})).toBe("There is no applied edit to undo.");
		expect(await call("edit_symbol", {})).toContain("unknown action");
	});

	it("given an edit sent over the protocol, when applied and undone, then the file follows and the result is text", async () => {
		const dir = makeTree({
			"tsconfig.json":
				'{"compilerOptions":{"strict":true,"module":"esnext","moduleResolution":"bundler","noEmit":true},"include":["src"]}',
			"src/a.ts": "export const a = 1;\n",
		});
		process.env.WEBNAV_MCP_WORKSPACE = dir;
		const client = await connect();
		const edited = await client.callTool({
			name: "edit",
			arguments: { file_path: "src/a.ts", old_string: "a = 1", new_string: "a = 2" },
		});
		expect(edited.isError).toBeFalsy();
		expect(textOf(edited)).toContain("Applied as edit");
		expect(fs.readFileSync(path.join(dir, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
		expect(textOf(await client.callTool({ name: "undo_edit", arguments: {} }))).toContain("Reverted edit");
		expect(fs.readFileSync(path.join(dir, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
		const bad = await client.callTool({
			name: "edit",
			arguments: { file_path: "src/a.ts", new_text: "x", max_new_errors: -1 },
		});
		expect(bad.isError).toBe(true);
	}, 60_000);

	it("given a worktree selected through client roots, when editing, then the edit lands in that worktree", async () => {
		const main = makeTree({ "a.css": ".k { color: red; }\n" });
		const worktree = `${main}-wt`;
		const git = (...args: string[]): void => {
			execFileSync("git", ["-C", main, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
		};
		git("init", "-q");
		git("add", ".");
		git("commit", "-qm", "init");
		git("worktree", "add", "-q", worktree);
		cleanups.push(async () => fs.rmSync(worktree, { recursive: true, force: true }));
		delete process.env.WEBNAV_MCP_WORKSPACE;
		process.env.CLAUDE_PROJECT_DIR = main;
		const client = await connect(() => [worktree]);
		const text = textOf(await client.callTool({ name: "rename_symbol", arguments: { name: ".k", new_name: "kk" } }));
		expect(text).toContain("Applied as edit");
		expect(fs.readFileSync(path.join(worktree, "a.css"), "utf8")).toBe(".kk { color: red; }\n");
		expect(fs.readFileSync(path.join(main, "a.css"), "utf8")).toBe(".k { color: red; }\n");
	}, 60_000);
});

describe("workspace selection through client roots", () => {
	function repoWithWorktree(): { main: string; worktree: string } {
		const main = makeTree({ "a.css": ":root { --v: main; }\n" });
		const worktree = `${main}-wt`;
		const git = (...args: string[]): void => {
			execFileSync("git", ["-C", main, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });
		};
		git("init", "-q");
		git("add", ".");
		git("commit", "-qm", "init");
		git("worktree", "add", "-q", worktree);
		fs.writeFileSync(path.join(worktree, "a.css"), ":root { --v: worktree; }\n");
		cleanups.push(async () => fs.rmSync(worktree, { recursive: true, force: true }));
		return { main, worktree };
	}

	it("given a client root that is a worktree of the configured repo, when calling tools, then that worktree is navigated", async () => {
		const { main, worktree } = repoWithWorktree();
		delete process.env.WEBNAV_MCP_WORKSPACE;
		process.env.CLAUDE_PROJECT_DIR = main;
		const client = await connect(() => [worktree]);
		expect(textOf(await client.callTool({ name: "workspace", arguments: {} }))).toBe(
			`${fs.realpathSync(worktree)}\nchosen because: client roots (the MCP client reported this checkout/worktree of the same repository as the configured base ${fs.realpathSync(main)})`,
		);
		expect(textOf(await client.callTool({ name: "css_var", arguments: { name: "--v" } }))).toContain("= worktree");
	}, 30_000);

	it("given a client root from an unrelated project, when calling tools, then it never redirects the server", async () => {
		const { main } = repoWithWorktree();
		delete process.env.WEBNAV_MCP_WORKSPACE;
		process.env.CLAUDE_PROJECT_DIR = main;
		const client = await connect(() => [makeTree({ "a.css": ":root { --v: other; }\n" })]);
		expect(textOf(await client.callTool({ name: "css_var", arguments: { name: "--v" } }))).toContain("= main");
	}, 30_000);

	it("given the roots change between calls, when calling again, then the server follows", async () => {
		const { main, worktree } = repoWithWorktree();
		delete process.env.WEBNAV_MCP_WORKSPACE;
		process.env.CLAUDE_PROJECT_DIR = main;
		let current = main;
		const client = await connect(() => [current]);
		expect(textOf(await client.callTool({ name: "css_var", arguments: { name: "--v" } }))).toContain("= main");
		current = worktree;
		expect(textOf(await client.callTool({ name: "css_var", arguments: { name: "--v" } }))).toContain("= worktree");
	}, 30_000);
});
