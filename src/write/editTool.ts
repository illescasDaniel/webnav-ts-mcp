/** `edit`: a type-checked text edit of one web file. */

import fs from "node:fs";
import { ToolInputError } from "../shared/errors.js";
import { newErrorLimit, requireText, resolveArgPath, type ToolHost, type WriteArgs } from "./common.js";
import { createChange, detectEol, EditPlan, modifyChange, readSource, relativeName } from "./edits.js";
import { finishPlan } from "./finish.js";

export interface EditArgs extends WriteArgs {
	filePath?: string | undefined;
	oldString?: string | undefined;
	newString?: string | undefined;
	replaceAll?: boolean | undefined;
	newText?: string | undefined;
	includeDependents?: boolean | undefined;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
		count++;
	}
	return count;
}

/** A line of `needle` that does appear in `text`, to tell a near miss (whitespace) from a wrong anchor. */
function nearMiss(text: string, needle: string): string {
	const first = needle.split(/\r?\n/).find((line) => line.trim() !== "");
	if (first === undefined) {
		return "";
	}
	const lines = text.split(/\r?\n/);
	const at = lines.findIndex((line) => line.trim() === first.trim());
	return at === -1
		? ""
		: ` Its first line does appear at line ${at + 1}, so the difference is further down or in whitespace/indentation.`;
}

/** Match the file's line endings: an agent writes `\n`, a CRLF file needs `\r\n`. */
const withEol = (snippet: string, eol: string): string =>
	eol === "\r\n" ? snippet.replace(/\r?\n/g, "\r\n") : snippet;

export async function edit(host: ToolHost, args: EditArgs): Promise<string> {
	const file = resolveArgPath(host, requireText(args.filePath, "`file_path`"));
	const rel = relativeName(file, host.workspaceRoot);
	const exists = fs.existsSync(file) && fs.statSync(file).isFile();
	const wantsReplace = args.oldString !== undefined || args.newString !== undefined;
	if (args.newText !== undefined && wantsReplace) {
		throw new ToolInputError("pass either new_text (the whole file) or old_string with new_string, not both.");
	}
	let plan: EditPlan;
	if (args.newText !== undefined) {
		if (exists) {
			const current = readSource(file);
			plan = new EditPlan(`Rewrite ${rel}`, [
				modifyChange(file, current.text, withEol(args.newText, detectEol(current.text)), current.bom),
			]);
		} else {
			plan = new EditPlan(`Create ${rel}`, [createChange(file, args.newText)]);
		}
	} else {
		if (args.oldString === undefined || args.newString === undefined) {
			throw new ToolInputError("pass new_text (the whole file), or both old_string and new_string.");
		}
		if (args.oldString === "") {
			throw new ToolInputError("old_string is empty; to write a whole file pass new_text.");
		}
		if (!exists) {
			throw new ToolInputError(
				`File not found: ${args.filePath} (old_string/new_string need an existing file; use new_text to create one).`,
			);
		}
		const current = readSource(file);
		const eol = detectEol(current.text);
		// The file's own line endings first; a snippet that only matches as written (a file with mixed endings) second.
		const variants = [
			{ oldString: withEol(args.oldString, eol), newString: withEol(args.newString, eol) },
			{ oldString: args.oldString, newString: args.newString },
		];
		const { oldString, newString } =
			variants.find((v) => current.text.includes(v.oldString)) ?? (variants[0] as (typeof variants)[0]);
		if (oldString === newString) {
			throw new ToolInputError("old_string and new_string are identical.");
		}
		const count = countOccurrences(current.text, oldString);
		if (count === 0) {
			throw new ToolInputError(`old_string was not found in ${rel}.${nearMiss(current.text, oldString)}`);
		}
		if (count > 1 && !args.replaceAll) {
			throw new ToolInputError(`old_string matches ${count} times in ${rel}; make it unique or pass replace_all=true.`);
		}
		const next = current.text.split(oldString).join(newString);
		plan = new EditPlan(`Edit ${rel}${count > 1 ? ` (${count} replacements)` : ""}`, [
			modifyChange(file, current.text, next, current.bom),
		]);
	}
	const outcome = await finishPlan(host, plan, plan.description, {
		apply: args.apply ?? true,
		maxNewErrors: newErrorLimit(args.maxNewErrors),
		includeDependents: args.includeDependents ?? true,
	});
	return outcome.text;
}
