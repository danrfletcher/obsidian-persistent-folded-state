import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PR-1 polish R3: every real-Obsidian script shares scripts/e2e-lib.mjs. A script with its own
 * CDP client or its own document-wide `.cm-line` fold helpers re-creates the background-editor
 * mismatch (T61/T62) and the unconfirmed fold click (T1) that the shared fold steps fix.
 * These are source-level checks: the scripts need a real Obsidian to run, the lib's behaviour
 * is covered in e2e-lib.test.ts.
 */
const ROOT = join(__dirname, "..", "..");
const LIB = "scripts/e2e-lib.mjs";

const SCRIPTS = [
	...readdirSync(join(ROOT, "scripts"))
		.filter((name) => /^e2e-.*-probe\.mjs$/.test(name))
		.map((name) => `scripts/${name}`),
	...readdirSync(join(ROOT, "tests", "e2e"))
		.filter((name) => name.endsWith(".e2e.ts"))
		.map((name) => `tests/e2e/${name}`),
];

/** Scripts that fold blocks in the live editor and then assert on what was stored. */
const FOLDING_SCRIPTS = [
	"scripts/e2e-restore-probe.mjs",
	"scripts/e2e-dormant-baseline-probe.mjs",
	"tests/e2e/dormant-baseline.e2e.ts",
	"tests/e2e/relaunch.e2e.ts",
	"tests/e2e/rename-delete.e2e.ts",
];

function read(path: string): string {
	return readFileSync(join(ROOT, path), "utf8");
}

/** The source with comments removed, so prose that mentions a helper does not count as code. */
function code(path: string): string {
	return read(path)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "");
}

describe("real-Obsidian scripts share scripts/e2e-lib.mjs", () => {
	it("finds the scripts it is meant to guard", () => {
		for (const path of FOLDING_SCRIPTS) expect(SCRIPTS).toContain(path);
	});

	for (const path of SCRIPTS) {
		it(`${path} imports the shared lib and carries no CDP/data.json plumbing of its own`, () => {
			const src = code(path);
			expect(src).toMatch(/from\s+"(\.\.?\/)+(scripts\/)?e2e-lib\.mjs"|from\s+"\.\/e2e-lib\.mjs"/);
			expect(src).not.toMatch(/function\s+(connectCdp|findDebuggableTarget\w*|withConnection|hashText|readPluginData)\b/);
			expect(src).not.toMatch(/new\s+WebSocket\(/);
		});

		it(`${path} does not search the whole document for editor lines`, () => {
			expect(code(path)).not.toMatch(/document\.querySelectorAll\(\s*["'`]\.cm-line/);
		});
	}

	for (const path of FOLDING_SCRIPTS) {
		it(`${path} folds through unfoldAll, parkCursorOutsideFolds and foldAndConfirm`, () => {
			const src = code(path);
			expect(src).toMatch(/\bunfoldAll\b/);
			expect(src).toMatch(/\bparkCursorOutsideFolds\b/);
			expect(src).toMatch(/\bfoldAndConfirm\b/);
			// A bare fold-indicator click reports clicked:true whether or not anything folded.
			// The only click left is expanding a block that is already folded.
			expect(src).not.toMatch(/clickFoldIndicator\w*\([^)]*\)[\s\S]{0,200}throw new Error\(`folding/);
		});
	}

	// T99/T100/T102: a fold click acts on the *active* editor and the plugin stores folds under the
	// note's vault-relative path. A script that folds without making --note the active editor, or
	// that looks the record up under a typed-in key, folds one note and checks another.
	for (const path of FOLDING_SCRIPTS) {
		it(`${path} makes --note the active editor and derives the stored key from it`, () => {
			const src = code(path);
			expect(src).toMatch(/\buseNote\(/);
			expect(src).not.toMatch(/--vault-path/);
			expect(src).not.toMatch(/\b(DEFAULT_\w*VAULT_PATH|args\.vaultPath)\b/);
			expect(src).not.toMatch(/files\[\s*["'`]/);
			expect(src).not.toMatch(/recordFor\([^)]*,\s*["'`]/);
		});
	}

	it("rename-delete creates the Archive folder before it moves the note into it (T101)", () => {
		const src = code("tests/e2e/rename-delete.e2e.ts");
		const create = src.indexOf("ensureFolderExpression(archiveFolder)");
		const move = src.indexOf("renameFileExpression(renamedVaultPath, movedVaultPath)");
		expect(create).toBeGreaterThan(-1);
		expect(move).toBeGreaterThan(create);
	});

	it("the lib header names the scripts that actually use it", () => {
		const header = read(LIB).slice(0, 1500);
		for (const name of ["relaunch.e2e.ts", "rename-delete.e2e.ts"]) {
			expect(header).toContain(name);
			expect(read(`tests/e2e/${name}`)).toContain("e2e-lib.mjs");
		}
	});
});
