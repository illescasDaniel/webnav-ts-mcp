/**
 * Which script files import a given file. A relative-specifier scan, not a
 * module resolver: `./a`, `./a.js` (for `a.ts`), `./dir` (for `dir/index.ts`)
 * are understood; path aliases and bare package names are not, so a file
 * imported only through an alias is checked with its own edit alone.
 */

import fs from "node:fs";
import path from "node:path";
import { EXCLUDED_DIR_NAMES } from "../shared/exclude.js";
import { canonicalPath } from "../shared/paths.js";

export const SCRIPT_SUFFIXES: ReadonlySet<string> = new Set([
	".js",
	".mjs",
	".cjs",
	".jsx",
	".ts",
	".mts",
	".cts",
	".tsx",
]);

const SPECIFIER_RES = [
	/\bfrom\s*["']([^"'\n]+)["']/g,
	/\bimport\s*["']([^"'\n]+)["']/g,
	/\bimport\s*\(\s*["']([^"'\n]+)["']/g,
	/\brequire\s*\(\s*["']([^"'\n]+)["']/g,
];

// `./a.js` in source means `a.ts` on disk under TypeScript's emit-style resolution.
const JS_TO_TS: Record<string, string[]> = {
	".js": [".ts", ".tsx", ".js", ".jsx"],
	".jsx": [".tsx", ".jsx"],
	".mjs": [".mts", ".mjs"],
	".cjs": [".cts", ".cjs"],
};

/** Absolute paths a relative `specifier` written in `fromFile` can mean. */
export function candidatePaths(fromFile: string, specifier: string): string[] {
	if (!specifier.startsWith(".")) {
		return [];
	}
	const base = path.resolve(path.dirname(fromFile), specifier);
	const out = [base];
	const ext = path.extname(base);
	const stem = base.slice(0, base.length - ext.length);
	for (const replacement of JS_TO_TS[ext] ?? []) {
		out.push(stem + replacement);
	}
	for (const suffix of SCRIPT_SUFFIXES) {
		out.push(base + suffix, path.join(base, `index${suffix}`));
	}
	return out;
}

export function scriptFilesIn(root: string, limit = 20000): string[] {
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
			continue; // a nested checkout or worktree
		}
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!EXCLUDED_DIR_NAMES.has(entry.name)) {
					pending.push(full);
				}
			} else if (entry.isFile() && SCRIPT_SUFFIXES.has(path.extname(entry.name).toLowerCase())) {
				files.push(full);
			}
		}
	}
	return files;
}

export function specifiersIn(text: string): string[] {
	const found = new Set<string>();
	for (const re of SPECIFIER_RES) {
		for (const match of text.matchAll(re)) {
			found.add(match[1] as string);
		}
	}
	return [...found];
}

/** Script files under `root` (other than `targets` themselves) that import one of `targets`. */
export function findDependents(root: string, targets: readonly string[]): string[] {
	// Candidates are only path.resolve()d (cheap); targets are matched under both spellings.
	const wanted = new Set(targets.flatMap((t) => [path.resolve(t), canonicalPath(t)]));
	const out: string[] = [];
	for (const file of scriptFilesIn(root)) {
		const resolved = path.resolve(file);
		if (wanted.has(resolved)) {
			continue;
		}
		let text: string;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const hit = specifiersIn(text).some((spec) => candidatePaths(file, spec).some((c) => wanted.has(c)));
		if (hit) {
			out.push(resolved);
		}
	}
	return out.sort();
}
