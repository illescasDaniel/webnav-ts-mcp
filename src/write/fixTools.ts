/** `quick_fix`: apply the language server's own fixes and source actions to one file. */

import path from "node:path";
import { ToolInputError } from "../shared/errors.js";
import { uriToPath } from "../shared/format.js";
import type { LspClient } from "../shared/lspClient.js";
import type { LspCodeAction, LspDiagnostic } from "../shared/lspTypes.js";
import { newErrorLimit, requireText, resolveArgPath, type ToolHost, type WriteArgs } from "./common.js";
import { SCRIPT_SUFFIXES } from "./deps.js";
import {
	applyEdits,
	EditPlan,
	fileExists,
	lspEditsToTextEdits,
	modifyChange,
	readSource,
	relativeName,
} from "./edits.js";
import { finishPlan } from "./finish.js";

export type FixAction = "fix" | "organize_imports" | "remove_unused_imports" | "sort_imports" | "fix_all";

export interface QuickFixArgs extends WriteArgs {
	filePath?: string | undefined;
	line?: number | undefined;
	action?: FixAction | undefined;
}

const SOURCE_KINDS: Record<Exclude<FixAction, "fix">, string> = {
	organize_imports: "source.organizeImports",
	remove_unused_imports: "source.removeUnusedImports",
	sort_imports: "source.sortImports",
	fix_all: "source.fixAll",
};

const MAX_ROUNDS = 30;

/** The text edits `action` makes to `file` (edits to other files are not supported here and make it unusable). */
function editsForFile(
	action: LspCodeAction,
	file: string,
	text: string,
): ReturnType<typeof lspEditsToTextEdits> | undefined {
	const list = action.edit?.changes ? Object.entries(action.edit.changes) : [];
	for (const change of action.edit?.documentChanges ?? []) {
		if ("textDocument" in change) {
			list.push([change.textDocument.uri, change.edits]);
		} else {
			return undefined;
		}
	}
	if (list.length === 0) {
		return undefined;
	}
	const only = list.every(([uri]) => path.resolve(uriToPath(uri)) === path.resolve(file));
	return only
		? lspEditsToTextEdits(
				text,
				list.flatMap(([, edits]) => edits),
			)
		: undefined;
}

const isBulk = (a: LspCodeAction): boolean =>
	/^(add all|fix all|add missing|remove all)/i.test(a.title) || a.kind === "source.fixAll";

export interface FixOutcome {
	text: string;
	applied: string[];
	unfixed: { diagnostic: LspDiagnostic; why: string }[];
}

/**
 * Repeatedly fix the first fixable error of `file` (diagnostics are recomputed after every fix, since
 * positions move). Must run inside `client.withOverlay`, which holds `file`'s current text.
 */
export async function fixFile(
	client: LspClient,
	file: string,
	start: string,
	options: { onlyLine?: number | undefined; prefer?: (action: LspCodeAction) => boolean } = {},
): Promise<FixOutcome> {
	let text = start;
	const applied: string[] = [];
	const unfixed = new Map<string, { diagnostic: LspDiagnostic; why: string }>();
	const skipKey = (d: LspDiagnostic): string => `${d.code}:${d.message}:${d.range?.start?.line}`;
	for (let round = 0; round < MAX_ROUNDS; round++) {
		client.updateOverlay(file, text);
		const diagnostics = (await client.diagnostics(file)).filter(
			(d) => d.severity === 1 && (options.onlyLine === undefined || d.range?.start?.line === options.onlyLine - 1),
		);
		let progressed = false;
		for (const diagnostic of diagnostics) {
			if (unfixed.has(skipKey(diagnostic))) {
				continue;
			}
			const range = {
				start: diagnostic.range?.start ?? { line: 0, character: 0 },
				end: diagnostic.range?.end ?? diagnostic.range?.start ?? { line: 0, character: 0 },
			};
			const actions = (await client.codeActions(file, range as never, [diagnostic], ["quickfix"])).filter(
				(a) => !isBulk(a),
			);
			if (actions.length === 0) {
				unfixed.set(skipKey(diagnostic), { diagnostic, why: "the language server offers no fix" });
				continue;
			}
			let choice: LspCodeAction | undefined = actions.length === 1 ? actions[0] : undefined;
			if (!choice) {
				const preferred = actions.filter((a) => a.isPreferred || options.prefer?.(a));
				choice = preferred.length === 1 ? preferred[0] : undefined;
			}
			if (!choice) {
				unfixed.set(skipKey(diagnostic), {
					diagnostic,
					why: `ambiguous, ${actions.length} fixes: ${actions.map((a) => a.title).join("; ")}`,
				});
				continue;
			}
			const edits = editsForFile(choice, file, text);
			if (!edits) {
				unfixed.set(skipKey(diagnostic), { diagnostic, why: `"${choice.title}" changes other files` });
				continue;
			}
			const next = applyEdits(text, edits);
			if (next === text) {
				unfixed.set(skipKey(diagnostic), { diagnostic, why: `"${choice.title}" changes nothing` });
				continue;
			}
			text = next;
			applied.push(choice.title);
			progressed = true;
			break;
		}
		if (!progressed) {
			break;
		}
	}
	return { text, applied, unfixed: [...unfixed.values()] };
}

export async function quickFix(host: ToolHost, args: QuickFixArgs): Promise<string> {
	const file = resolveArgPath(host, requireText(args.filePath, "`file_path`"));
	if (!SCRIPT_SUFFIXES.has(path.extname(file).toLowerCase())) {
		throw new ToolInputError("quick_fix works on JS/TS files (the HTML/CSS language servers offer no fixes).");
	}
	if (!fileExists(file)) {
		throw new ToolInputError(`File not found: ${args.filePath} (relative paths resolve against the workspace root).`);
	}
	const rel = relativeName(file, host.workspaceRoot);
	const client = await host.scriptClient();
	const { text, bom } = readSource(file);
	const action = args.action ?? "fix";
	let next = text;
	const notes: string[] = [];
	let title: string;
	if (action === "fix") {
		const result = await host.exclusive(() =>
			client.withOverlay(new Map([[file, text]]), () => fixFile(client, file, text, { onlyLine: args.line })),
		);
		next = result.text;
		title = `Quick fix in ${rel}${args.line ? ` (line ${args.line})` : ""}: ${result.applied.length} fix(es)`;
		for (const a of result.applied) {
			notes.push(`applied: ${a}`);
		}
		for (const u of result.unfixed) {
			const d = u.diagnostic;
			notes.push(
				`not fixed: ${(d.range?.start?.line ?? 0) + 1}:${(d.range?.start?.character ?? 0) + 1} ${d.message?.split("\n")[0]} (${u.why})`,
			);
		}
		if (result.applied.length === 0) {
			return result.unfixed.length === 0
				? `${rel}${args.line ? `:${args.line}` : ""} has no errors to fix.`
				: `${title}\n${notes.map((n) => `  - ${n}`).join("\n")}`;
		}
	} else {
		const kind = SOURCE_KINDS[action];
		const lines = text.split(/\r\n|\r|\n/);
		const end = { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 };
		const actions = (await client.codeActions(file, { start: { line: 0, character: 0 }, end }, [], [kind])).filter(
			(a) => a.kind === kind || a.kind?.startsWith(`${kind}.`),
		);
		const chosen = actions[0];
		const edits = chosen && editsForFile(chosen, file, text);
		title = `${chosen?.title ?? action} in ${rel}`;
		if (!chosen || !edits) {
			return `The language server offers nothing for ${action} in ${rel}.`;
		}
		next = applyEdits(text, edits);
	}
	const plan = new EditPlan(title, [modifyChange(file, text, next, bom)], notes);
	return (
		await finishPlan(host, plan, title, {
			apply: args.apply ?? true,
			maxNewErrors: newErrorLimit(args.maxNewErrors),
		})
	).text;
}
