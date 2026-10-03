/**
 * webnav: JS/TS/HTML/CSS navigation as plain async functions returning tool text.
 *
 * Multiplexes three Node-based language servers behind one tool set, routed by
 * file extension: TypeScript 7's native `tsc --lsp --stdio` for
 * `.js`/`.mjs`/`.cjs`/`.jsx` (via `allowJs`) and `.ts`/`.mts`/`.cts`/`.tsx`,
 * and `vscode-html-language-server` / `vscode-css-language-server` for
 * `.html`/`.css`, plus the workspace-wide CSS custom-property / selector index
 * (`css_var`, `selector`). `server.ts` exposes these methods as MCP tools.
 *
 * All state (workspace root, language-server clients, index config) lives on a
 * `Webnav` instance so tests can run several side by side.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { globFiles } from "./glob.js";
import { resolveCssCommand, resolveHtmlCommand, resolveTsCommand } from "./langCommand.js";
import { dropImportSymbols } from "./outlineImports.js";
import { formatToolError, isToolError, ToolInputError } from "./shared/errors.js";
import { isExcluded } from "./shared/exclude.js";
import {
	filterSymbolsByKindAndPath,
	formatCallers,
	formatDiagnostics,
	formatLocation,
	formatOutline,
	formatReferences,
	formatReferencesGrouped,
	formatWorkspaceSymbols,
	LOCALS_HOLDER_KINDS,
	parseKindFilter,
	pyRepr,
	symbolAt,
	symbolKindLabel,
	uriToRelative,
} from "./shared/format.js";
import { LspClient } from "./shared/lspClient.js";
import type { LspHover, LspLocation } from "./shared/lspTypes.js";
import { NoticeBoard } from "./shared/notices.js";
import { resolveNameQuery } from "./shared/params.js";
import { relativeWithin, resolveReal } from "./shared/paths.js";
import { resolveSymbol } from "./shared/resolve.js";
import { readTextStrict, splitLines } from "./shared/text.js";
import { type RootsProvider, WorkspaceSelector } from "./shared/workspace.js";
import * as webIndex from "./webIndex.js";
import { applyEdit, undoEdit } from "./write/applyTools.js";
import type { ToolHost } from "./write/common.js";
import { type EditArgs, edit } from "./write/editTool.js";
import type { WriteState } from "./write/finish.js";
import { type QuickFixArgs, quickFix } from "./write/fixTools.js";
import { type MoveArgs, move } from "./write/moveTool.js";
import { type RenameArgs, renameSymbol } from "./write/renameTool.js";
import { type EditSymbolArgs, editSymbol } from "./write/symbolTools.js";
import { EditJournal, PlanStore, readOnlyFromEnv, WriteGuard } from "./write/transaction.js";
import { verifyChanges } from "./write/verifyTool.js";

const JS_EXTENSIONS = [".js", ".mjs", ".cjs"];
const TS_EXTENSIONS = [".ts", ".mts", ".cts"];
// Everything the one TypeScript language-server instance serves.
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([...JS_EXTENSIONS, ...TS_EXTENSIONS, ".jsx", ".tsx"]);
const SCRIPT_LANGUAGE_IDS: Record<string, string> = {
	...Object.fromEntries(JS_EXTENSIONS.map((ext) => [ext, "javascript"])),
	...Object.fromEntries(TS_EXTENSIONS.map((ext) => [ext, "typescript"])),
	".jsx": "javascriptreact",
	".tsx": "typescriptreact",
};
// The TS language server reads these once at startup; a change restarts it.
const TS_CONFIG_NAMES: ReadonlySet<string> = new Set(["tsconfig.json", "jsconfig.json", "package.json"]);
const SUPPORTED_EXTENSIONS_TEXT = [...[...SCRIPT_EXTENSIONS].sort(), ".html", ".css"].join("/");

const POSITION_NOTE =
	"Positions are 1-indexed. `column` is a UTF-16 character offset on the " +
	"line (not a visual/display column): a leading tab counts as one " +
	"character, so after a single tab the next character starts at column 2.";

export const INSTRUCTIONS =
	"Code navigation for this project's JS/TS/HTML/CSS, backed by " +
	"TypeScript 7 native tsc LSP (JS/TS) and vscode-langservers-extracted " +
	"(HTML/CSS). Prefer this over grepping for symbol definitions/usages. " +
	"Start with symbol_info (what is X) or outline (what's in this file) for " +
	"JS/TS; callers (who calls X) and implementations (who implements/extends X) " +
	"answer from the type checker; search_symbol is JS/TS-only (the HTML/CSS language servers don't " +
	"implement useful workspace-wide symbol search). The language servers only " +
	"see one file at a time, so `--custom-properties` and `#id`/`.class` " +
	"selectors can't be cross-referenced across files that way; use " +
	"css_var/selector for those instead of hover/definition/references: " +
	"references and definition also answer from that same cross-file " +
	"index automatically when the position is on one of those tokens in " +
	"a .css/.html file. To change code, prefer the write tools over hand edits " +
	"where one fits: edit (text), edit_symbol (replace/insert/delete a JS/TS " +
	"definition by name), rename_symbol (JS/TS symbols and CSS --vars, #ids, " +
	".classes), move (a declaration or a file), quick_fix. They type-check the " +
	"edit before writing and write it when it adds no errors (max_new_errors=0; " +
	"apply=false only previews); verify_changes shows what the working tree " +
	`broke, undo_edit reverts. ${POSITION_NOTE}`;

type ClientKey = "ts" | "html" | "css";

export interface WebnavOptions {
	/** Asks the MCP client for its roots (`roots/list`); omit outside a live session. */
	rootsProvider?: RootsProvider;
}

export class Webnav {
	readonly selector = new WorkspaceSelector("WEBNAV_MCP_WORKSPACE");
	readonly notices: NoticeBoard;
	workspaceRoot: string;
	private workspaceSource: string;
	private rootsProvider: RootsProvider | undefined;

	// One or more `label=relative/path` roots to index separately (see
	// webIndex.buildWorkspaceIndex); unset means "index the whole workspace as one root".
	private readonly rawWebRoots = process.env.WEBNAV_MCP_ROOTS;
	// Comma-separated workspace-relative files/directories of *generated* script
	// output (e.g. the JS a TypeScript build emits). They are never eagerly
	// opened, are dropped from `search_symbol`, and position tools reject them
	// with a pointer to the source. Navigation-only: the CSS/selector index
	// still reads them, since emitted JS is where a root's runtime usages live.
	private readonly rawExclude = process.env.WEBNAV_MCP_EXCLUDE ?? "";

	// Comma-separated workspace-relative files/directories of stylesheets that
	// are a public API (design tokens for other projects). `diagnostics` never
	// reports their custom properties or selectors as unused.
	private readonly rawPublic = process.env.WEBNAV_MCP_PUBLIC ?? "";
	private publicRelative: string[] = [];

	// A malformed WEBNAV_MCP_ROOTS must not crash the server at startup (the host
	// would only show "server failed to start"): remember the problem and report
	// it as tool text from every index-backed tool instead.
	private webRootsError: string | undefined;
	private webRoots: [string, string][] | undefined;
	private generatedPaths: string[] = [];
	private generatedRelative: string[] = [];

	// What the write tools remember between calls (previews, the undo journal); a new workspace starts fresh.
	private writeStateRef: WriteState | undefined;
	// Overlays (simulated edits) are one at a time per language server.
	private overlayLock: Promise<unknown> = Promise.resolve();

	private clients = new Map<ClientKey, LspClient>();
	// One lock per language server: the TS server's first start opens the whole
	// JS project, which must not hold up HTML/CSS calls.
	private clientLocks = new Map<ClientKey, Promise<unknown>>();
	private workspaceLock: Promise<unknown> = Promise.resolve();

	constructor(options: WebnavOptions = {}) {
		this.rootsProvider = options.rootsProvider;
		this.workspaceRoot = this.selector.base;
		this.workspaceSource = this.selector.baseSource;
		this.deriveConfig(this.workspaceRoot);
		this.notices = new NoticeBoard("webnav", [path.dirname(fileURLToPath(import.meta.url))]);
	}

	/** Called once the MCP transport is connected; provides `roots/list` access. */
	setRootsProvider(provider: RootsProvider | undefined): void {
		this.rootsProvider = provider;
	}

	private deriveConfig(root: string): void {
		this.webRootsError = undefined;
		try {
			this.webRoots = this.rawWebRoots ? webIndex.parseRootsEnv(this.rawWebRoots, root) : undefined;
		} catch (error) {
			this.webRoots = undefined;
			this.webRootsError = error instanceof Error ? error.message : String(error);
		}
		this.generatedPaths = this.rawExclude
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => resolveReal(path.resolve(root, part)));
		const resolvedRoot = resolveReal(root);
		this.generatedRelative = this.generatedPaths
			.filter((p) => relativeWithin(p, resolvedRoot) !== undefined)
			.map((p) => (relativeWithin(p, resolvedRoot) as string).split(path.sep).join("/"));
		this.publicRelative = this.rawPublic
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => relativeWithin(resolveReal(path.resolve(root, part)), resolvedRoot))
			.filter((rel): rel is string => rel !== undefined)
			.map((rel) => rel.split(path.sep).join("/"));
	}

	// -- writing ------------------------------------------------------------------

	private writeState(): WriteState {
		const readOnly = readOnlyFromEnv();
		let state = this.writeStateRef;
		if (state === undefined || state.root !== this.workspaceRoot) {
			const guard = new WriteGuard({
				root: this.workspaceRoot,
				readOnly,
				isForbidden: (resolved) =>
					this.isGenerated(resolved)
						? "is generated output (WEBNAV_MCP_EXCLUDE); edit the source it was built from."
						: undefined,
			});
			state = { root: this.workspaceRoot, guard, journal: new EditJournal(guard), plans: new PlanStore() };
			this.writeStateRef = state;
		} else if (state.guard.readOnly !== readOnly) {
			state.guard.readOnly = readOnly;
		}
		return state;
	}

	private writeHost(): ToolHost {
		return {
			workspaceRoot: this.workspaceRoot,
			state: () => this.writeState(),
			scriptClient: () => this.getTsClient(),
			webRoots: () =>
				(this.webRoots ?? [[webIndex.DEFAULT_ROOT_LABEL, this.workspaceRoot] as [string, string]]).map(
					([name, root]) => ({
						name,
						root,
					}),
				),
			clientFor: async (filePath) => {
				const suffix = path.extname(filePath).toLowerCase();
				if (SCRIPT_EXTENSIONS.has(suffix)) {
					return this.getTsClient();
				}
				if (suffix === ".html") {
					return this.getHtmlClient();
				}
				return suffix === ".css" ? this.getCssClient() : undefined;
			},
			exclusive: async (body) => {
				const run = this.overlayLock.then(body);
				this.overlayLock = run.catch(() => {});
				return run;
			},
		};
	}

	/** Stop every running language server. */
	async dispose(): Promise<void> {
		const stale = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(stale.map((client) => this.discardClient(client)));
	}

	// -- workspace ------------------------------------------------------------

	/** Re-target the server at `root`: every language server was started for the previous tree. */
	private async configureWorkspace(root: string, source: string): Promise<void> {
		await this.dispose();
		this.workspaceRoot = root;
		this.workspaceSource = source;
		this.deriveConfig(root);
	}

	/** Called first by every tool: which checkout/worktree to navigate is decided per request. */
	private async useWorkspace(): Promise<void> {
		if (!this.rootsProvider) {
			return;
		}
		const provider = this.rootsProvider;
		const run = this.workspaceLock.then(async () => {
			const selection = await this.selector.select(provider);
			if (selection.root !== this.workspaceRoot) {
				await this.configureWorkspace(selection.root, selection.source);
			}
		});
		this.workspaceLock = run.catch(() => {});
		await run;
	}

	// -- language-server clients ----------------------------------------------

	private async discardClient(client: LspClient): Promise<void> {
		try {
			await client.stop();
		} catch {
			// a language server that won't stop is reaped with the process
		}
	}

	private async getClient(
		key: ClientKey,
		make: () => LspClient,
		afterStart?: (client: LspClient) => Promise<void>,
	): Promise<LspClient> {
		const previous = this.clientLocks.get(key) ?? Promise.resolve();
		const run = previous.then(async () => {
			let client = this.clients.get(key);
			if (!client?.isAlive) {
				if (client) {
					await this.discardClient(client);
				}
				client = make();
				await client.start();
				this.clients.set(key, client);
				if (afterStart) {
					await afterStart(client);
				}
			}
			// Tell the server about anything created/edited/deleted on disk since the last call.
			await client.refresh();
			return client;
		});
		this.clientLocks.set(
			key,
			run.catch(() => {}),
		);
		return run;
	}

	private indexes(): webIndex.RootIndex[] {
		if (this.webRootsError !== undefined) {
			throw new ToolInputError(`WEBNAV_MCP_ROOTS is misconfigured: ${this.webRootsError}`);
		}
		return webIndex.buildWorkspaceIndex(this.workspaceRoot, this.webRoots);
	}

	/** Script files the language server should see up front, so the first `search_symbol` doesn't report "No Project". */
	private projectFiles(): string[] {
		let include: string[] = [];
		try {
			const config = JSON.parse(fs.readFileSync(path.join(this.workspaceRoot, "jsconfig.json"), "utf8")) as {
				include?: string[];
			};
			include = config.include ?? [];
		} catch {}
		let files: string[];
		if (include.length > 0) {
			files = include.flatMap((pattern) => globFiles(this.workspaceRoot, pattern));
		} else {
			// No jsconfig.json (or no `include`): scan for script files directly rather than opening nothing.
			const roots = this.webRoots ? this.webRoots.map(([, root]) => root) : [this.workspaceRoot];
			files = roots.flatMap((root) => globFiles(root, "**/*"));
		}
		return [...new Set(files)].filter((file) => SCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase()));
	}

	// workspace/symbol is most reliable when project files have been opened;
	// eagerly open the JS/TS project rather than leaving the first search_symbol
	// call (agents' typical first lookup) to miss files nobody has touched yet.
	private readonly openProjectFiles = async (client: LspClient): Promise<void> => {
		for (const file of this.projectFiles()) {
			if (this.isGenerated(file) || isExcluded(file, this.workspaceRoot)) {
				continue;
			}
			try {
				await client.ensureOpen(file);
			} catch (error) {
				if (!isToolError(error)) {
					throw error;
				}
				// unreadable project file, e.g. non-UTF-8: skip it
			}
		}
	};

	private getTsClient(): Promise<LspClient> {
		return this.getClient(
			"ts",
			() =>
				new LspClient({
					workspaceRoot: this.workspaceRoot,
					command: resolveTsCommand(this.workspaceRoot),
					languageId: "javascript",
					languageIds: SCRIPT_LANGUAGE_IDS,
					watchSuffixes: SCRIPT_EXTENSIONS,
					watchIgnore: (p) => this.isGenerated(p),
					openWatchedChanges: true,
					configNames: TS_CONFIG_NAMES,
					onRestart: this.openProjectFiles,
					onNotice: (message) => this.notices.post(message),
				}),
			this.openProjectFiles,
		);
	}

	private getHtmlClient(): Promise<LspClient> {
		return this.getClient(
			"html",
			() =>
				new LspClient({
					workspaceRoot: this.workspaceRoot,
					command: resolveHtmlCommand(this.workspaceRoot),
					languageId: "html",
				}),
		);
	}

	private getCssClient(): Promise<LspClient> {
		return this.getClient(
			"css",
			() =>
				new LspClient({
					workspaceRoot: this.workspaceRoot,
					command: resolveCssCommand(this.workspaceRoot),
					languageId: "css",
				}),
		);
	}

	private clientFor(filePath: string): Promise<LspClient> {
		const suffix = path.extname(filePath).toLowerCase();
		if (SCRIPT_EXTENSIONS.has(suffix)) {
			this.rejectGenerated(filePath);
			return this.getTsClient();
		}
		if (suffix === ".html") {
			return this.getHtmlClient();
		}
		if (suffix === ".css") {
			return this.getCssClient();
		}
		throw new ToolInputError(
			`webnav has no language server for '${filePath}' (supported: ${SUPPORTED_EXTENSIONS_TEXT})`,
		);
	}

	private isGenerated(p: string): boolean {
		const resolved = resolveReal(p);
		return this.generatedPaths.some((root) => resolved === root || relativeWithin(resolved, root) !== undefined);
	}

	private rejectGenerated(filePath: string): void {
		if (this.isGenerated(this.resolvePath(filePath))) {
			throw new ToolInputError(
				`'${filePath}' is generated output (WEBNAV_MCP_EXCLUDE); navigate the source it was built from instead`,
			);
		}
	}

	private resolvePath(filePath: string): string {
		return path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
	}

	/**
	 * The `--var`/`#id`/`.class` token at a position in a `.css`/`.html` file, so
	 * `references`/`definition` can answer from the cross-file index instead of
	 * the single-file language server.
	 */
	private indexTokenAt(filePath: string, line: number, column: number): string | undefined {
		const suffix = path.extname(filePath).toLowerCase();
		if (suffix !== ".css" && suffix !== ".html") {
			return undefined;
		}
		let textLine: string | undefined;
		try {
			textLine = splitLines(fs.readFileSync(this.resolvePath(filePath), "utf8"))[line - 1];
		} catch {
			return undefined;
		}
		if (textLine === undefined) {
			return undefined;
		}
		const token = webIndex.tokenAtPosition(textLine, column);
		if (token === undefined || token.startsWith("--")) {
			return token;
		}
		// A `#fff` colour or a `.5em`-like value looks like a selector token but
		// isn't one; only defer to the index for tokens it actually knows.
		return webIndex.knowsSelector(this.indexes(), token) ? token : undefined;
	}

	/**
	 * Answer from the cross-file index. With `filePath` (a position query), only
	 * the root that file lives in is reported (each root defines its own values
	 * and markup, so mixing in the other roots answers a different question)
	 * unless that root has nothing for the token.
	 */
	private indexAnswer(token: string, filePath?: string, definitionsOnly = false): string {
		const indexes = this.indexes();
		let scoped = "";
		if (filePath !== undefined) {
			const own = webIndex.rootIndexForFile(indexes, this.resolvePath(filePath));
			if (own) {
				const answer = this.formatIndex([own[0]], token, definitionsOnly);
				if (!answer.includes("was not found") && !answer.includes("not defined or used")) {
					return answer;
				}
				scoped = `(nothing in ${own[0].name}; showing all roots)\n`;
			}
		}
		return scoped + this.formatIndex(indexes, token, definitionsOnly);
	}

	private formatIndex(indexes: webIndex.RootIndex[], token: string, definitionsOnly: boolean): string {
		const options = { generated: this.generatedRelative, definitionsOnly };
		return token.startsWith("--")
			? webIndex.formatCssVar(indexes, token, options)
			: webIndex.formatSelector(indexes, token, options);
	}

	private checkScriptFile(filePath: string): void {
		const suffix = path.extname(filePath).toLowerCase();
		if (!SCRIPT_EXTENSIONS.has(suffix)) {
			throw new ToolInputError(
				`webnav outline/symbol_info only support JS/TS files (${[...SCRIPT_EXTENSIONS].sort().join("/")}), ` +
					`got '${filePath}'; use css_var/selector for CSS/HTML`,
			);
		}
		this.rejectGenerated(filePath);
	}

	/** Runs a tool body: picks the workspace, turns expected failures into text, appends pending notices. */
	private async run(body: () => Promise<string>): Promise<string> {
		let text: string;
		try {
			await this.useWorkspace();
			text = await body();
		} catch (error) {
			if (!isToolError(error)) {
				throw error;
			}
			text = formatToolError(error);
		}
		return this.notices.annotate(text);
	}

	// -- tools ------------------------------------------------------------------

	hover(filePath: string, line: number, column: number): Promise<string> {
		return this.run(async () => {
			const client = await this.clientFor(filePath);
			const result = await client.hover(filePath, line, column);
			return formatHoverContents(result.contents) || "No hover information at that position.";
		});
	}

	workspace(): Promise<string> {
		return this.run(
			async () => `${this.workspaceRoot}\nchosen because: ${this.selector.explain(this.workspaceSource)}`,
		);
	}

	definition(filePath: string, line: number, column: number): Promise<string> {
		return this.run(async () => {
			const token = this.indexTokenAt(filePath, line, column);
			if (token !== undefined) {
				return this.indexAnswer(token, filePath, true);
			}
			const client = await this.clientFor(filePath);
			const locations = await client.definition(filePath, line, column);
			if (locations.length === 0) {
				return "No definition found at that position.";
			}
			return locations.map((loc) => formatLocation(loc, this.workspaceRoot)).join("\n\n");
		});
	}

	references(filePath: string, line: number, column: number, includeDeclaration = true): Promise<string> {
		return this.run(async () => {
			const token = this.indexTokenAt(filePath, line, column);
			if (token !== undefined) {
				return this.indexAnswer(token, filePath);
			}
			const client = await this.clientFor(filePath);
			const locations = await client.references(filePath, line, column, { includeDeclaration });
			return formatReferences(locations, this.workspaceRoot);
		});
	}

	searchSymbol(args: {
		query?: string | undefined;
		name?: string | undefined;
		kind?: string | undefined;
		path?: string | undefined;
		fuzzy?: boolean | undefined;
	}): Promise<string> {
		return this.run(async () => {
			const kinds = parseKindFilter(args.kind);
			const query = resolveNameQuery({
				preferred: "query",
				example: "renderSidebar",
				params: { query: args.query, name: args.name },
			});
			const client = await this.getTsClient();
			const all = await client.workspaceSymbol(query);
			const symbols = all.filter(
				(sym) => !this.isGenerated(this.resolvePath(uriToRelative(sym.location?.uri ?? "", this.workspaceRoot))),
			);
			if (symbols.length === 0) {
				return `No symbols matching ${pyRepr(query)}.`;
			}
			const matching = filterSymbolsByKindAndPath(symbols, this.workspaceRoot, { kinds, path: args.path });
			if (matching.length === 0) {
				const filters = [
					["kind", args.kind],
					["path", args.path],
				]
					.filter(([, v]) => v)
					.map(([k, v]) => `${k}='${v}'`)
					.join(", ");
				return `No symbols matching ${pyRepr(query)} with ${filters} (${symbols.length} without the filters).`;
			}
			return formatWorkspaceSymbols(matching, this.workspaceRoot, { query, fuzzy: args.fuzzy ?? false });
		});
	}

	symbolInfo(args: {
		name?: string | undefined;
		query?: string | undefined;
		filePath?: string | undefined;
		includeReferences?: boolean | undefined;
	}): Promise<string> {
		return this.run(async () => {
			const includeReferences = args.includeReferences ?? true;
			const name = resolveNameQuery({
				preferred: "name",
				example: "renderSidebar",
				params: { name: args.name, query: args.query },
			});
			const client = await this.getTsClient();
			const resolved = await resolveSymbol(client, this.workspaceRoot, name, args.filePath);
			const relPath = uriToRelative(resolved.uri, this.workspaceRoot);
			this.rejectGenerated(relPath);
			const line = resolved.line + 1;
			const column = resolved.column + 1;
			const hoverResult = await client.hover(relPath, line, column);
			const definitionLocations = await client.definition(relPath, line, column);
			const referenceLocations = includeReferences ? await client.references(relPath, line, column) : [];
			const header = `${resolved.name}  [${symbolKindLabel(resolved.kind)}]  (${relPath}:${line}:${column})`;
			const hoverText = formatHoverContents(hoverResult.contents) || "No hover information.";
			const definitionText =
				definitionLocations.length > 0
					? definitionLocations.map((loc) => formatLocation(loc, this.workspaceRoot)).join("\n\n")
					: "No definition found.";
			const parts = [header, "", hoverText, "", "Definition:", definitionText];
			if (includeReferences) {
				parts.push("", "References:", formatReferencesGrouped(referenceLocations, this.workspaceRoot));
			}
			return parts.join("\n");
		});
	}

	callers(args: {
		name?: string | undefined;
		query?: string | undefined;
		filePath?: string | undefined;
	}): Promise<string> {
		return this.run(async () => {
			const name = resolveNameQuery({
				preferred: "name",
				example: "renderSidebar",
				params: { name: args.name, query: args.query },
			});
			const client = await this.getTsClient();
			const resolved = await resolveSymbol(client, this.workspaceRoot, name, args.filePath);
			const relPath = uriToRelative(resolved.uri, this.workspaceRoot);
			this.rejectGenerated(relPath);
			const items = await client.prepareCallHierarchy(relPath, resolved.line + 1, resolved.column + 1);
			const [item] = items;
			if (item === undefined) {
				return `${resolved.name} has no call hierarchy entry at that position (it may not be a callable).`;
			}
			return formatCallers(await client.incomingCalls(item), this.workspaceRoot);
		});
	}

	implementations(args: {
		name?: string | undefined;
		query?: string | undefined;
		filePath?: string | undefined;
	}): Promise<string> {
		return this.run(async () => {
			const name = resolveNameQuery({
				preferred: "name",
				example: "Shape",
				params: { name: args.name, query: args.query },
			});
			const client = await this.getTsClient();
			const resolved = await resolveSymbol(client, this.workspaceRoot, name, args.filePath);
			const relPath = uriToRelative(resolved.uri, this.workspaceRoot);
			this.rejectGenerated(relPath);
			const locations = await client.implementation(relPath, resolved.line + 1, resolved.column + 1);
			// The language server lists a class as one of its own implementations; that isn't news.
			const others = locations.filter((loc) => {
				const start = (loc.targetSelectionRange ?? loc.range ?? loc.targetRange)?.start;
				return !(
					(loc.uri ?? loc.targetUri) === resolved.uri &&
					start?.line === resolved.line &&
					start?.character === resolved.column
				);
			});
			return formatImplementations(client, name, resolved.kind, others, this.workspaceRoot);
		});
	}

	outline(filePath: string, detailed = false): Promise<string> {
		return this.run(async () => {
			this.checkScriptFile(filePath);
			const client = await this.getTsClient();
			const all = await client.documentSymbol(filePath);
			const symbols = detailed ? all : dropImportSymbols(all, readTextStrict(this.resolvePath(filePath)));
			return formatOutline(symbols, { collapseKinds: detailed ? new Set() : LOCALS_HOLDER_KINDS });
		});
	}

	diagnostics(filePath: string): Promise<string> {
		return this.run(async () => {
			const client = await this.clientFor(filePath);
			const items = await client.diagnostics(filePath);
			const lines = [formatDiagnostics(items)];
			const suffix = path.extname(filePath).toLowerCase();
			if (suffix === ".css" || suffix === ".html") {
				try {
					const located = webIndex.rootIndexForFile(this.indexes(), this.resolvePath(filePath));
					if (located) {
						const extra = webIndex.diagnosticsForFile(located[0], located[1], this.publicRelative);
						if (extra.length > 0) {
							lines.push(extra.join("\n"));
						}
					}
				} catch (error) {
					if (!(error instanceof ToolInputError)) {
						throw error;
					}
					lines.push(error.message);
				}
			}
			const combined = lines.filter((text) => text && text !== "No diagnostics.");
			return combined.length > 0 ? combined.join("\n") : "No diagnostics.";
		});
	}

	edit(args: EditArgs): Promise<string> {
		return this.run(() => edit(this.writeHost(), args));
	}

	editSymbol(args: EditSymbolArgs): Promise<string> {
		return this.run(() => editSymbol(this.writeHost(), args));
	}

	renameSymbol(args: RenameArgs): Promise<string> {
		return this.run(() => renameSymbol(this.writeHost(), args));
	}

	quickFix(args: QuickFixArgs): Promise<string> {
		return this.run(() => quickFix(this.writeHost(), args));
	}

	move(args: MoveArgs): Promise<string> {
		return this.run(() => move(this.writeHost(), args));
	}

	verifyChanges(args: { since?: string | undefined; includeDependents?: boolean | undefined } = {}): Promise<string> {
		return this.run(() => verifyChanges(this.writeHost(), args.since ?? "HEAD", args.includeDependents ?? true));
	}

	applyEdit(id: string, allowLarge = false): Promise<string> {
		return this.run(() => applyEdit(this.writeHost(), id, allowLarge));
	}

	undoEdit(id?: string): Promise<string> {
		return this.run(() => undoEdit(this.writeHost(), id));
	}

	cssVar(args: { name?: string | undefined; query?: string | undefined }): Promise<string> {
		return this.run(async () => {
			const name = resolveNameQuery({
				preferred: "name",
				example: "--bg",
				params: { name: args.name, query: args.query },
			});
			return webIndex.formatCssVar(this.indexes(), name, { generated: this.generatedRelative });
		});
	}

	selectorLookup(args: { name?: string | undefined; query?: string | undefined }): Promise<string> {
		return this.run(async () => {
			const name = resolveNameQuery({
				preferred: "name",
				example: ".card-title",
				params: { name: args.name, query: args.query },
			});
			return webIndex.formatSelector(this.indexes(), name, { generated: this.generatedRelative });
		});
	}
}

/** `Class.member  [Kind]  (path:line:col)` per implementation, deduplicated and in file order. */
async function formatImplementations(
	client: LspClient,
	name: string,
	kind: number | undefined,
	locations: LspLocation[],
	workspaceRoot: string,
): Promise<string> {
	const rows = new Map<string, { path: string; line: number; text: string }>();
	for (const loc of locations) {
		const uri = loc.uri ?? loc.targetUri ?? "";
		const start = (loc.targetSelectionRange ?? loc.range ?? loc.targetRange)?.start;
		const line = start?.line ?? 0;
		const character = start?.character ?? 0;
		const rel = uriToRelative(uri, workspaceRoot);
		let label = "?";
		let labelKind: number | undefined;
		try {
			const found = symbolAt(await client.documentSymbol(rel), line, character);
			label = found?.label ?? "?";
			labelKind = found?.kind;
		} catch (error) {
			if (!isToolError(error)) {
				throw error;
			}
		}
		rows.set(`${rel}:${line}:${character}`, {
			path: rel,
			line,
			text: `${label}  [${symbolKindLabel(labelKind)}]  (${rel}:${line + 1}:${character + 1})`,
		});
	}
	if (rows.size === 0) {
		return `No implementations of ${name} [${symbolKindLabel(kind)}] found.`;
	}
	const sorted = [...rows.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
	return [`${rows.size} implementation(s) of ${name} [${symbolKindLabel(kind)}]:`, ...sorted.map((r) => r.text)].join(
		"\n",
	);
}

function formatHoverContents(contents: LspHover["contents"]): string {
	if (!contents) {
		return "";
	}
	const one = (c: unknown): string =>
		c !== null && typeof c === "object" ? String((c as { value?: unknown }).value ?? JSON.stringify(c)) : String(c);
	if (Array.isArray(contents)) {
		return contents.map(one).join("\n").trim();
	}
	return one(contents).trim();
}
