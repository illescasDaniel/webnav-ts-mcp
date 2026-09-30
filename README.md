# webnav-ts-mcp

An MCP server that gives AI agents JS/TS/HTML/CSS navigation, plus a
cross-file index of CSS custom properties and `#id`/`.class` selectors that
single-file language servers can't provide. It is the TypeScript port of the
Python [`webnav-mcp`](https://pypi.org/project/webnav-mcp/), so a web project can
add it with its own package manager and have no Python or `uv` in the chain.

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

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `WEBNAV_MCP_WORKSPACE` | unset: follows the client's MCP roots when they name a worktree of the same git repository, else `CLAUDE_PROJECT_DIR`, else the working directory | Pins the project root (never overridden). See the `workspace` tool |
| `WEBNAV_MCP_ROOTS` | the whole workspace as one root, labelled `web` | Comma-separated `label=relative/path` pairs to index separately, e.g. `app=src,prototypes=design` |
| `WEBNAV_MCP_EXCLUDE` | nothing | Comma-separated workspace-relative paths of generated script output (e.g. the JS a TS build emits). Not opened, hidden from `search_symbol`, rejected by the position tools; the CSS/selector index still reads them |

Tool names, parameter names and environment variables are identical to the
Python package, so existing prompts, hosts and configs keep working.

## Differences from the Python package

| | Python `webnav-mcp` | webnav-ts-mcp |
|---|---|---|
| Runtime | Python ≥ 3.11 **and** Node ≥ 18 | Node ≥ 20 only (tested on 22) |
| Language servers | found in the project's `node_modules`, then the package dir, then `PATH`, then `npx --yes` (downloads at first use) | ordinary npm dependencies: a TypeScript ≥ 7 in the *project* wins, else the copy installed with webnav. Nothing is downloaded at runtime |
| Launch | `.bin` shims (`.cmd` special case on Windows) | `node <server>.js`, no shims, no `PATH` dependence |
| JSON-RPC framing | hand-written | [`vscode-jsonrpc`](https://www.npmjs.com/package/vscode-jsonrpc) |
| UTF-16 columns | encode/decode helpers | JS strings already are UTF-16 |
| Cold start (init handshake) | ~530 ms | ~100 ms (see [Speed](#speed)) |

## Layout

```
src/
  cli.ts          stdio entry point (exits when the host closes stdin)
  server.ts       registers the twelve tools on the MCP SDK
  webnav.ts       the tools as plain async functions returning text; owns all state
  webIndex.ts     CSS var / selector index (port of web_index.py)
  langCommand.ts  how to launch tsc / html / css language servers
  glob.ts         just enough glob for jsconfig `include`
  shared/         port of mcp_nav_shared: lspClient, format, resolve, workspace,
                  notices, errors, params, exclude
tests/            vitest; fixtures/sample-app is the shared fixture
scripts/parity.mjs  drives Python and TS servers side by side and diffs the output
```

`shared/` is deliberately a directory, not a second package: see
[Shared library](#the-shared-library).

## Development

```bash
npm install
npm run check     # biome + tsc + vitest (pretest builds dist/)
npm run bench     # speed/memory vs the Python package (same sibling checkout requirement)
npm run parity    # needs the Python webnav-mcp checked out at ../webnav-mcp with `uv sync`; see the script header
node bin/launch.mjs   # checkout launcher: installs + builds when needed, then starts the server
```

Source: [github.com/illescasDaniel/webnav-ts-mcp](https://github.com/illescasDaniel/webnav-ts-mcp).

## Speed

Measured with `npm run bench` on Linux (Node 24, Python venv binary started directly so `uv`'s ~20 ms
is excluded), real MCP over stdio against a real web project (SpaceMaker: 3 roots, ~60 JS/TS/CSS/HTML
files, a 3k-line wireframe), median of 7 alternating runs, 15 warm calls per tool:

| Metric | Python | TypeScript | |
|---|---|---|---|
| Cold start (spawn → `initialize`) | 528 ms | 103 ms | 5.1× |
| First `symbol_info` (spawns `tsc` LSP) | 717 ms | 106 ms | 6.7× |
| First HTML `diagnostics` (spawns HTML server) | 1197 ms | 978 ms | 1.2× |
| Warm `symbol_info` / `references` / `hover` | 8.3 / 7.9 / 7.2 ms | 4.4 / 3.6 / 2.7 ms | ~2× |
| Warm `outline` / `search_symbol` | 7.1 / 8.7 ms | 2.0 / 4.0 ms | 2–3.5× |
| Warm `css_var` / `selector` (own index) | 2.6 / 2.6 ms | 0.5 / 0.7 ms | 4–5× |
| Whole session (connect + every tool once + 15 warm calls each) | 3.5 s | 1.6 s | 2.2× |
| Memory, server + language servers | 477 MiB | 359 MiB | 1.3× |
| Shutdown after stdin closes | 61 ms | 13 ms | 4.6× |

Warm calls are dominated by the language servers, which are identical in both, so the gap there is
the fixed cost of the MCP layer. Launching through `npx webnav-ts-mcp` adds roughly 0.2 s to the
cold start (npm resolving the `.bin` shim); a locally installed copy started with `node` does not.

## Notes from the port

`webnav` is glue: it spawns three Node language servers and formats their answers,
plus a regex-grade index. Nothing in it depends on Python. The MCP SDK, the LSP
plumbing and the file scanning all have first-class Node equivalents.

**Behavioural parity**, measured by `scripts/parity.mjs` (real MCP over stdio,
identical calls, diffed text):

- A real web project ([SpaceMaker](https://github.com/illescasDaniel/SpaceMaker)'s assets, three roots): **37 / 37 identical**
- `tests/fixtures/sample-app`, including edits behind the servers' backs (fix a
  type error, create/delete a file, change a stylesheet, change `jsconfig.json`
  and get the restart notice): **71 / 71 identical** (counting the one intentional
  inherited-member difference below)

The one intentional difference is the reason string of "Cannot read file as
UTF-8 text: …", which is a Python codec detail; the parity script masks it.

**Tests:** 152 vitest tests (unit ports of the index/format tests, real
language servers against the fixture, MCP protocol over an in-memory transport
incl. worktree selection via client roots with a real `git worktree`, LSP
client failure modes, and the built executable). The Python side has ~260 tests
across the two packages; the port covers the behaviour that matters for the
tools, not every case one-to-one.

### Things the port surfaced

- **The MCP SDK's stdio server does not treat stdin EOF as a close.** With a
  language server child alive, the process kept running after the host went
  away (found by installing the tarball and launching via `npx`). `cli.ts` now
  handles `stdin` `end`/`close`; `tests/cli.test.ts` fails without it.
- **UTF-16 handling gets simpler:** JS strings are UTF-16, so the column
  conversion helpers in the Python `format.py`/`lsp_client.py` disappear.
- **One known regex divergence:** Python's `\w` is Unicode-aware, JS's is ASCII.
  The index regexes use `(?<![\w-])` to avoid matching `data-id=`; a non-ASCII
  letter directly before `id=`/`class=`/`style=` is treated differently (a
  match in JS, none in Python). Vanishingly rare in real markup, not covered by
  parity fixtures.
- **Inherited-member lookup needed a different approach.** The Python package
  finds `Class.member` for a member declared on a base class through the LSP's
  type hierarchy, but TypeScript 7's language server advertises no type
  hierarchy (checked against its `initialize` capabilities), so
  `symbol_info("Widget.greet")` used to say "not found" in both implementations.
  This port reads the `extends`/`implements` clauses from the source and resolves
  each base with `textDocument/definition`, breadth-first across files (generic
  bases, qualified names and mixin calls handled; `.d.ts`/`node_modules` bases
  aren't followed). It is the one intentional difference the parity script
  shows.
- **Two tools the Python webnav never had:** the same capability check showed the
  server offers `callHierarchyProvider` and `implementationProvider`, so this
  port adds `callers` and `implementations` (12 tools now; the Python one has 10).

### Costs

- **Install size:** a fresh app installing this next to its own TypeScript 5:
  177 MB `node_modules` (`vscode-langservers-extracted` 66 MB, TypeScript 7
  ~50 MB with its native binary). An app already on TypeScript ≥ 7 shares that
  copy. The Python package had the same npm payload, plus Python.
- **Code size:** ~4.2k lines of TypeScript (2.3k of it in `shared/`) vs ~3.7k
  lines of Python for webnav + the shared library (which also carries
  codenav-only code that wasn't ported).
- **Not ported** (codenav-only in the shared library): `typeDefinition`,
  scratch documents, source-root helpers. (Call hierarchy was ported after all,
  for `callers`.)
- **Not verified:** Windows, macOS, Node 20/24. Only Linux + Node 22.

### The shared library

The user-visible downside of the port is that `mcp-nav-shared` (LSP client,
formatting, symbol resolution, workspace selection) now exists twice. Options,
roughly in order of effort:

1. **Keep `src/shared/` internal to the TS package** (what this package does).
   Zero coordination cost; the two copies can drift. Mitigated by
   `scripts/parity.mjs`, which fails when their output diverges.
2. **Publish it as its own npm package** (`mcp-nav-shared`) only if a second TS
   server appears. `codenav` is tied to `ty` (Python) and has no reason to move.
3. **Retire the Python `webnav-mcp`** and keep only the TS one, leaving
   `mcp-nav-shared` for `codenav-mcp` alone. Removes the duplication, breaks
   `uvx webnav-mcp` users.

The Python shared library's webnav-relevant part is small (LSP client, format,
resolve, workspace, notices), which is why the duplication is tolerable.

## License

MIT. See [LICENSE](https://github.com/illescasDaniel/webnav-ts-mcp/blob/main/LICENSE).
