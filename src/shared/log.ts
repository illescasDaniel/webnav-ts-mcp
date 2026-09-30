/** Diagnostics go to stderr (stdout carries the MCP protocol) and only when `WEBNAV_MCP_DEBUG` is set. */

const enabled = Boolean(process.env.WEBNAV_MCP_DEBUG);

export function debug(message: string, error?: unknown): void {
	if (enabled) {
		const detail = error instanceof Error ? ` (${error.message})` : "";
		process.stderr.write(`[webnav] ${message}${detail}\n`);
	}
}

export function warn(message: string): void {
	process.stderr.write(`[webnav] ${message}\n`);
}
