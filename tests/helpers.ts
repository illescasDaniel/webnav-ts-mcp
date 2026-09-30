import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];

/** A fresh temp dir populated from `{ "rel/path": "text" }`, removed after each test. */
export function makeTree(files: Record<string, string> = {}): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "webnav-test-")));
	dirs.push(dir);
	for (const [rel, text] of Object.entries(files)) {
		const full = path.join(dir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, text);
	}
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
