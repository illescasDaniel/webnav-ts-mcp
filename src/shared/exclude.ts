/**
 * Directory names every workspace scan skips: vendored/generated/virtualenv
 * trees that are never a project's own source, so scanning them wastes time
 * at best and can abort a whole call on the first non-UTF-8 file at worst.
 */

import path from "node:path";

export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	"vendor",
	"dist",
	"build",
	"__pycache__",
	".venv",
	"venv",
	".venv-bare",
	"env",
	".env",
	"site-packages",
	".tox",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".pytest-testmon",
	".eggs",
]);

/** Whether `p` (absolute or root-relative) sits under a directory name in `EXCLUDED_DIR_NAMES` anywhere below `root`. */
export function isExcluded(p: string, root: string): boolean {
	const rel = path.relative(root, p);
	const parts = (rel.startsWith("..") || path.isAbsolute(rel) ? p : rel).split(path.sep);
	return parts.some((part) => EXCLUDED_DIR_NAMES.has(part));
}
