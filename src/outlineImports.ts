/**
 * Keeps import bindings out of `outline`. TypeScript's language server reports every
 * imported name as a top-level `Variable`, which drowns the file's own structure; the
 * statements are found in the source text, so a name imported over several lines is
 * hidden too. `outline(detailed=true)` still lists them.
 */

import type { LspSymbol } from "./shared/lspTypes.js";
import { splitLines } from "./shared/text.js";

// A statement's last line ends in the module specifier (optionally followed by an import attribute).
const ENDS_WITH_SPECIFIER = /["'][^"']*["']\s*(?:(?:with|assert)\s*\{[^}]*\}\s*)?;?\s*(?:\/\/.*)?$/;
const IMPORT_EQUALS = /^import\s+(?:type\s+)?[\w$]+\s*=/;
const MAX_IMPORT_LINES = 500;

/** 0-based lines covered by top-level `import` statements. */
export function importLines(source: string): Set<number> {
	const lines = splitLines(source);
	const covered = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		if (!/^import\b/.test(lines[i] ?? "")) {
			continue;
		}
		let end = i;
		if (!(IMPORT_EQUALS.test(lines[i] ?? "") && !/["']/.test(lines[i] ?? ""))) {
			while (end < lines.length && end - i < MAX_IMPORT_LINES && !ENDS_WITH_SPECIFIER.test(lines[end] ?? "")) {
				end++;
			}
			if (end >= lines.length || end - i >= MAX_IMPORT_LINES) {
				end = i; // no specifier found: treat it as a one-line statement
			}
		}
		for (let line = i; line <= end; line++) {
			covered.add(line);
		}
		i = end;
	}
	return covered;
}

/** `symbols` without the ones declared on an import line (works for both `documentSymbol` shapes). */
export function dropImportSymbols(symbols: LspSymbol[], source: string): LspSymbol[] {
	const covered = importLines(source);
	if (covered.size === 0) {
		return symbols;
	}
	return symbols.filter((sym) => {
		const line = (sym.range ?? sym.location?.range)?.start?.line;
		return line === undefined || !covered.has(line);
	});
}
