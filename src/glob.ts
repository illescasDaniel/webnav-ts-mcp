/** Just enough glob for `jsconfig.json` `include` entries. */

import fs from "node:fs";
import path from "node:path";
import { EXCLUDED_DIR_NAMES } from "./shared/exclude.js";
import { escapeRegExp } from "./shared/text.js";

function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern.charAt(i);
		if (ch === "*" && pattern.charAt(i + 1) === "*") {
			if (pattern.charAt(i + 2) === "/") {
				out += "(?:.*/)?";
				i += 2;
			} else {
				out += ".*";
				i += 1;
			}
		} else if (ch === "*") {
			out += "[^/]*";
		} else if (ch === "?") {
			out += "[^/]";
		} else {
			out += escapeRegExp(ch);
		}
	}
	return new RegExp(`^${out}$`);
}

/** Files under `root` matching a workspace-relative glob (a plain directory name matches everything below it). */
export function globFiles(root: string, pattern: string): string[] {
	let normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
	if (!/[*?]/.test(normalized)) {
		normalized += "/**/*";
		if (fs.existsSync(path.join(root, pattern)) && fs.statSync(path.join(root, pattern)).isFile()) {
			return [path.join(root, pattern)];
		}
	}
	const re = globToRegExp(normalized);
	const matches: string[] = [];
	const walk = (dir: string, rel: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!EXCLUDED_DIR_NAMES.has(entry.name)) {
					walk(path.join(dir, entry.name), childRel);
				}
			} else if (re.test(childRel)) {
				matches.push(path.join(dir, entry.name));
			}
		}
	};
	walk(root, "");
	return matches;
}
