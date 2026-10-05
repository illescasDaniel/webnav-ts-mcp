/**
 * Places a name still appears after an edit that only touched what the type
 * checker could link: strings, comments, docs, templates and files in other
 * languages. Reported to the agent, never edited.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EXCLUDED_DIR_NAMES, isExcluded } from "../shared/exclude.js";
import { escapeRegExp, splitLines } from "../shared/text.js";
import { relativeName } from "./edits.js";

const MENTION_SUFFIXES: ReadonlySet<string> = new Set([
	".js",
	".mjs",
	".cjs",
	".jsx",
	".ts",
	".mts",
	".cts",
	".tsx",
	".html",
	".css",
	".scss",
	".less",
	".vue",
	".svelte",
	".astro",
	".md",
	".mdx",
	".json",
]);

/** Whether `file` is worth scanning: a mentionable suffix, not minified, not under an excluded directory. */
function isMentionable(file: string, root: string): boolean {
	const name = path.basename(file).toLowerCase();
	return MENTION_SUFFIXES.has(path.extname(name)) && !/\.min\.[a-z]+$/.test(name) && !isExcluded(file, root);
}

/** Tracked and untracked-but-not-ignored files under `root`, or null when `root` is not in a git work tree. */
function gitFiles(root: string): string[] | null {
	try {
		const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out
			.split("\0")
			.filter(Boolean)
			.map((rel) => path.join(root, rel));
	} catch {
		return null;
	}
}

/**
 * Text files under `root` whose suffix can mention a web symbol. In a git work tree this follows
 * `.gitignore` (generated output such as a docs `site/` build is not source); elsewhere it walks the
 * directory tree skipping `EXCLUDED_DIR_NAMES`. Minified files are always skipped.
 */
export function mentionFiles(root: string, limit = 5000): string[] {
	const tracked = gitFiles(root);
	// Empty also when `root` is a directory an enclosing repository ignores: walk it then.
	if (tracked !== null && tracked.length > 0) {
		return tracked
			.filter((f) => isMentionable(f, root) && fs.existsSync(f))
			.sort()
			.slice(0, limit);
	}
	const files: string[] = [];
	const pending = [root];
	for (let dir = pending.pop(); dir !== undefined && files.length < limit; dir = pending.pop()) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		if (dir !== root && entries.some((e) => e.name === ".git")) {
			continue;
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!EXCLUDED_DIR_NAMES.has(entry.name)) {
					pending.push(full);
				}
			} else if (entry.isFile() && isMentionable(full, root)) {
				files.push(full);
			}
		}
	}
	return files.sort();
}

export interface Mention {
	file: string;
	line: number;
	text: string;
}

/**
 * Whole-word occurrences of `name` (identifier characters and `-` end a word, so `card` is not found in
 * `card-title`). `skip(file, line)` drops the places an edit already covers.
 */
export function findMentions(
	root: string,
	name: string,
	skip: (file: string, line: number) => boolean = () => false,
	limit = 12,
): { mentions: Mention[]; total: number } {
	const re = new RegExp(`(?<![\\w$-])${escapeRegExp(name)}(?![\\w$-])`);
	const mentions: Mention[] = [];
	let total = 0;
	for (const file of mentionFiles(root)) {
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		if (!text.includes(name)) {
			continue;
		}
		splitLines(text).forEach((line, index) => {
			if (re.test(line) && !skip(file, index + 1)) {
				total++;
				if (mentions.length < limit) {
					mentions.push({ file: relativeName(file, root), line: index + 1, text: line.trim().slice(0, 140) });
				}
			}
		});
	}
	return { mentions, total };
}

export function formatMentions(found: { mentions: Mention[]; total: number }, name: string, hint = ""): string[] {
	if (found.total === 0) {
		return [];
	}
	const rows = found.mentions.map((m) => `${m.file}:${m.line}: ${m.text}`);
	const more = found.total > found.mentions.length ? [`... ${found.total - found.mentions.length} more`] : [];
	return [
		`'${name}' still appears in ${found.total} place(s) the edit did not touch (strings, comments, docs or other languages)${hint}:\n      ${[...rows, ...more].join("\n      ")}`,
	];
}
