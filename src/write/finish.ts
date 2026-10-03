/**
 * The write tools' shared ending: simulate a plan against the type checker,
 * then preview it or apply it, and describe what happened.
 */

import { isToolError } from "../shared/errors.js";
import {
	type DiagnosticsDelta,
	entriesFromLsp,
	formatDelta,
	isError,
	isSyntaxError,
	renderEntry,
} from "./diagnosticsDelta.js";
import { type EditPlan, relativeName } from "./edits.js";
import { type SimulationHost, simulatePlan } from "./simulate.js";
import type { EditJournal, PlanStore, WriteGuard } from "./transaction.js";

export const DEFAULT_DIFF_LINES = 150;

export interface WriteState {
	root: string;
	guard: WriteGuard;
	journal: EditJournal;
	plans: PlanStore;
}

export interface WriteHost extends SimulationHost {
	state(): WriteState;
}

export interface FinishOptions {
	apply: boolean;
	/** Write only when the edit adds no more errors than this (undefined: no limit). */
	maxNewErrors: number | undefined;
	allowLarge?: boolean;
	includeDependents?: boolean;
	diffLines?: number;
	/** Skip the type check (for plans no language server can judge). */
	skipCheck?: boolean;
}

export interface Outcome {
	text: string;
	appliedId?: string;
	previewId?: string;
	delta?: DiagnosticsDelta;
}

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Diagnostics of the edited files as they are on disk now: the simulation's second opinion. */
export async function errorsAfterWrite(host: WriteHost, plan: EditPlan, limit = 8): Promise<string> {
	const lines: string[] = [];
	let total = 0;
	for (const change of plan.changes) {
		if (change.newText === undefined) {
			continue;
		}
		const client = await host.clientFor(change.path);
		if (!client) {
			continue;
		}
		try {
			await client.refresh();
			const items = await client.diagnostics(change.path);
			for (const entry of entriesFromLsp(relativeName(change.path, host.workspaceRoot), change.newText, items)) {
				if (isError(entry)) {
					total++;
					if (lines.length < limit) {
						lines.push(`  ${renderEntry(entry)}`);
					}
				}
			}
		} catch (error) {
			if (!isToolError(error)) {
				throw error;
			}
		}
	}
	if (total === 0) {
		return "After writing: no errors in the edited files.";
	}
	const more = total > limit ? `\n  ... ${total - limit} more` : "";
	return `After writing: ${count(total, "error")} in the edited files (includes any that existed before):\n${lines.join("\n")}${more}`;
}

export async function finishPlan(
	host: WriteHost,
	plan: EditPlan,
	title: string,
	options: FinishOptions,
): Promise<Outcome> {
	const state = host.state();
	if (plan.isEmpty) {
		return { text: `${title}\nNo changes: the edit leaves every file as it is.` };
	}
	for (const change of plan.changes) {
		// A move may carry any asset (an image a stylesheet refers to); edits are limited to web sources.
		const move = change.kind === "rename";
		state.guard.checkPath(change.path, { anySuffix: move });
		if (change.renamedFrom) {
			state.guard.checkPath(change.renamedFrom, { anySuffix: move });
		}
	}
	const delta = options.skipCheck
		? undefined
		: await simulatePlan(host, plan, { includeDependents: options.includeDependents ?? true });
	const lines = [title, ""];
	let blocked = "";
	if (options.apply && state.guard.readOnly) {
		blocked = "NOT applied: writes are disabled (WEBNAV_MCP_READ_ONLY is set). This is a preview.";
	}
	const syntax = delta?.newErrors.filter(isSyntaxError) ?? [];
	if (options.apply && !blocked && syntax.length > 0) {
		blocked = `NOT applied: the result would not parse (${count(syntax.length, "syntax error")}); nothing is written until that is fixed.`;
	}
	if (
		options.apply &&
		!blocked &&
		delta &&
		options.maxNewErrors !== undefined &&
		delta.newErrors.length > options.maxNewErrors
	) {
		blocked = `NOT applied: ${count(delta.newErrors.length, "new error")} (allowed: ${options.maxNewErrors}). Review the diagnostics below; apply anyway with apply_edit, or adjust and rerun.`;
	}
	let appliedId: string | undefined;
	let previewId: string | undefined;
	if (options.apply && !blocked) {
		const entry = state.journal.apply(plan, { allowLarge: options.allowLarge ?? false });
		appliedId = entry.id;
		lines.push(`Applied as edit ${entry.id} (undo_edit(id="${entry.id}") reverts it).`);
	} else {
		previewId = state.plans.add(plan);
		lines.push(blocked || "Preview only, nothing written.");
		lines.push(
			`Write it with apply_edit(id="${previewId}")${blocked ? " (if you accept the diagnostics)" : " or rerun with apply=true"}.`,
		);
	}
	lines.push("", "Files:", plan.summary(host.workspaceRoot));
	if (plan.notes.length > 0) {
		lines.push("", "Notes:", ...plan.notes.map((note) => `  - ${note}`));
	}
	if (delta) {
		lines.push("", formatDelta(delta));
	}
	const diffLines = options.diffLines ?? DEFAULT_DIFF_LINES;
	if (appliedId === undefined && diffLines > 0) {
		lines.push("", plan.diff(host.workspaceRoot, diffLines).trimEnd());
	}
	if (appliedId !== undefined && !options.skipCheck) {
		lines.push("", await errorsAfterWrite(host, plan));
	}
	const outcome: Outcome = { text: lines.join("\n") };
	if (appliedId !== undefined) {
		outcome.appliedId = appliedId;
	}
	if (previewId !== undefined) {
		outcome.previewId = previewId;
	}
	if (delta) {
		outcome.delta = delta;
	}
	return outcome;
}
