/**
 * Expected tool failures, rendered as agent-readable text.
 *
 * The MCP framework collapses any exception a tool throws into an opaque
 * "Error executing tool …", hiding actionable causes like a mistyped path.
 * Tools catch what `isToolError` accepts and return `formatToolError(exc)`.
 */

/** The caller asked for something the tool can't serve (e.g. unsupported file type). */
export class ToolInputError extends Error {
	override name = "ToolInputError";
}

/** JSON-RPC error response from the language server. */
export class LspRequestError extends Error {
	override name = "LspRequestError";
	constructor(
		readonly method: string,
		readonly code: number | undefined,
		message: string,
	) {
		super(message);
	}
}

/** The language server process ended while a request was pending. */
export class LanguageServerExitedError extends Error {
	override name = "LanguageServerExitedError";
}

/** A tool was asked about a line/column that doesn't exist in the file. */
export class InvalidPositionError extends Error {
	override name = "InvalidPositionError";
}

/** A language-server request outlived its deadline. */
export class LspTimeoutError extends Error {
	override name = "LspTimeoutError";
}

/** A file that isn't valid UTF-8 text. */
export class Utf8DecodeError extends Error {
	override name = "Utf8DecodeError";
}

export type FsError = NodeJS.ErrnoException;

export function isFsError(exc: unknown): exc is FsError {
	return exc instanceof Error && typeof (exc as FsError).code === "string" && "syscall" in exc;
}

/** True for every failure a tool should report as text instead of throwing. */
export function isToolError(exc: unknown): exc is Error {
	return (
		exc instanceof LspRequestError ||
		exc instanceof LanguageServerExitedError ||
		exc instanceof ToolInputError ||
		exc instanceof InvalidPositionError ||
		exc instanceof LspTimeoutError ||
		exc instanceof Utf8DecodeError ||
		isFsError(exc)
	);
}

export function formatToolError(exc: Error): string {
	if (exc instanceof LspRequestError) {
		return `LSP error on ${exc.method}: ${exc.message}`;
	}
	if (exc instanceof LspTimeoutError) {
		return "Language server timed out (it may still be indexing the workspace); retry shortly.";
	}
	if (exc instanceof Utf8DecodeError) {
		return `Cannot read file as UTF-8 text: ${exc.message}.`;
	}
	if (isFsError(exc)) {
		const spawnFailure = exc.syscall?.startsWith("spawn") ?? false;
		const reason = exc.message.replace(/^[A-Z_]+: /, "").replace(/, (?:open|stat|spawn|scandir|read)\b.*$/, "");
		if (exc.code === "ENOENT" && !spawnFailure && exc.path) {
			return `File not found: ${exc.path} (relative paths resolve against the workspace root).`;
		}
		if (exc.code === "ENOENT") {
			return `Cannot start language server (file not found): ${reason}.`;
		}
		if (spawnFailure) {
			return `Cannot start language server: ${reason}.`;
		}
		if (exc.path) {
			return `Cannot read ${exc.path}: ${reason}.`;
		}
		return `${reason}.`;
	}
	return exc.message;
}
