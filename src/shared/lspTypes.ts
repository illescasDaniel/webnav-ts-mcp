/** The slice of LSP 3.17 payloads the tools read. Everything is optional: servers vary. */

export interface Position {
	line?: number;
	character?: number;
}

export interface Range {
	start?: Position;
	end?: Position;
}

/** `Location` or `LocationLink`. */
export interface LspLocation {
	uri?: string;
	range?: Range;
	targetUri?: string;
	targetRange?: Range;
	targetSelectionRange?: Range;
}

/** `SymbolInformation`/`WorkspaceSymbol` (has `location`) or `DocumentSymbol` (has `range`). */
export interface LspSymbol {
	name?: string;
	kind?: number;
	location?: { uri?: string; range?: Range };
	range?: Range;
	selectionRange?: Range;
	children?: LspSymbol[];
}

export interface LspDiagnostic {
	range?: Range;
	severity?: number;
	code?: string | number | null;
	message?: string;
}

export interface LspHover {
	contents?: unknown;
}

/** Normalised symbol tree node (0-based lines). */
export interface SymbolNode {
	name: string;
	kind: number | undefined;
	startLine: number;
	endLine: number;
	children: SymbolNode[];
}

export interface CallHierarchyItemLike {
	uri?: string;
	name?: string;
	[key: string]: unknown;
}

/** `callHierarchy/incomingCalls` entry: the calling symbol plus every call-site range inside it. */
export interface IncomingCall {
	from?: { name?: string; kind?: number; uri?: string; selectionRange?: Range };
	fromRanges?: Range[];
}

export type LspRange = Range;

export interface LspTextEdit {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	newText: string;
}

/** `WorkspaceEdit`: either the `changes` map or `documentChanges` (text edits plus create/rename/delete operations). */
export interface LspWorkspaceEdit {
	changes?: Record<string, LspTextEdit[]>;
	documentChanges?: (
		| { textDocument: { uri: string }; edits: LspTextEdit[] }
		| { kind: "create"; uri: string }
		| { kind: "rename"; oldUri: string; newUri: string }
		| { kind: "delete"; uri: string }
	)[];
}

export interface LspCodeAction {
	title: string;
	kind?: string;
	edit?: LspWorkspaceEdit;
	diagnostics?: LspDiagnostic[];
	isPreferred?: boolean;
}
