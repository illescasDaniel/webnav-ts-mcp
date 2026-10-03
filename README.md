# webnav-ts-mcp

An MCP server that gives AI agents JS/TS/HTML/CSS navigation, plus a
cross-file index of CSS custom properties and `#id`/`.class` selectors that
single-file language servers can't provide, and write tools that type-check an
edit before it is written. It needs only Node.js and installs with a web
project's own package manager.

## Quick start

You need Node.js ≥ 20:

```bash
npx webnav-ts-mcp
```

Register it with your MCP host. For Claude Code, from the project root:

```bash
claude mcp add webnav -- npx webnav-ts-mcp
```

Or add it to a project `.mcp.json` (Claude Code) or `.cursor/mcp.json` (Cursor):

```json
{
	"mcpServers": {
		"webnav": {
			"command": "npx",
			"args": ["webnav-ts-mcp"]
		}
	}
}
```

In Cursor, also set `"env": {"WEBNAV_MCP_WORKSPACE": "${workspaceFolder}"}`,
because Cursor may start MCP servers with your home directory as the working
directory.

To pin it per project instead of resolving through `npx` each time:

```bash
npm install --save-dev webnav-ts-mcp
```

## Language servers

Requests are routed to three Node language servers by file extension:

| Extension | Backend |
|-----------|---------|
| `.js` / `.mjs` / `.cjs` / `.jsx` / `.ts` / `.mts` / `.cts` / `.tsx` | TypeScript 7 native LSP: `tsc --lsp --stdio` (JS via `allowJs` / `jsconfig.json`) |
| `.html` | `vscode-html-language-server` |
| `.css` | `vscode-css-language-server` |

They are ordinary npm dependencies, so nothing is downloaded at runtime. A
TypeScript ≥ 7 in the navigated project wins; otherwise the copy installed with
webnav-ts-mcp is used. (An app on an older TypeScript still works, at the cost of
the extra install size: see [Costs](#costs).)

## Tools

**For JS/TS, start with the name-based tools:**

| Tool | Answers |
|------|---------|
| `symbol_info` | What is this? Header, hover, definition and references in one call |
| `outline` | What's in this file? (source order; locals and imports left out unless `detailed=true`) |
| `callers` | Who calls this function/method? (call hierarchy) |
| `implementations` | Who implements/extends this interface, class or method? |
| `search_symbol` | JS/TS workspace symbol search (ranked, capped; optional `kind=` / `path=` filters) |
| `workspace` | Which directory is being navigated, and why |

Then use the position tools once you have a `path:line:col`:

| Tool | Answers |
|------|---------|
| `hover` | Type and docs at a position |
| `definition` | Go to definition (CSS/HTML tokens answer from the index below) |
| `references` | All usages (CSS/HTML tokens answer from the index below) |
| `diagnostics` | Language-server diagnostics; CSS/HTML also get unreferenced-selector and undefined-variable warnings |

**Cross-file CSS/HTML index:**

| Tool | Answers |
|------|---------|
| `css_var` | Where is `--name` defined and used? |
| `selector` | Where is `#id` or `.class` defined and used (CSS, HTML, JS)? |

`search_symbol`, `symbol_info`, `outline`, `callers` and `implementations` are
**JS/TS only**. Use `css_var` and `selector` for markup and stylesheets.
`name` and `query` are accepted as aliases of each other on the name-based tools.
Positions are **1-indexed**; `column` is a UTF-16 character offset (a leading
tab counts as one character).

## Write tools: change code with a type check before every write

The navigation tools above are read-only. These change code, and share one rule:
**the edit is shown to the language servers as an in-memory overlay first, the
edited files and the script files importing them are re-checked, and the
response says which diagnostics the edit would add or fix. Nothing is written
until that is on the table.**

| Tool | Does |
|------|------|
| `edit` | Type-checked text edit of a JS/TS/HTML/CSS file: `old_string`/`new_string` or a whole `new_text` (also creates a file). For anything that is not a whole definition. Line endings follow the file |
| `edit_symbol` | `action="replace"` / `"insert"` / `"delete"` a function, class, interface, enum, const or member by name: re-indented to the file's own style (tabs or spaces), doc comment kept, `imports=[...]` merged into the file, blank-line spacing handled. Delete refuses while anything uses the symbol and prunes imports only the deleted code used |
| `rename_symbol` | JS/TS: rename through the TypeScript language server (imports, aliases, overriding members; `parameter=` for one parameter). CSS/HTML: a name starting with `--`, `#` or `.` renames that custom property / id / class across stylesheets, `<style>` and `style=""`, markup (`class`, `id`, `for`, `aria-*`, `href="#id"`) and scripts (`getElementById`, `classList`, `querySelector`, `className`, `setProperty`, markup in strings). Names built dynamically and script strings that merely equal the name are listed, not renamed; other places still using the old name (docs, `.vue`/`.scss`, strings) are listed too |
| `move` | With `name`: move a top-level function/class/interface/type/const to another file with the imports it needs, repoint every importer and re-export, drop imports only the moved code used, warn about import cycles. Without it: move or rename the file `file_path` (any file): imports (the language server's own rewrite), `<script src>`/`<link href>`/`<img src>` and CSS `url()`/`@import` follow, and the moved file's own relative references are re-based |
| `quick_fix` | Apply the language server's own fixes (missing imports, misspellings, ...) one by one, re-checking after each; or a source action: `organize_imports`, `remove_unused_imports`, `sort_imports`, `fix_all`. Ambiguous fixes are listed instead of guessed |
| `verify_changes` | After editing with any tool (your own included): which diagnostics the working tree gained or lost since a git revision (default `HEAD`) |
| `apply_edit` / `undo_edit` | Write a previewed edit by id; revert an applied one |

One rule for every write tool: it writes when the edit adds no more than
`max_new_errors` (default 0) errors in the edited files and their importers and
the result parses. Otherwise nothing is written and you get the diagnostics plus
an id for `apply_edit`. `apply=false` always previews. Hints and warnings are
shown but not counted. Syntax errors (TypeScript's 1xxx codes, any CSS error)
block a write even with `max_new_errors=null`.

Safety rules, enforced in code:

- Only `.js`/`.mjs`/`.cjs`/`.jsx`/`.ts`/`.mts`/`.cts`/`.tsx`/`.html`/`.css` files inside the
  workspace are edited (`move` also carries any file, such as an image a stylesheet
  uses); `node_modules`, `dist`, `.git` and the other skipped folders, generated output
  (`WEBNAV_MCP_EXCLUDE`) and symlinks are refused.
- A preview remembers the exact bytes of every file; `apply_edit` refuses if any file
  changed since. Files are replaced atomically (temp file + rename), and a failure
  part-way restores the ones already written.
- Every applied edit is undoable (`undo_edit`) unless a file was changed after it.
- Line endings and a leading BOM are preserved.
- Edits touching more than 40 files need `allow_large=true`.
- `WEBNAV_MCP_READ_ONLY=1` turns every write into a refusal (previews still work).

Scope: the importers that get re-checked are found by relative `import`/`export
... from`/`require()`/`import()` specifiers (`./a`, `./a.js` for `a.ts`, `./dir`
for `dir/index.ts`); a file reached only through a path alias is checked with its
own edit alone. `move`'s HTML/CSS rewrite understands relative and root-absolute
(`/src/main.ts`) references; bundler config, path aliases and string paths are
listed as mentions, not rewritten. HTML/CSS edits are checked by their language
servers (syntax and CSS lint), not against the cross-file index.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEBNAV_MCP_WORKSPACE` | unset: follows the client's MCP roots when they name a worktree of the same git repository, else `CLAUDE_PROJECT_DIR`, else the working directory | Pins the project root (never overridden). See the `workspace` tool |
| `WEBNAV_MCP_ROOTS` | the whole workspace as one root, labelled `web` | Comma-separated `label=relative/path` pairs to index separately, e.g. `app=src,prototypes=design` |
| `WEBNAV_MCP_EXCLUDE` | nothing | Comma-separated workspace-relative paths of generated script output (e.g. the JS a TS build emits). Not opened, hidden from `search_symbol`, rejected by the position tools; the CSS/selector index still reads them |
| `WEBNAV_MCP_READ_ONLY` | unset | `1`/`true`: write tools refuse to write (previews and checks still work) |
| `WEBNAV_MCP_PUBLIC` | nothing | Comma-separated workspace-relative stylesheets (files or directories) that are a public API, e.g. a design-token file consumed by other projects. `diagnostics` stops reporting their custom properties as "declared but never used" and their selectors as "never referenced"; undefined `var()` usages are still reported |

## Layout

```
src/
  cli.ts          stdio entry point (exits when the host closes stdin)
  server.ts       registers the tools on the MCP SDK
  webnav.ts       the tools as plain async functions returning text; owns all state
  webIndex.ts     CSS var / selector index
  langCommand.ts  how to launch tsc / html / css language servers
  glob.ts         just enough glob for jsconfig `include`
  shared/         lspClient, format, resolve, workspace, notices, errors,
                  params, exclude
  write/          the write tools: edits (plans, diffs), transaction (guard,
                  journal, undo), simulate + diagnosticsDelta (the type check),
                  finish (preview/apply), one module per tool, webTokens
                  (CSS var/id/class finder), jsImports (import rewriting)
tests/            vitest; fixtures/sample-app is the shared fixture
```

## Development

```bash
npm install
npm run check     # biome + tsc + vitest (pretest builds dist/)
npm run upload    # check + publish to npm (--build-only / --dry-run / --otp CODE after `--`); needs `npm login`
npm run test-package  # install the published version in a throwaway project and drive it over MCP stdio
node bin/launch.mjs   # checkout launcher: installs + builds when needed, then starts the server
```

Source: [github.com/illescasDaniel/webnav-ts-mcp](https://github.com/illescasDaniel/webnav-ts-mcp).

## Design notes

`webnav` is glue: it spawns three Node language servers and formats their answers,
plus a regex-grade index.

**Tests:** vitest (unit tests for the index/format code and the pure parts of the
write tools, real language servers against the fixture and temporary projects,
MCP protocol over an in-memory transport incl. worktree selection via client roots
with a real `git worktree`, LSP client failure modes, and the built executable).

### Things worth knowing

- **The MCP SDK's stdio server does not treat stdin EOF as a close.** With a
  language server child alive, the process kept running after the host went
  away (found by installing the tarball and launching via `npx`). `cli.ts` now
  handles `stdin` `end`/`close`; `tests/cli.test.ts` fails without it.
- **Columns are UTF-16 offsets,** which is what LSP uses and what JS strings
  already are, so no conversion is needed.
- **Regex index limit:** `\w` is ASCII in JS. The index regexes use
  `(?<![\w-])` to avoid matching `data-id=`, so a non-ASCII letter directly
  before `id=`/`class=`/`style=` still counts as a match. Vanishingly rare in
  real markup.
- **Inherited-member lookup needs a different approach.** TypeScript 7's
  language server advertises no type hierarchy (checked against its `initialize`
  capabilities), so a member declared on a base class can't be found that way.
  webnav reads the `extends`/`implements` clauses from the source and resolves
  each base with `textDocument/definition`, breadth-first across files (generic
  bases, qualified names and mixin calls handled; `.d.ts`/`node_modules` bases
  aren't followed).
- **`callers` and `implementations`** are offered because the server advertises
  `callHierarchyProvider` and `implementationProvider`.
- **Type-checking an edit without writing it** relies on documents the client
  opens with `didOpen`/`didChange` shadowing the disk (`LspClient.withOverlay`).
  tsc's native server resolves imports of a file that exists only as an overlay,
  but needs its *directory* to exist and remembers a failed resolution, so the
  overlay opens new files first and creates (then removes) empty directories.
- **A file with no `import`/`export` is a global script** to TypeScript. Moving
  the last export out of a module turns it into one, and every top-level name in
  it becomes visible everywhere; the type check can then miss references that
  should have broken.
- **Symbol ranges from `documentSymbol` are tight:** no doc comment, no
  `export const` keyword, one symbol per declarator. `edit_symbol` and `move`
  widen them (`extentOf`) and refuse declarators that share a statement.
- **The server's unused-import hints identify what a deletion orphaned:** hints
  after the edit minus hints before it, so imports that were already unused stay.

### Costs

- **Install size:** a fresh app installing this next to its own TypeScript 5:
  177 MB `node_modules` (`vscode-langservers-extracted` 66 MB, TypeScript 7
  ~50 MB with its native binary). An app already on TypeScript ≥ 7 shares that
  copy.
- **Not verified:** Windows, macOS, Node 20/24. Only Linux + Node 22.

## License

MIT. See [LICENSE](https://github.com/illescasDaniel/webnav-ts-mcp/blob/main/LICENSE).
