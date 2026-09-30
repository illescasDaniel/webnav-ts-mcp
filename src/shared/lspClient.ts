/**
 * Minimal async LSP client: generic JSON-RPC/LSP wire protocol plumbing.
 *
 * Not a general-purpose LSP library: only the handful of requests the MCP
 * tools need. Framing and request correlation come from `vscode-jsonrpc`;
 * what stays here is the policy around it: document sync from disk,
 * file-change refresh, config-triggered restarts, retry on ContentModified.
 * Language-server-specific bits (how to launch the server, its languageId)
 * are the caller's responsibility.
 */

import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	CancellationTokenSource,
	createMessageConnection,
	type MessageConnection,
	ResponseError,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-jsonrpc/node";
import { InvalidPositionError, LanguageServerExitedError, LspRequestError, LspTimeoutError } from "./errors.js";
import { EXCLUDED_DIR_NAMES } from "./exclude.js";
import { uriToPath } from "./format.js";
import { debug } from "./log.js";
import type {
	CallHierarchyItemLike,
	IncomingCall,
	LspDiagnostic,
	LspHover,
	LspLocation,
	LspSymbol,
} from "./lspTypes.js";
import { LINE_BREAK_RE, readTextStrict } from "./text.js";

/** Max ms to wait for a push-only server's publishDiagnostics after a sync. */
export const PUSH_DIAGNOSTICS_TIMEOUT_MS = 5000;

// Server->client requests that only need an acknowledgement.
const NULL_REPLY_METHODS = new Set([
	"client/registerCapability",
	"client/unregisterCapability",
	"window/workDoneProgress/create",
	"workspace/diagnostic/refresh",
	"workspace/semanticTokens/refresh",
	"workspace/inlayHint/refresh",
	"workspace/codeLens/refresh",
]);

const STDERR_TAIL_LINES = 10;
// LSP `ContentModified` (-32801) and `ServerCancelled` (-32802): both mean "ask again".
const RETRYABLE_CODES = new Set([-32801, -32802]);
const CONTENT_MODIFIED_BACKOFF_MS = [100, 250, 500];
const DEFAULT_TIMEOUT_MS = 20_000;

// LSP `FileChangeType`.
const FILE_CREATED = 1;
const FILE_CHANGED = 2;
const FILE_DELETED = 3;

interface OpenFile {
	uri: string;
	version: number;
	mtimeNs: bigint;
	size: number;
}

type Stamp = readonly [bigint, number];

export interface LspClientOptions {
	workspaceRoot: string;
	/** Executable followed by its arguments. */
	command: string[];
	languageId: string;
	/** Suffixes (lower-case, with dot) whose on-disk changes `refresh()` reports via `workspace/didChangeWatchedFiles`. */
	watchSuffixes?: ReadonlySet<string>;
	/** Paths `refresh()` must not report (e.g. generated output). */
	watchIgnore?: (p: string) => boolean;
	/** Also `didOpen` watched files that appeared/changed (tsserver only treats opened documents deterministically). */
	openWatchedChanges?: boolean;
	/** File names whose change alters how the server resolves the project; `refresh()` restarts the server when one changes. */
	configNames?: ReadonlySet<string>;
	/** Runs after every restart, e.g. to eagerly open project files. */
	onRestart?: (client: LspClient) => Promise<void>;
	/** Told (in words) about anything the agent should know, e.g. a config-triggered restart. */
	onNotice?: (message: string) => void;
	/** Per-suffix override of `languageId`. */
	languageIds?: Readonly<Record<string, string>>;
	/** Deadline for one request, in ms (default 20 000). */
	requestTimeoutMs?: number;
}

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
	done: boolean;
}

function deferred(): Deferred {
	const d = { done: false } as Deferred;
	d.promise = new Promise<void>((resolve) => {
		d.resolve = () => {
			d.done = true;
			resolve();
		};
	});
	return d;
}

function statStamp(p: string): { mtimeNs: bigint; size: number } {
	const st = fs.statSync(p, { bigint: true });
	return { mtimeNs: st.mtimeNs, size: Number(st.size) };
}

const sameStamp = (a: Stamp | undefined, b: Stamp | undefined): boolean =>
	a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1];

export class LspClient {
	readonly workspaceRoot: string;
	readonly command: string[];
	private readonly languageId: string;
	private readonly watchSuffixes: ReadonlySet<string>;
	private readonly watchIgnore: ((p: string) => boolean) | undefined;
	private readonly openWatchedChanges: boolean;
	private readonly configNames: ReadonlySet<string>;
	private readonly onRestart: ((client: LspClient) => Promise<void>) | undefined;
	private readonly onNotice: ((message: string) => void) | undefined;
	private readonly languageIds: Readonly<Record<string, string>>;
	private readonly requestTimeoutMs: number;

	private proc: ChildProcess | undefined;
	private conn: MessageConnection | undefined;
	private exited: Promise<never> | undefined;
	private alive = false;
	private started = false;
	private stderrTail: string[] = [];
	private diagnosticsByUri = new Map<string, LspDiagnostic[]>();
	private openFiles = new Map<string, OpenFile>();
	// uri -> set by the first publishDiagnostics after the document was last
	// synced, so push-only servers can be awaited instead of answered stale.
	private diagEvents = new Map<string, Deferred>();
	// uri -> (document version, documentSymbol result); the version bumps exactly when the text changes.
	private symbolCache = new Map<string, { version: number; result: LspSymbol[] }>();
	private watchSnapshot: Map<string, Stamp> | undefined;
	private configSnapshot: Map<string, Stamp> | undefined;
	private configHashes = new Map<string, string>();
	private refreshChain: Promise<unknown> = Promise.resolve();

	constructor(options: LspClientOptions) {
		this.workspaceRoot = options.workspaceRoot;
		this.command = options.command;
		this.languageId = options.languageId;
		this.watchSuffixes = options.watchSuffixes ?? new Set();
		this.watchIgnore = options.watchIgnore;
		this.openWatchedChanges = options.openWatchedChanges ?? false;
		this.configNames = options.configNames ?? new Set();
		this.onRestart = options.onRestart;
		this.onNotice = options.onNotice;
		this.languageIds = options.languageIds ?? {};
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	get isAlive(): boolean {
		return this.alive;
	}

	async start(): Promise<void> {
		if (this.started) {
			return;
		}
		this.stderrTail = [];
		const [executable, ...args] = this.command;
		if (executable === undefined) {
			throw new Error("empty language server command");
		}
		const proc = spawn(executable, args, { cwd: this.workspaceRoot, stdio: ["pipe", "pipe", "pipe"] });
		this.proc = proc;
		this.alive = true;

		let onSpawnError: (error: Error) => void = () => {};
		const spawnFailed = new Promise<never>((_, reject) => {
			onSpawnError = reject;
		});
		spawnFailed.catch(() => {});
		this.exited = new Promise<never>((_, reject) => {
			proc.once("error", (error) => {
				this.alive = false;
				onSpawnError(error);
				reject(error);
			});
			proc.once("close", () => {
				this.alive = false;
				reject(new LanguageServerExitedError(this.exitMessage()));
			});
		});
		this.exited.catch(() => {});

		let stderrBuffer = "";
		proc.stderr?.setEncoding("utf8");
		// Only kept to explain an exit; routine logging isn't surfaced.
		proc.stderr?.on("data", (chunk: string) => {
			stderrBuffer += chunk;
			const lines = stderrBuffer.split(/\r?\n/);
			stderrBuffer = lines.pop() ?? "";
			for (const line of lines) {
				if (line.trim()) {
					this.stderrTail.push(line.trimEnd());
					if (this.stderrTail.length > STDERR_TAIL_LINES) {
						this.stderrTail.shift();
					}
				}
			}
		});
		proc.stdin?.on("error", () => {}); // EPIPE after the server died: surfaced via `exited`

		const stdout = proc.stdout;
		const stdin = proc.stdin;
		if (!stdout || !stdin) {
			throw new Error("language server subprocess has no stdio pipes");
		}
		const conn = createMessageConnection(new StreamMessageReader(stdout), new StreamMessageWriter(stdin));
		this.conn = conn;
		conn.onRequest((method: string, params: unknown) => this.replyToServerRequest(method, params));
		conn.onNotification(
			"textDocument/publishDiagnostics",
			(params: { uri?: string; diagnostics?: LspDiagnostic[] }) => {
				if (params.uri) {
					this.diagnosticsByUri.set(params.uri, params.diagnostics ?? []);
					this.diagEvents.get(params.uri)?.resolve();
				}
			},
		);
		conn.onError(() => {});
		conn.onClose(() => {});
		conn.listen();

		const rootUri = pathToFileURL(this.workspaceRoot).href;
		try {
			await Promise.race([
				this.request("initialize", {
					processId: null,
					rootUri,
					capabilities: {
						textDocument: {
							synchronization: { didSave: true },
							publishDiagnostics: {},
							documentSymbol: { hierarchicalDocumentSymbolSupport: true },
							callHierarchy: {},
							typeHierarchy: {},
						},
						workspace: { workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: true } },
					},
					workspaceFolders: [{ uri: rootUri, name: path.basename(this.workspaceRoot) }],
				}),
				spawnFailed,
			]);
		} catch (error) {
			await this.stop();
			throw error;
		}
		this.notify("initialized", {});
		this.started = true;
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		const conn = this.conn;
		if (!proc || !conn) {
			return;
		}
		if (this.alive && this.started) {
			try {
				await this.request("shutdown", null, 5000);
				this.notify("exit", null);
			} catch (error) {
				debug("language server didn't respond to shutdown in time; terminating it directly", error);
			}
		}
		conn.dispose();
		const closed = new Promise<void>((resolve) => {
			if (proc.exitCode !== null || proc.signalCode !== null) {
				resolve();
			} else {
				proc.once("close", () => resolve());
			}
		});
		proc.kill();
		await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 3000).unref())]);
		this.alive = false;
		this.started = false;
		this.proc = undefined;
		this.conn = undefined;
	}

	/** Stop the server and start it again with no memory of the old session. */
	async restart(): Promise<void> {
		await this.stop();
		this.diagnosticsByUri = new Map();
		this.openFiles = new Map();
		this.diagEvents = new Map();
		this.symbolCache = new Map();
		await this.start();
		if (this.onRestart) {
			await this.onRestart(this);
		}
	}

	// -- wire protocol -----------------------------------------------------

	private exitMessage(): string {
		let message = `language server exited: ${this.command.join(" ")}`;
		if (this.stderrTail.length > 0) {
			message += `\nIts last stderr output:\n${this.stderrTail.join("\n")}`;
		}
		return message;
	}

	/**
	 * Answer a server->client request so the server never waits on us
	 * (`workspace/configuration`, `client/registerCapability`, progress
	 * creation, ...). Unknown methods get MethodNotFound.
	 */
	private replyToServerRequest(method: string, params: unknown): unknown {
		if (method === "workspace/configuration") {
			const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
			return items.map(() => null);
		}
		if (NULL_REPLY_METHODS.has(method)) {
			return null;
		}
		throw new ResponseError(-32601, `Method not found: ${method}`);
	}

	private running(): MessageConnection {
		if (!this.conn) {
			throw new Error("LspClient.start() must be awaited before use");
		}
		return this.conn;
	}

	/**
	 * Send a request, retrying when the server reports the document changed
	 * mid-flight (LSP says a client should re-issue such a request); other
	 * errors surface as-is.
	 */
	private async request<T = unknown>(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
		for (const delay of CONTENT_MODIFIED_BACKOFF_MS) {
			try {
				return await this.requestOnce<T>(method, params, timeoutMs);
			} catch (error) {
				if (!(error instanceof LspRequestError) || error.code === undefined || !RETRYABLE_CODES.has(error.code)) {
					throw error;
				}
				debug(`retrying ${method} after LSP error ${error.code}`);
			}
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
		return this.requestOnce<T>(method, params, timeoutMs);
	}

	private async requestOnce<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
		const conn = this.running();
		const cancel = new CancellationTokenSource();
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				cancel.cancel();
				reject(new LspTimeoutError(`${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});
		timedOut.catch(() => {});
		try {
			const pending = conn.sendRequest(method, params ?? null, cancel.token) as Promise<T>;
			pending.catch(() => {});
			const races: Promise<T>[] = [pending, timedOut];
			if (this.exited) {
				races.push(this.exited);
			}
			return await Promise.race(races);
		} catch (error) {
			if (error instanceof ResponseError) {
				throw new LspRequestError(method, error.code, error.message);
			}
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private notify(method: string, params: unknown): void {
		this.running()
			.sendNotification(method, params ?? null)
			.catch((error: unknown) => debug(`could not send ${method}`, error));
	}

	// -- document sync -------------------------------------------------------

	private toPath(filePath: string): string {
		const abs = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
		try {
			return fs.realpathSync(abs);
		} catch {
			return path.resolve(abs);
		}
	}

	private languageIdFor(p: string): string {
		return this.languageIds[path.extname(p).toLowerCase()] ?? this.languageId;
	}

	async ensureOpen(filePath: string): Promise<string> {
		const abs = this.toPath(filePath);
		const uri = pathToFileURL(abs).href;
		const stamp = statStamp(abs);
		const known = this.openFiles.get(uri);
		if (known && known.mtimeNs === stamp.mtimeNs && known.size === stamp.size) {
			return uri;
		}
		const text = readTextStrict(abs);
		this.diagEvents.set(uri, deferred());
		// The previous version's pushed diagnostics describe text that no longer
		// exists; keeping them would resurface fixed errors as a "cache fallback".
		if (known) {
			this.diagnosticsByUri.delete(uri);
		}
		if (!known) {
			this.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: this.languageIdFor(abs), version: 1, text },
			});
			this.openFiles.set(uri, { uri, version: 1, ...stamp });
		} else {
			const version = known.version + 1;
			this.notify("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text }],
			});
			this.openFiles.set(uri, { uri, version, ...stamp });
		}
		return uri;
	}

	closeDocument(uri: string): void {
		this.notify("textDocument/didClose", { textDocument: { uri } });
		this.openFiles.delete(uri);
		this.diagnosticsByUri.delete(uri);
		this.diagEvents.delete(uri);
		// Reopening restarts versions at 1, which could falsely match an old entry.
		this.symbolCache.delete(uri);
	}

	/**
	 * (mtime_ns, size) of every watched source file and every `configNames`
	 * file, keyed by resolved path. Skips nested checkouts: a directory holding
	 * a `.git` entry below the root is another repository or linked worktree.
	 */
	private scanWatched(): { sources: Map<string, Stamp>; configs: Map<string, Stamp> } {
		const sources = new Map<string, Stamp>();
		const configs = new Map<string, Stamp>();
		if (this.watchSuffixes.size === 0 && this.configNames.size === 0) {
			return { sources, configs };
		}
		let root: string;
		try {
			root = fs.realpathSync(this.workspaceRoot);
		} catch {
			root = path.resolve(this.workspaceRoot);
		}
		const pending = [root];
		for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(directory, { withFileTypes: true });
			} catch {
				continue;
			}
			if (directory !== root && entries.some((e) => e.name === ".git")) {
				continue;
			}
			for (const entry of entries) {
				const full = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					if (!EXCLUDED_DIR_NAMES.has(entry.name)) {
						pending.push(full);
					}
					continue;
				}
				const isConfig = this.configNames.has(entry.name);
				if (!isConfig && !this.watchSuffixes.has(path.extname(entry.name).toLowerCase())) {
					continue;
				}
				if (!isConfig && this.watchIgnore?.(full)) {
					continue;
				}
				try {
					const st = fs.statSync(full, { bigint: true });
					if (st.isDirectory()) {
						continue;
					}
					const key = entry.isSymbolicLink() ? fs.realpathSync(full) : full;
					(isConfig ? configs : sources).set(key, [st.mtimeNs, Number(st.size)]);
				} catch {}
			}
		}
		return { sources, configs };
	}

	/** Names of config files whose *content* differs from the last time we looked. */
	private changedConfigs(configs: Map<string, Stamp>, previous: Map<string, Stamp> | undefined): string[] {
		const touched = new Set<string>();
		const hashes = new Map<string, string>();
		for (const [file, stamp] of configs) {
			const known = this.configHashes.get(file);
			if (known !== undefined && previous !== undefined && sameStamp(previous.get(file), stamp)) {
				hashes.set(file, known);
				continue;
			}
			let digest: string;
			try {
				digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
			} catch {
				continue;
			}
			hashes.set(file, digest);
			if (previous !== undefined && digest !== known) {
				touched.add(path.basename(file));
			}
		}
		for (const file of this.configHashes.keys()) {
			if (!hashes.has(file)) {
				touched.add(path.basename(file));
			}
		}
		this.configHashes = hashes;
		return [...touched].sort();
	}

	/**
	 * Bring the language server's view of the disk up to date.
	 *
	 * Servers only see what a client tells them: a document opened with
	 * `didOpen` is frozen at that text, and files created/edited/deleted behind
	 * the server's back are invisible to workspace-wide answers. Call this
	 * before every tool call; it costs one stat walk. Open documents are
	 * re-synced (or closed when deleted), and watched-suffix files that
	 * appeared/changed/vanished are reported via `workspace/didChangeWatchedFiles`.
	 * A change to a `configNames` file restarts the server instead (it only
	 * reads its project config at startup).
	 */
	refresh(): Promise<void> {
		const run = this.refreshChain.then(() => this.refreshNow());
		this.refreshChain = run.catch(() => {});
		return run;
	}

	private async refreshNow(): Promise<void> {
		const { sources: current, configs } = this.scanWatched();
		const previousConfigs = this.configSnapshot;
		this.configSnapshot = configs;
		if (previousConfigs !== undefined && !sameStampMaps(configs, previousConfigs)) {
			const touched = this.changedConfigs(configs, previousConfigs);
			if (touched.length > 0) {
				// A fresh server also sees the disk as it is now, so nothing else needs reporting.
				this.watchSnapshot = current;
				await this.restart();
				this.onNotice?.(`restarted the language server because ${touched.join(", ")} changed`);
				return;
			}
		} else if (previousConfigs === undefined) {
			this.changedConfigs(configs, undefined);
		}
		const changes: { uri: string; type: number }[] = [];
		const previous = this.watchSnapshot;
		if (previous !== undefined) {
			for (const [file, stamp] of current) {
				const before = previous.get(file);
				if (before === undefined) {
					changes.push({ uri: pathToFileURL(file).href, type: FILE_CREATED });
				} else if (!sameStamp(before, stamp)) {
					changes.push({ uri: pathToFileURL(file).href, type: FILE_CHANGED });
				}
			}
			for (const file of previous.keys()) {
				if (!current.has(file)) {
					changes.push({ uri: pathToFileURL(file).href, type: FILE_DELETED });
				}
			}
		}
		this.watchSnapshot = current;
		if (changes.length > 0) {
			this.notify("workspace/didChangeWatchedFiles", { changes });
		}
		if (this.openWatchedChanges) {
			for (const change of changes) {
				if (change.type !== FILE_DELETED) {
					await this.ensureOpen(uriToPath(change.uri));
				}
			}
		}
		for (const [uri, known] of [...this.openFiles]) {
			if (known.mtimeNs === -1n) {
				continue; // scratch document: never on disk
			}
			const file = uriToPath(uri);
			if (!fs.existsSync(file)) {
				this.closeDocument(uri);
			} else {
				await this.ensureOpen(file);
			}
		}
	}

	// -- LSP calls used by the MCP tools --------------------------------------

	/** Reject a position outside the file, so a typo isn't answered with an empty result indistinguishable from "nothing there". */
	private checkPosition(filePath: string, line: number, column: number): void {
		const lines = readTextStrict(this.toPath(filePath)).split(LINE_BREAK_RE);
		if (lines.length > 1 && lines[lines.length - 1] === "") {
			lines.pop(); // the empty "line" after the final newline isn't a line anyone can point at
		}
		if (!(line >= 1 && line <= lines.length)) {
			throw new InvalidPositionError(
				`line ${line} is out of range: ${filePath} has ${lines.length} line(s) (lines are 1-indexed)`,
			);
		}
		const width = (lines[line - 1] ?? "").length; // JS string length is already UTF-16 code units
		if (!(column >= 1 && column <= width + 1)) {
			throw new InvalidPositionError(
				`column ${column} is out of range: line ${line} of ${filePath} is ${width} character(s) long ` +
					"(columns are 1-indexed UTF-16 offsets; a tab counts as one)",
			);
		}
	}

	private async positionRequest<T>(
		method: string,
		filePath: string,
		line: number,
		column: number,
		extra = {},
	): Promise<T> {
		const uri = await this.ensureOpen(filePath);
		this.checkPosition(filePath, line, column);
		return this.request<T>(method, {
			textDocument: { uri },
			position: { line: line - 1, character: column - 1 },
			...extra,
		});
	}

	async hover(filePath: string, line: number, column: number): Promise<LspHover> {
		return (await this.positionRequest<LspHover | null>("textDocument/hover", filePath, line, column)) ?? {};
	}

	async definition(filePath: string, line: number, column: number): Promise<LspLocation[]> {
		const result = await this.positionRequest<LspLocation | LspLocation[] | null>(
			"textDocument/definition",
			filePath,
			line,
			column,
		);
		if (result === null || result === undefined) {
			return [];
		}
		return Array.isArray(result) ? result : [result];
	}

	async references(
		filePath: string,
		line: number,
		column: number,
		options: { includeDeclaration?: boolean } = {},
	): Promise<LspLocation[]> {
		const result = await this.positionRequest<LspLocation[] | null>("textDocument/references", filePath, line, column, {
			context: { includeDeclaration: options.includeDeclaration ?? true },
		});
		return result ?? [];
	}

	async workspaceSymbol(query: string): Promise<LspSymbol[]> {
		return (await this.request<LspSymbol[] | null>("workspace/symbol", { query })) ?? [];
	}

	async diagnostics(filePath: string): Promise<LspDiagnostic[]> {
		const uri = await this.ensureOpen(filePath);
		const cached = this.diagnosticsByUri.get(uri) ?? [];
		let result: { kind?: string; items?: LspDiagnostic[] } | null;
		try {
			result = await this.request("textDocument/diagnostic", { textDocument: { uri } });
		} catch (error) {
			if (!(error instanceof LspRequestError)) {
				throw error;
			}
			// HTML/CSS servers often only push publishDiagnostics and reject pull. If
			// the document was just (re)synced, the push for this version hasn't
			// necessarily arrived yet: wait for it rather than report stale text.
			const event = this.diagEvents.get(uri);
			if (event && !event.done) {
				let timer: NodeJS.Timeout | undefined;
				await Promise.race([
					event.promise,
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, PUSH_DIAGNOSTICS_TIMEOUT_MS);
					}),
				]);
				clearTimeout(timer);
			}
			return this.diagnosticsByUri.get(uri) ?? [];
		}
		if (result?.kind === "unchanged") {
			return cached;
		}
		// A pull answer for the current version is authoritative, empty included.
		return result?.items ?? cached;
	}

	async documentSymbol(filePath: string): Promise<LspSymbol[]> {
		const uri = await this.ensureOpen(filePath);
		const version = this.openFiles.get(uri)?.version ?? 0;
		const hit = this.symbolCache.get(uri);
		if (hit && hit.version === version) {
			return hit.result;
		}
		const result =
			(await this.request<LspSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri } })) ?? [];
		this.symbolCache.set(uri, { version, result });
		return result;
	}

	async implementation(filePath: string, line: number, column: number): Promise<LspLocation[]> {
		const result = await this.positionRequest<LspLocation | LspLocation[] | null>(
			"textDocument/implementation",
			filePath,
			line,
			column,
		);
		if (result === null || result === undefined) {
			return [];
		}
		return Array.isArray(result) ? result : [result];
	}

	async prepareCallHierarchy(filePath: string, line: number, column: number): Promise<CallHierarchyItemLike[]> {
		const uri = await this.ensureOpen(filePath);
		return (
			(await this.request<CallHierarchyItemLike[] | null>("textDocument/prepareCallHierarchy", {
				textDocument: { uri },
				position: { line: line - 1, character: column - 1 },
			})) ?? []
		);
	}

	async incomingCalls(item: CallHierarchyItemLike): Promise<IncomingCall[]> {
		return (await this.request<IncomingCall[] | null>("callHierarchy/incomingCalls", { item })) ?? [];
	}
}

function sameStampMaps(a: Map<string, Stamp>, b: Map<string, Stamp>): boolean {
	if (a.size !== b.size) {
		return false;
	}
	for (const [key, stamp] of a) {
		if (!sameStamp(stamp, b.get(key))) {
			return false;
		}
	}
	return true;
}
