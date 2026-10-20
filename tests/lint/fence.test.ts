/**
 * Static fence checks new to this PR:
 * - F9: no interception or rewriting of Obsidian's own localStorage fold store.
 * - F10: no vault-modify fallback, no debug command (the dynamic half of F10 — the exact
 *   registered command list — lives in tests/unit/lifecycle.test.ts, which already instantiates
 *   the plugin; this file only adds the static greps).
 * - F1: no write-capable vault/editor/adapter API reached for anywhere in src/ (the near-miss
 *   check's true proof — the note's bytes on disk unchanged after a real external write — is a
 *   container-only check; this is the closest static approximation reachable here).
 *
 * Scans `src/**​/*.ts` only — `tests/unit/fence.test.ts` (from PR-1) already covers F7/F8 and the
 * manifest/build checks; this file doesn't repeat those.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");

function listFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listFiles(full));
		else out.push(full);
	}
	return out;
}

const srcFiles = listFiles(SRC).filter((f) => f.endsWith(".ts"));
const srcText = srcFiles.map((f) => readFileSync(f, "utf8")).join("\n");

describe("fence: F9 — no interception of Obsidian's own localStorage fold store", () => {
	const FORBIDDEN = [
		{ label: "localStorage", pattern: /\blocalStorage\b/ },
		{ label: "loadLocalStorage", pattern: /\bloadLocalStorage\b/ },
		{ label: "saveLocalStorage", pattern: /\bsaveLocalStorage\b/ },
	];

	it.each(FORBIDDEN)("src/ does not use $label", ({ pattern }) => {
		expect(srcText).not.toMatch(pattern);
	});
});

describe("fence: F10 — no vault-modify fallback", () => {
	it('src/ does not call vault.on("modify", ...)', () => {
		expect(srcText).not.toMatch(/\bvault\.on\s*\(\s*["']modify["']/);
	});

	it('src/ does not registerEvent(...) a "modify" vault event', () => {
		// Covers both `this.registerEvent(this.app.vault.on("modify", ...))` and any other
		// wrapping of the same event name through registerEvent.
		expect(srcText).not.toMatch(/registerEvent\s*\([^)]*["']modify["']/s);
	});
});

describe("fence: F1 — no write-capable vault/editor/adapter API reached for by this PR", () => {
	const WRITE_APIS = [
		{ label: "vault.modify(", pattern: /\bvault\.modify\s*\(/ },
		{ label: "vault.append(", pattern: /\bvault\.append\s*\(/ },
		{ label: "vault.create(", pattern: /\bvault\.create\s*\(/ },
		{ label: "vault.process(", pattern: /\bvault\.process\s*\(/ },
		{ label: "adapter.write(", pattern: /\badapter\.write\s*\(/ },
		{ label: "editor.replaceRange(", pattern: /\breplaceRange\s*\(/ },
		{ label: "editor.setValue(", pattern: /\bsetValue\s*\(/ },
	];

	it.each(WRITE_APIS)("src/ does not call $label", ({ pattern }) => {
		expect(srcText).not.toMatch(pattern);
	});

	// PR-2's own self-imposed fence ("it records what it sees but never dispatches — restore is
	// PR-5") no longer applies: PR-5 is exactly the PR that dispatches tagged CM6 fold effects
	// (src/fold-restorer.ts), so a plain "no .dispatch( anywhere in src/" check would now fail
	// on legitimate, in-scope code. F1 itself — no write into the note's markdown/frontmatter —
	// is still enforced above by the vault/editor/adapter API checks; CM6's own `dispatch` is a
	// different kind of write (an in-memory editor-state transaction, never touching the file on
	// disk) and was never what F1 was guarding against.
});

