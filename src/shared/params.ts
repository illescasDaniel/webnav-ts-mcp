/**
 * Param-name aliases for MCP tools: agents often guess `query` vs `name`.
 *
 * Throwing a `ToolInputError` (rendered as tool text) beats the framework's
 * opaque schema-validation wall, which made agents abandon the MCP after one
 * wrong guess.
 */

import { ToolInputError } from "./errors.js";

export function resolveNameQuery(options: {
	preferred: string;
	example: string;
	params: Record<string, string | undefined | null>;
}): string {
	const { preferred, example } = options;
	const params: Record<string, string | undefined | null> = { [preferred]: undefined, ...options.params };
	let value = params[preferred];
	if (!value) {
		for (const [key, candidate] of Object.entries(params)) {
			if (key !== preferred && candidate) {
				value = candidate;
				break;
			}
		}
	}
	if (value) {
		return value;
	}
	const others = Object.keys(params).filter((key) => key !== preferred);
	const hint = `Pass \`${preferred}\` (e.g. ${preferred}='${example}')`;
	if (others.length === 0) {
		throw new ToolInputError(`${hint}.`);
	}
	const alias =
		others.length === 1
			? `\`${others[0]}\` is accepted as an alias`
			: `aliases accepted: ${others.map((key) => `\`${key}\``).join(", ")}`;
	throw new ToolInputError(`${hint}; ${alias}.`);
}
