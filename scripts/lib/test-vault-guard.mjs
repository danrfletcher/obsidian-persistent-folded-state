/**
 * A guard for the e2e scripts that delete notes and data.json in "the vault" (PR-8 R6): they refuse
 * to run unless the vault is plainly a test vault, so a --vault-root or CDP port pointed at Dan's
 * real vault by mistake removes nothing.
 *
 * A vault is a test vault when BOTH hold:
 *  - its folder is named `test-vault`, or holds a file called `.pfs-test-vault` (a marker to put
 *    in a differently named test vault); and
 *  - the vault the connected Obsidian reports as open (`app.vault.adapter.basePath`) is the folder
 *    the script was told to write to, so the files it copies in are the files that Obsidian sees.
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const TEST_VAULT_NAME = "test-vault";
export const TEST_VAULT_MARKER = ".pfs-test-vault";

/** Why `vaultRoot` is not a test vault by name, or null when it is one: its folder is called
 * `test-vault`, or it holds the marker file. Needs no running Obsidian, so it is the check for a
 * script that writes while Obsidian is quit. `exists` is injectable for tests. */
export function testVaultNameProblem(vaultRoot, exists = existsSync) {
	const root = resolve(vaultRoot);
	if (basename(root) !== TEST_VAULT_NAME && !exists(join(root, TEST_VAULT_MARKER))) {
		return `${root} is not a test vault: its folder is not named "${TEST_VAULT_NAME}" and it has no ${TEST_VAULT_MARKER} file. This script deletes or overwrites notes and data.json there, so it refuses to run.`;
	}
	return null;
}

/** Why `vaultRoot` is not a test vault, or null when it is one. `openVaultPath` is the vault the
 * connected Obsidian has open (null when it could not be read); `exists` is injectable for tests.
 * `expectedOpenPath` is the path Obsidian is expected to report for the same vault: `vaultRoot`
 * itself, unless Obsidian runs in a container and sees the vault at another path. */
export function testVaultProblem(vaultRoot, openVaultPath, exists = existsSync, expectedOpenPath = vaultRoot) {
	const nameProblem = testVaultNameProblem(vaultRoot, exists);
	if (nameProblem !== null) return nameProblem;
	if (typeof openVaultPath !== "string" || openVaultPath === "") {
		return "could not read which vault the connected Obsidian has open, so cannot tell that it is the test vault";
	}
	if (resolve(openVaultPath) !== resolve(expectedOpenPath)) {
		return `the connected Obsidian has ${resolve(openVaultPath)} open, not ${resolve(expectedOpenPath)} (the vault root given to the script): refusing to write anything in either`;
	}
	return null;
}

/** Throws unless `vaultRoot` is a test vault and is the vault Obsidian has open. */
export function assertTestVault(vaultRoot, openVaultPath, exists = existsSync, expectedOpenPath = vaultRoot) {
	const problem = testVaultProblem(vaultRoot, openVaultPath, exists, expectedOpenPath);
	if (problem !== null) throw new Error(`test-vault guard: ${problem}`);
}

/** Throws unless `vaultRoot` is a test vault by name or marker (no running Obsidian needed). */
export function assertTestVaultName(vaultRoot, exists = existsSync) {
	const problem = testVaultNameProblem(vaultRoot, exists);
	if (problem !== null) throw new Error(`test-vault guard: ${problem}`);
}

/** The nearest folder at or above the folder of `notePath` that is a test vault by name or marker,
 * or null when there is none (the note is not in a test vault). */
export function enclosingTestVault(notePath, exists = existsSync) {
	let dir = dirname(resolve(notePath));
	for (;;) {
		if (testVaultNameProblem(dir, exists) === null) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Throws unless the note at `notePath` sits inside a test vault. */
export function assertNoteInTestVault(notePath, exists = existsSync) {
	if (enclosingTestVault(notePath, exists) === null) {
		throw new Error(`test-vault guard: ${resolve(notePath)} is not inside a test vault (no enclosing folder named "${TEST_VAULT_NAME}" or holding a ${TEST_VAULT_MARKER} file). This script overwrites that note, so it refuses to run.`);
	}
}

/** `path` with symlinks resolved as far as it exists (the nearest existing ancestor is resolved,
 * the rest is appended), so a link inside the test vault that leads out of it is seen.
 * @param {string} path
 * @param {(path: string) => string} [real] */
function realish(path, real = realpathSync) {
	const rest = [];
	let current = resolve(path);
	for (;;) {
		try {
			return join(real(current), ...rest);
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path);
			rest.unshift(basename(current));
			current = parent;
		}
	}
}

/** Why `dataPath` is not a plugin data file inside `vaultRoot`, or null when it is one: exactly
 * `<vaultRoot>/.obsidian/plugins/<plugin id>/data.json`. A script that deletes data.json checks
 * this as well as the vault itself, because `--data` can name a file anywhere.
 * @param {string} vaultRoot
 * @param {string} dataPath
 * @param {(path: string) => string} [real] resolves symlinks; injectable for tests */
export function dataFileProblem(vaultRoot, dataPath, real = realpathSync) {
	const rel = relative(realish(vaultRoot, real), realish(dataPath, real));
	const parts = rel.split(sep);
	const inside = rel !== "" && !isAbsolute(rel) && parts.length === 4 && parts[0] === ".obsidian" && parts[1] === "plugins" && parts[2] !== ".." && parts[3] === "data.json";
	if (!inside) {
		return `${resolve(dataPath)} is not <vault root>/.obsidian/plugins/<plugin id>/data.json inside ${resolve(vaultRoot)}; this script deletes that file, so it refuses to run`;
	}
	return null;
}

/** Throws unless `dataPath` is a plugin data.json inside the test vault `vaultRoot`.
 * @param {string} vaultRoot
 * @param {string} dataPath
 * @param {(path: string) => string} [real] resolves symlinks; injectable for tests */
export function assertDataFileInVault(vaultRoot, dataPath, real = realpathSync) {
	const problem = dataFileProblem(vaultRoot, dataPath, real);
	if (problem !== null) throw new Error(`test-vault guard: ${problem}`);
}
