/** Path helpers: symlink-resolving normalisation and containment checks. */

import fs from "node:fs";
import path from "node:path";

/** Absolute path with symlinks resolved when the path exists. */
export function resolveReal(p: string): string {
	const abs = path.resolve(p);
	try {
		return fs.realpathSync(abs);
	} catch {
		return abs;
	}
}

/** `child` relative to `parent` when it sits inside it (or equals it), else `undefined`. */
export function relativeWithin(child: string, parent: string): string | undefined {
	const rel = path.relative(parent, child);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		return undefined;
	}
	return rel;
}

export function toPosix(p: string): string {
	return p.split(path.sep).join("/");
}

/** Component-wise path ordering. */
export function comparePaths(a: string, b: string): number {
	const pa = a.split(path.sep);
	const pb = b.split(path.sep);
	for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
		const x = pa[i] as string;
		const y = pb[i] as string;
		if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return pa.length - pb.length;
}
