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

const WRITE_RULE =
	"The edit is shown to the language servers as an in-memory overlay first and the edited files and the " +
	"files importing them are re-checked: it is written only when that adds no more errors than " +
	"`max_new_errors` (default 0; null = no limit) and the result parses. Otherwise nothing is written and " +
	"you get the new diagnostics plus a preview id for `apply_edit`. `apply=false` always previews. " +
	"`undo_edit` reverts an applied edit.";

const WRITES = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const READS = { readOnlyHint: true, openWorldHint: false };

const writeParams = {
	apply: z.boolean().default(true),
	max_new_errors: z.number().int().min(0).nullable().optional(),
};

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

	registerWriteTools(server, webnav);

	return { server, webnav };
}

function registerWriteTools(server: McpServer, webnav: Webnav): void {
	server.registerTool(
		"edit",
		{
			description:
				'Edit text in a JS/TS/HTML/CSS file, type-checked: `edit(file_path="src/app.ts", old_string="x = 1", new_string="x = 2")`.\n\n' +
				"For changes that are not a whole definition (a few lines, an import, a rule, markup) or for rewriting a " +
				"whole file (`new_text`, which also creates a new file). To replace, add or delete a function/class/method " +
				"by name use `edit_symbol`. `old_string` must match exactly once unless `replace_all=true` " +
				"(line endings follow the file). `include_dependents=false` skips checking the importers. " +
				WRITE_RULE,
			inputSchema: {
				file_path: z.string().optional(),
				old_string: z.string().optional(),
				new_string: z.string().optional(),
				replace_all: z.boolean().default(false),
				new_text: z.string().optional(),
				include_dependents: z.boolean().default(true),
				...writeParams,
			},
			annotations: WRITES,
		},
		async ({ max_new_errors, ...a }) =>
			text(
				await webnav.edit({
					filePath: a.file_path,
					oldString: a.old_string,
					newString: a.new_string,
					replaceAll: a.replace_all,
					newText: a.new_text,
					includeDependents: a.include_dependents,
					apply: a.apply,
					maxNewErrors: max_new_errors,
				}),
			),
	);

	server.registerTool(
		"edit_symbol",
		{
			description:
				"Replace, add or delete a JS/TS function, class, interface, enum, const or member by name. Examples: " +
				'`edit_symbol(action="replace", name="Cart.total", source="total(): number { ... }")`, ' +
				'`edit_symbol(action="insert", file_path="src/utils.ts", name="parse", source="function helper() {}")`, ' +
				'`edit_symbol(action="delete", name="legacyParse")`.\n\n' +
				'- `action="replace"`: `name` (dotted `Class.method` ok) and `source` (the complete new definition, ' +
				"decorators included; re-indented to the old one's place in the file's own indent style). The doc comment " +
				"above is kept unless `source` brings its own. A changed signature shows up as errors at call sites.\n" +
				'- `action="insert"`: `source` and `file_path`. `position` is relative to `name`: "after" (default when ' +
				'`name` is given) / "before" a symbol, "into" a class/interface/enum/namespace (appended to its body), or ' +
				'"end" of the file (default without `name`; creates the file if missing). Refuses a name that already exists there.\n' +
				'- `action="delete"`: `name` only. Refuses while anything still uses it and lists the users (`force=true` ' +
				"deletes anyway and shows what breaks). Imports only the deleted code used are removed (`prune_imports`). " +
				"Strings, comments and docs naming it are listed and the deletion is previewed instead of applied.\n\n" +
				"`file_path` narrows `name` when several symbols share it. `imports` (replace/insert) is a list of " +
				'import statements the new code needs (`["import { Money } from \\"./money\\""]`), merged into the file if missing. ' +
				WRITE_RULE,
			inputSchema: {
				action: z.enum(["replace", "insert", "delete"]).optional(),
				name: z.string().optional(),
				source: z.string().optional(),
				file_path: z.string().optional(),
				position: z.enum(["after", "before", "into", "end"]).optional(),
				imports: z.array(z.string()).optional(),
				force: z.boolean().default(false),
				prune_imports: z.boolean().default(true),
				...writeParams,
			},
			annotations: WRITES,
		},
		async ({ max_new_errors, ...a }) =>
			text(
				await webnav.editSymbol({
					action: a.action,
					name: a.name,
					source: a.source,
					filePath: a.file_path,
					position: a.position,
					imports: a.imports,
					force: a.force,
					pruneImports: a.prune_imports,
					apply: a.apply,
					maxNewErrors: max_new_errors,
				}),
			),
	);

	server.registerTool(
		"rename_symbol",
		{
			description:
				'Rename a symbol everywhere it is used. Examples: `rename_symbol(name="Cart.total", new_name="sum")`, ' +
				'`rename_symbol(name="--accent", new_name="--brand")`, `rename_symbol(name=".card-title", new_name="heading")`.\n\n' +
				"JS/TS: give `name` (dotted `Class.method` ok; `file_path` narrows it) or `file_path` + `line` + `column` " +
				"(1-indexed). Built on the TypeScript language server's rename (imports, aliases, overriding members); " +
				'`parameter="x"` with a function\'s name renames one parameter. Places that still say the old name that ' +
				"the type checker cannot link (strings, comments, docs, other languages) are listed.\n\n" +
				"CSS/HTML: a `name` starting with `--`, `#` or `.` renames that custom property / id / class across " +
				"stylesheets (declarations, `var()`, selectors), HTML (`class`, `id`, and the attributes that refer to ids: " +
				'`for`, `aria-*`, `href="#id"`) and scripts (`getElementById`, `classList`, `querySelector`, `className`, ' +
				'`setProperty`/`getPropertyValue`, markup inside strings). Names built dynamically (`"row-" + id`) are listed, ' +
				"not renamed; script string literals that merely equal the name are listed and renamed only with " +
				"`include_string_literals=true`. Refuses a new name that already exists (`force=true` merges). With several " +
				"`WEBNAV_MCP_ROOTS` pass `file_path` to say which root. " +
				WRITE_RULE,
			inputSchema: {
				new_name: z.string().optional(),
				name: z.string().optional(),
				file_path: z.string().optional(),
				line: z.number().int().optional(),
				column: z.number().int().optional(),
				parameter: z.string().optional(),
				force: z.boolean().default(false),
				include_string_literals: z.boolean().default(false),
				allow_large: z.boolean().default(false),
				...writeParams,
			},
			annotations: WRITES,
		},
		async ({ max_new_errors, ...a }) =>
			text(
				await webnav.renameSymbol({
					newName: a.new_name,
					name: a.name,
					filePath: a.file_path,
					line: a.line,
					column: a.column,
					parameter: a.parameter,
					force: a.force,
					includeStringLiterals: a.include_string_literals,
					allowLarge: a.allow_large,
					apply: a.apply,
					maxNewErrors: max_new_errors,
				}),
			),
	);

	server.registerTool(
		"move",
		{
			description:
				"Move a declaration to another file, or a whole file, and fix every reference. Examples: " +
				'`move(name="parseDate", to_file="src/app/dates.ts")`, `move(file_path="src/old/util.ts", to_file="src/lib/util.ts")`.\n\n' +
				"With `name`: moves that top-level function/class/interface/enum/type/const (`file_path` narrows which). " +
				"The destination is created if missing; the code gets the imports it needs (found by the language server), " +
				'`export` is added if it was private, every `import { name } from "old"` elsewhere is repointed, the old ' +
				"file imports it from the new place if it still uses it (`keep_reexport=true` also leaves `export { name } " +
				'from "new"`), and imports only the moved code used are dropped. Import cycles are warned about.\n\n' +
				"Without `name`: `file_path` is the file to move or rename (any file; `to_file` may be a directory). Every " +
				"import/re-export in JS/TS (the language server's own rewrite), `<script src>`/`<link href>`/`<img src>` in " +
				"HTML (relative and root-absolute), and `url()`/`@import` in CSS follow, and the moved file's own relative " +
				"references are re-based. Configs, path aliases and string paths are listed, not rewritten. " +
				WRITE_RULE,
			inputSchema: {
				to_file: z.string().optional(),
				name: z.string().optional(),
				file_path: z.string().optional(),
				keep_reexport: z.boolean().default(false),
				allow_large: z.boolean().default(false),
				...writeParams,
			},
			annotations: WRITES,
		},
		async ({ max_new_errors, ...a }) =>
			text(
				await webnav.move({
					toFile: a.to_file,
					name: a.name,
					filePath: a.file_path,
					keepReexport: a.keep_reexport,
					allowLarge: a.allow_large,
					apply: a.apply,
					maxNewErrors: max_new_errors,
				}),
			),
	);

	server.registerTool(
		"quick_fix",
		{
			description:
				'Apply the TypeScript language server\'s own fixes to a JS/TS file: `quick_fix(file_path="src/app.ts")`.\n\n' +
				"`action=\"fix\"` (default) fixes the file's errors one by one with the server's code actions (missing " +
				"imports, misspelled names, ...), re-checking after each; `line` limits it to errors starting on that line. " +
				"A fix with several candidates is listed, not guessed. The other actions are source actions on the whole " +
				"file: `organize_imports`, `remove_unused_imports`, `sort_imports`, `fix_all`. " +
				WRITE_RULE,
			inputSchema: {
				file_path: z.string().optional(),
				line: z.number().int().optional(),
				action: z.enum(["fix", "organize_imports", "remove_unused_imports", "sort_imports", "fix_all"]).optional(),
				...writeParams,
			},
			annotations: WRITES,
		},
		async ({ max_new_errors, ...a }) =>
			text(
				await webnav.quickFix({
					filePath: a.file_path,
					line: a.line,
					action: a.action,
					apply: a.apply,
					maxNewErrors: max_new_errors,
				}),
			),
	);

	server.registerTool(
		"verify_changes",
		{
			description:
				"What did the edits since a git revision break? Compares the language servers' diagnostics now against " +
				"`since` (default `HEAD`).\n\nRun it after editing with any tool (your own Edit/Write included): the " +
				"changed JS/TS/HTML/CSS files and the script files importing them are checked, with the committed versions " +
				'substituted in for the "before" side. Read-only.',
			inputSchema: { since: z.string().default("HEAD"), include_dependents: z.boolean().default(true) },
			annotations: READS,
		},
		async ({ since, include_dependents }) =>
			text(await webnav.verifyChanges({ since, includeDependents: include_dependents })),
	);

	server.registerTool(
		"apply_edit",
		{
			description:
				"Write a previewed edit (the id comes from a write tool's preview). Fails, writing nothing, if any file " +
				"changed since the preview.",
			inputSchema: { id: z.string().optional(), allow_large: z.boolean().default(false) },
			annotations: WRITES,
		},
		async ({ id, allow_large }) => text(await webnav.applyEdit(id ?? "", allow_large)),
	);

	server.registerTool(
		"undo_edit",
		{
			description:
				"Revert an edit applied by the write tools (the latest one by default). Refuses when any of its files " +
				"changed after the edit, so later work is never overwritten.",
			inputSchema: { id: z.string().optional() },
			annotations: WRITES,
		},
		async ({ id }) => text(await webnav.undoEdit(id)),
	);
}
