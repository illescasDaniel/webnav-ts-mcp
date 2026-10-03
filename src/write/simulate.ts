/**
 * Type-check a change before it is written (or compare two states of the tree).
 *
 * Texts are shown to the language servers as in-memory overlays (nothing
 * touches the disk), the changed files and the files importing them are
 * checked on each side, and the two results are compared.
 */

import path from "node:path";
import { isToolError } from "../shared/errors.js";
import type { LspClient } from "../shared/lspClient.js";
import { findDependents, SCRIPT_SUFFIXES } from "./deps.js";
import { type DiagEntry, type DiagnosticsDelta, diffDiagnostics, entriesFromLsp } from "./diagnosticsDelta.js";
import { type EditPlan, readSource, relativeName } from "./edits.js";

export const CHECK_LIMIT = 60;

export interface SimulationHost {
	workspaceRoot: string;
	/** The language-server client that serves `filePath`, or undefined when none does. */
	clientFor(filePath: string): Promise<LspClient | undefined>;
	/** Run `body` while no other overlay is active. */
	exclusive<T>(body: () => Promise<T>): Promise<T>;
}

/** What one side of a comparison says about a file; files not mentioned are read from disk. */
export interface SideEntry {
	/** Show the server this text instead of the disk's. */
	overlay?: string;
	/** Don't report diagnostics for the file (it doesn't exist on this side). */
	skip?: boolean;
}

export type Side = Map<string, SideEntry>;

function diskText(file: string): string | undefined {
	try {
		return readSource(file).text;
	} catch {
		return undefined;
	}
}

async function collect(
	client: LspClient,
	root: string,
	files: string[],
	side: Side,
): Promise<{ entries: DiagEntry[]; unchecked: string[] }> {
	const entries: DiagEntry[] = [];
	const unchecked: string[] = [];
	for (const file of files) {
		const entry = side.get(file);
		if (entry?.skip) {
			continue;
		}
		const text = entry?.overlay ?? diskText(file);
		if (text === undefined) {
			continue;
		}
		try {
			entries.push(...entriesFromLsp(relativeName(file, root), text, await client.diagnostics(file)));
		} catch (error) {
			if (!isToolError(error)) {
				throw error;
			}
			unchecked.push(relativeName(file, root));
		}
	}
	return { entries, unchecked };
}

function overlaysOf(side: Side): Map<string, string> {
	return new Map(
		[...side].flatMap(([file, e]) => (e.overlay === undefined ? [] : [[file, e.overlay] as [string, string]])),
	);
}

async function checkSide(client: LspClient, root: string, files: string[], side: Side) {
	const overlays = overlaysOf(side);
	return overlays.size === 0
		? collect(client, root, files, side)
		: client.withOverlay(overlays, () => collect(client, root, files, side));
}

/**
 * Diagnostics of `edited` (and the script files importing them) on the `after` side minus the `before` side.
 * `removed` are files that exist on one side only, whose importers still need checking.
 */
export async function compareStates(
	host: SimulationHost,
	input: {
		edited: readonly string[];
		/** Files that are gone on one side: importers of these are checked too. */
		gone?: readonly string[];
		before: Side;
		after: Side;
		includeDependents?: boolean;
	},
): Promise<DiagnosticsDelta> {
	const root = host.workspaceRoot;
	// Looking a client up refreshes its view of the disk, so ask once per file.
	const clients = new Map<string, Promise<LspClient | undefined>>();
	const clientOf = (file: string): Promise<LspClient | undefined> => {
		let hit = clients.get(file);
		if (!hit) {
			hit = host.clientFor(file);
			clients.set(file, hit);
		}
		return hit;
	};
	const byClient = new Map<LspClient, string[]>();
	for (const file of [...new Set(input.edited)]) {
		const client = await clientOf(file);
		if (client) {
			byClient.set(client, [...(byClient.get(client) ?? []), file]);
		}
	}
	let filesChecked = 0;
	const unchecked: string[] = [];
	const beforeEntries: DiagEntry[] = [];
	const afterEntries: DiagEntry[] = [];
	await host.exclusive(async () => {
		for (const [client, edited] of byClient) {
			const scripts = [...edited, ...(input.gone ?? [])].filter((f) =>
				SCRIPT_SUFFIXES.has(path.extname(f).toLowerCase()),
			);
			const importers =
				input.includeDependents === false || client === undefined || scripts.length === 0
					? []
					: findDependents(root, scripts).filter((f) => !edited.includes(f));
			const ordered = [...new Set([...edited, ...importers])];
			const files = ordered.slice(0, CHECK_LIMIT);
			if (ordered.length > files.length) {
				unchecked.push(`${ordered.length - files.length} more importing file(s) beyond the ${CHECK_LIMIT}-file limit`);
			}
			filesChecked += files.length;
			const mine = async (side: Side): Promise<Side> => {
				const kept: Side = new Map();
				for (const [file, entry] of side) {
					if ((await clientOf(file)) === client) {
						kept.set(file, entry);
					}
				}
				return kept;
			};
			const before = await checkSide(client, root, files, await mine(input.before));
			const after = await checkSide(client, root, files, await mine(input.after));
			beforeEntries.push(...before.entries);
			afterEntries.push(...after.entries);
			unchecked.push(...new Set([...before.unchecked, ...after.unchecked]));
		}
	});
	const delta = diffDiagnostics(beforeEntries, afterEntries);
	delta.filesChecked = filesChecked;
	delta.unchecked = unchecked;
	return delta;
}

/** What applying `plan` would do to the diagnostics, without writing anything. */
export async function simulatePlan(
	host: SimulationHost,
	plan: EditPlan,
	options: { includeDependents?: boolean } = {},
): Promise<DiagnosticsDelta> {
	const before: Side = new Map();
	const after: Side = new Map();
	const edited: string[] = [];
	const gone: string[] = [];
	for (const change of plan.changes) {
		if (change.kind === "rename" && change.renamedFrom) {
			// The old path shows up as an empty module, so importers that were not rewritten report it.
			after.set(change.renamedFrom, { overlay: "", skip: true });
			gone.push(change.renamedFrom);
			const text = change.newText ?? change.oldText;
			if (text !== undefined) {
				after.set(change.path, { overlay: text });
				before.set(change.path, { skip: true });
				edited.push(change.path);
			}
			continue;
		}
		if (change.kind === "delete") {
			after.set(change.path, { overlay: "", skip: true });
			gone.push(change.path);
			continue;
		}
		after.set(change.path, { overlay: change.newText ?? "" });
		if (change.kind === "create") {
			before.set(change.path, { skip: true });
		}
		edited.push(change.path);
	}
	return compareStates(host, { edited, gone, before, after, includeDependents: options.includeDependents ?? true });
}
