/** `apply_edit` and `undo_edit`: write a previewed plan, revert an applied one. */

import { ToolInputError } from "../shared/errors.js";
import type { ToolHost } from "./common.js";
import { errorsAfterWrite } from "./finish.js";

export async function applyEdit(host: ToolHost, id: string, allowLarge = false): Promise<string> {
	if (!id) {
		throw new ToolInputError("`id` is required: the preview id a write tool returned.");
	}
	const state = host.state();
	const plan = state.plans.get(id);
	const entry = state.journal.apply(plan, { allowLarge });
	state.plans.discard(id);
	const after = await errorsAfterWrite(host, plan);
	return `Applied edit ${entry.id}: ${plan.description}\n\nFiles:\n${plan.summary(host.workspaceRoot)}\n\n${after}\nRevert with undo_edit(id="${entry.id}").`;
}

export async function undoEdit(host: ToolHost, id?: string): Promise<string> {
	const entry = host.state().journal.undo(id);
	return `Reverted edit ${entry.id}: ${entry.plan.description}\n\nFiles restored:\n${entry.plan.summary(host.workspaceRoot)}`;
}
