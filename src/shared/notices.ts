/**
 * Out-of-band messages for the agent, appended to tool results.
 *
 * Two kinds: one-shot notices posted while a call runs (e.g. "restarted the
 * language server because tsconfig.json changed") and a sticky one while the
 * server's own source files differ from what it started with. A stdio MCP
 * server can't reload itself, so the most it can do about stale code is say
 * so on every call.
 */

import fs from "node:fs";
import path from "node:path";

const RECHECK_MS = 2000;

function sourceStamp(dirs: readonly string[]): string {
	const found: string[] = [];
	const walk = (dir: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.name.endsWith(".js")) {
				try {
					const st = fs.statSync(full, { bigint: true });
					found.push(`${full}:${st.mtimeNs}:${st.size}`);
				} catch {}
			}
		}
	};
	for (const dir of dirs) {
		walk(dir);
	}
	return found.sort().join("\n");
}

export class NoticeBoard {
	private readonly startedWith: string;
	private pending: string[] = [];
	private checkedAt = Date.now();
	private stale = false;

	constructor(
		readonly serverName: string,
		private readonly sourceDirs: readonly string[],
		private readonly recheckMs = RECHECK_MS,
	) {
		this.startedWith = sourceStamp(sourceDirs);
	}

	post(message: string): void {
		if (!this.pending.includes(message)) {
			this.pending.push(message);
		}
	}

	private codeIsStale(): boolean {
		// A stat walk per tool call adds up; a few seconds' lag in noticing an edit is fine.
		const now = Date.now();
		if (now - this.checkedAt >= this.recheckMs) {
			this.checkedAt = now;
			this.stale = sourceStamp(this.sourceDirs) !== this.startedWith;
		}
		return this.stale;
	}

	/** One-shot notices posted since the last call, plus the sticky stale-code line. */
	drain(): string[] {
		const notices = this.pending;
		this.pending = [];
		if (this.codeIsStale()) {
			notices.push(
				`the ${this.serverName} server's own code changed since it started; restart the MCP servers to use the new version.`,
			);
		}
		return notices;
	}

	annotate(text: string): string {
		const notices = this.drain();
		return notices.length === 0 ? text : text + notices.map((n) => `\n\n[${this.serverName}] ${n}`).join("");
	}
}
