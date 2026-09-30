/** Text helpers shared by the file readers and formatters. */

import fs from "node:fs";
import { Utf8DecodeError } from "./errors.js";

// `ignoreBOM: true` keeps a leading BOM in the text, so offsets match what the
// language server is sent (and what the Python implementation reported).
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Read a file as UTF-8, failing (like Python's `read_text`) instead of substituting U+FFFD. */
export function readTextStrict(filePath: string): string {
	const bytes = fs.readFileSync(filePath);
	try {
		return strictUtf8.decode(bytes);
	} catch {
		throw new Utf8DecodeError("invalid UTF-8 byte sequence");
	}
}

/** Line terminators as LSP defines them (`\r\n`, `\r`, `\n`). */
export const LINE_BREAK_RE = /\r\n|\r|\n/;

/** Lines of `text` without terminators; a trailing terminator doesn't add an empty last line. */
export function splitLines(text: string): string[] {
	const lines = text.split(LINE_BREAK_RE);
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
