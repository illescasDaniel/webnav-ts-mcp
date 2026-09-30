/**
 * MCP surface of webnav: registers `Webnav` methods as tools.
 *
 * Tool and parameter names are snake_case. Name-ish
 * parameters are all optional in the schema: a missing one is answered with a
 * short hint by the tool itself, which beats the SDK's schema-validation error
 * for agents that guess `query` vs `name`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { INSTRUCTIONS, Webnav } from "./webnav.js";

const POSITION_DOC =
	"`line` and `column` are 1-indexed. `column` is a UTF-16 character offset on the line " +
	"(not a visual/display column): a leading tab counts as one character.";

const text = (value: string): { content: [{ type: "text"; text: string }] } => ({
	content: [{ type: "text", text: value }],
});

export function createServer(version: string): { server: McpServer; webnav: Webnav } {
	const server = new McpServer({ name: "webnav", version }, { instructions: INSTRUCTIONS });
	const webnav = new Webnav({
		rootsProvider: async () => {
			if (!server.server.getClientCapabilities()?.roots) {
				return undefined;
			}
			return (await server.server.listRoots()).roots.map((root) => root.uri);
		},
	});

	const position = {
		file_path: z.string(),
		line: z.number().int(),
		column: z.number().int(),
	};

	server.registerTool(
		"hover",
		{
			description: `Get type/documentation info for the symbol at a position.\n\n${POSITION_DOC}`,
			inputSchema: position,
		},
		async ({ file_path, line, column }) => text(await webnav.hover(file_path, line, column)),
	);

	server.registerTool(
		"workspace",
		{
			description:
				"Which directory is webnav navigating, and why? Use when results look like they come from the wrong checkout/worktree.",
			inputSchema: {},
		},
		async () => text(await webnav.workspace()),
	);

	server.registerTool(
		"definition",
		{
			description:
				"Go to the definition of the symbol at a position.\n\n" +
				`${POSITION_DOC} On a \`--custom-property\`/\`#id\`/\`.class\` token in a \`.css\`/` +
				'`.html` file (or a name inside an HTML `id="..."`/`class="..."` value), ' +
				"answers from the cross-file index (see css_var/selector) " +
				"instead of the single-file language server: for `definition`, just the " +
				"definition(s) in the file's own root (each `WEBNAV_MCP_ROOTS` root " +
				"is separate); for `references`, that root's definitions and usages.",
			inputSchema: position,
		},
		async ({ file_path, line, column }) => text(await webnav.definition(file_path, line, column)),
	);

	server.registerTool(
		"references",
		{
			description:
				"Find all usages of the symbol at a position across the workspace.\n\n" +
				`${POSITION_DOC} On a \`--custom-property\`/\`#id\`/\`.class\` token in a \`.css\`/` +
				'`.html` file (or a name inside an HTML `id="..."`/`class="..."` value), ' +
				"answers from the cross-file index (see css_var/selector) " +
				"instead of the single-file language server, limited to the file's own root " +
				"(each `WEBNAV_MCP_ROOTS` root is separate) unless it has no hits there.",
			inputSchema: { ...position, include_declaration: z.boolean().default(true) },
		},
		async ({ file_path, line, column, include_declaration }) =>
			text(await webnav.references(file_path, line, column, include_declaration)),
	);

	server.registerTool(
		"search_symbol",
		{
			description:
				"Search JS/TS files for a symbol by name (function, class, const, etc.).\n\n" +
				"JS/TS-only: the HTML/CSS language servers don't implement useful " +
				"workspace-wide symbol search (webnav does not reimplement it). Prefer " +
				"`symbol_info` for a one-call summary. Returned positions point at the " +
				"identifier name and use the same character-offset column convention as " +
				"the other tools. Results include a SymbolKind label and are capped. " +
				"`name` is accepted as an alias for `query`. Narrow broad queries with " +
				"`kind` (SymbolKind labels, comma-separated: `class`, `function,method`, " +
				"`interface`, ...) and `path` (workspace-relative prefix such as `src/`, " +
				"or a glob such as `src/**/*.ts`). Production code ranks before tests. " +
				"Loose fuzzy hits whose names don't contain the query are summarised as a " +
				"count when real matches exist; pass `fuzzy=true` to list them too.",
			inputSchema: {
				query: z.string().optional(),
				name: z.string().optional(),
				kind: z.string().optional(),
				path: z.string().optional(),
				fuzzy: z.boolean().default(false),
			},
		},
		async (args) => text(await webnav.searchSymbol(args)),
	);

	server.registerTool(
		"symbol_info",
		{
			description:
				'What is X and where is it used? Example: `symbol_info(name="renderSidebar")`.\n\n' +
				"One-call summary for a JS/TS name: header, hover text, definition, and " +
				"references grouped by file, the usual first lookup instead of chaining " +
				"search_symbol → hover → definition → references by hand. Pass `file_path` " +
				"to disambiguate; `query` is accepted as an alias for `name`. For CSS/HTML " +
				"cross-file lookups use `css_var` / `selector` instead.",
			inputSchema: {
				name: z.string().optional(),
				query: z.string().optional(),
				file_path: z.string().optional(),
				include_references: z.boolean().default(true),
			},
		},
		async ({ name, query, file_path, include_references }) =>
			text(await webnav.symbolInfo({ name, query, filePath: file_path, includeReferences: include_references })),
	);

	server.registerTool(
		"callers",
		{
			description:
				'Who calls this function? Example: `callers(name="renderSidebar")`.\n\n' +
				"Narrower than references, since it leaves out imports and type-only usages " +
				"and only lists actual call sites, each with the calling function and its " +
				"call-site lines. `name` resolves the same way as symbol_info (dotted " +
				"`Class.method` accepted, inherited members included; pass `file_path` to " +
				"disambiguate a common name). `query` is accepted as an alias for `name`. JS/TS only.",
			inputSchema: { name: z.string().optional(), query: z.string().optional(), file_path: z.string().optional() },
		},
		async ({ name, query, file_path }) => text(await webnav.callers({ name, query, filePath: file_path })),
	);

	server.registerTool(
		"implementations",
		{
			description:
				'Who implements or extends this? Example: `implementations(name="Shape")`.\n\n' +
				"For an interface or class, lists the classes that implement or extend it " +
				"(transitively); for an interface or abstract method (`Shape.area`), lists the " +
				"methods that implement it. Backed by the language server's " +
				"`textDocument/implementation`, so it follows the type checker, not naming. " +
				"`name` resolves like symbol_info (pass `file_path` to disambiguate); `query` is " +
				"accepted as an alias. JS/TS only.",
			inputSchema: { name: z.string().optional(), query: z.string().optional(), file_path: z.string().optional() },
		},
		async ({ name, query, file_path }) => text(await webnav.implementations({ name, query, filePath: file_path })),
	);

	server.registerTool(
		"outline",
		{
			description:
				'What\'s in this file? Example: `outline(file_path="src/app.ts")`.\n\n' +
				"Indented outline (functions, classes, interfaces, with `:start-end` line " +
				"spans) of a JS/TS file in source order, so you can navigate without reading " +
				"it in full. Locals, callbacks and object-literal keys inside functions and " +
				"variables are left out; pass `detailed=true` to include them. Follow up " +
				"with hover/definition/references at a listed line, or symbol_info by name.",
			inputSchema: { file_path: z.string(), detailed: z.boolean().default(false) },
		},
		async ({ file_path, detailed }) => text(await webnav.outline(file_path, detailed)),
	);

	server.registerTool(
		"diagnostics",
		{
			description:
				"Get the relevant language server's diagnostics (errors/warnings) for a single file.\n\n" +
				"For `.css`/`.html` files, this also includes index-derived warnings the " +
				"single-file language server can't see: `var(--x)` used with no matching " +
				"declaration anywhere in the same indexed root, and CSS selectors " +
				"(`#id`/`.class`) with no HTML/JS reference in that root.",
			inputSchema: { file_path: z.string() },
		},
		async ({ file_path }) => text(await webnav.diagnostics(file_path)),
	);

	server.registerTool(
		"css_var",
		{
			description:
				'Where is this `--custom-property` defined and used? Example: `css_var(name="--bg")`.\n\n' +
				"The CSS/HTML language servers only see one file at a time, so `var(--x)` " +
				"usages can't be cross-referenced across files that way. This scans " +
				'`.css` files and HTML `<style>`/`style="…"` blocks/attributes instead. ' +
				"`name` may be given with or without the leading `--`. Definitions (value " +
				"+ enclosing context, e.g. `@media (prefers-color-scheme: dark) › :root`) " +
				"and usages (grouped by file with line numbers) are reported separately per " +
				"configured root (see `WEBNAV_MCP_ROOTS`; a single unnamed root by default), " +
				"since each may define its own values. `query` is accepted as an alias for `name`.",
			inputSchema: { name: z.string().optional(), query: z.string().optional() },
		},
		async (args) => text(await webnav.cssVar(args)),
	);

	server.registerTool(
		"selector",
		{
			description:
				'Who uses this `#id` or `.class`? Example: `selector(name=".card-title")`.\n\n' +
				"Looks up the selector across the whole workspace.\n\n" +
				"Cross-references CSS rule definitions, HTML `id=`/`class=` attributes, " +
				"and JS usages (`getElementById`, `classList.add/remove/toggle/contains`, " +
				"`querySelector`/`querySelectorAll`, `className` assignment, and any JS " +
				"string literal exactly equal to the bare name, e.g. an id passed to a " +
				'project\'s own helper like `onClick("btn-save", …)`, labeled "string ' +
				'literal"). Hits in generated output (`WEBNAV_MCP_EXCLUDE`) are labeled ' +
				"`[generated]`; edit their source instead. This is something " +
				"the single-file CSS/HTML language servers can't do. `name` must include " +
				"the leading `#` or `.`. Grouped by file with line numbers, separately per " +
				"configured root (see `WEBNAV_MCP_ROOTS`). A JS hit built from string " +
				'concatenation (e.g. `getElementById("view-" + x)`) is reported against ' +
				'only its static prefix and labeled "dynamic partial match"; a query whose ' +
				"name starts with such a prefix (e.g. `#view-components` against a stored " +
				'`#view-`) also surfaces that hit, labeled "dynamic partial match via ' +
				"'<prefix>'\", instead of being silently dropped or guessed. `query` is " +
				"accepted as an alias for `name`.",
			inputSchema: { name: z.string().optional(), query: z.string().optional() },
		},
		async (args) => text(await webnav.selectorLookup(args)),
	);

	return { server, webnav };
}
