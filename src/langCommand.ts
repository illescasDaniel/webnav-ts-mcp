/**
 * Resolves how to launch the Node-based language servers webnav multiplexes to.
 *
 * Unlike the Python distribution, the servers are ordinary npm dependencies of
 * this package, so there is nothing to download at runtime: a TypeScript 7+
 * install in the navigated project wins (it matches the project's own
 * compiler), else the copy that came with webnav. Both are launched through
 * the current `node` executable rather than `.bin` shims, which sidesteps
 * `.cmd` handling on Windows and PATH differences under GUI-launched hosts.
 *
 * JS/TS uses TypeScript 7's native LSP (`tsc --lsp --stdio`).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolInputError } from "./shared/errors.js";

interface PackageJson {
	name?: string;
	version?: string;
	bin?: string | Record<string, string>;
}

function readPackageJson(dir: string): PackageJson | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as PackageJson;
	} catch {
		return undefined;
	}
}

/** Directories to look for `node_modules/<pkg>` in: the navigated workspace, then every ancestor of this module (webnav's own install, hoisted or nested). */
function searchDirs(workspaceRoot: string): string[] {
	const dirs = [workspaceRoot];
	for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
		dirs.push(dir);
		if (path.dirname(dir) === dir) {
			break;
		}
	}
	return dirs;
}

function findPackage(
	workspaceRoot: string,
	name: string,
	accept: (pkg: PackageJson) => boolean = () => true,
): { dir: string; pkg: PackageJson } | undefined {
	for (const base of searchDirs(workspaceRoot)) {
		const dir = path.join(base, "node_modules", ...name.split("/"));
		const pkg = readPackageJson(dir);
		if (pkg?.name === name && accept(pkg)) {
			return { dir, pkg };
		}
	}
	return undefined;
}

function binPath(dir: string, pkg: PackageJson, binName: string): string | undefined {
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[binName];
	return bin ? path.join(dir, bin) : undefined;
}

const isTypescript7 = (pkg: PackageJson): boolean => Number.parseInt((pkg.version ?? "").split(".")[0] ?? "", 10) >= 7;

/** Launch TypeScript 7's native language server: `tsc --lsp --stdio`. */
export function resolveTsCommand(workspaceRoot: string): string[] {
	const found = findPackage(workspaceRoot, "typescript", isTypescript7);
	const tsc = found && binPath(found.dir, found.pkg, "tsc");
	if (!tsc) {
		throw new ToolInputError(
			"TypeScript 7 (`typescript@^7`) was not found in the workspace or in webnav's own dependencies; " +
				"reinstall webnav-ts-mcp or run `npm install --save-dev typescript@^7` in the project.",
		);
	}
	return [process.execPath, tsc, "--lsp", "--stdio"];
}

function resolveLangserver(workspaceRoot: string, binName: string): string[] {
	const found = findPackage(workspaceRoot, "vscode-langservers-extracted");
	const bin = found && binPath(found.dir, found.pkg, binName);
	if (!bin) {
		throw new ToolInputError(
			"`vscode-langservers-extracted` was not found in the workspace or in webnav's own dependencies; " +
				"reinstall webnav-ts-mcp or run `npm install --save-dev vscode-langservers-extracted` in the project.",
		);
	}
	return [process.execPath, bin, "--stdio"];
}

export const resolveHtmlCommand = (workspaceRoot: string): string[] =>
	resolveLangserver(workspaceRoot, "vscode-html-language-server");

export const resolveCssCommand = (workspaceRoot: string): string[] =>
	resolveLangserver(workspaceRoot, "vscode-css-language-server");
