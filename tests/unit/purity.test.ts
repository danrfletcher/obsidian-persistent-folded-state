/**
 * F1/F8/F9 — purity fence for the anchor-building module (PR-3): `src/normalize.ts` and
 * `src/anchors.ts` must have no Obsidian, CodeMirror, DOM, file or network dependency, and no
 * use of browser/runtime globals a pure text-in/data-out module has no business touching. This
 * is a static source scan, deliberately scoped to just these two files (not all of `src/`,
 * which `tests/unit/fence.test.ts` and `tests/lint/fence.test.ts` already cover for the rest of
 * the plugin).
 *
 * Also checks the module's exports don't creep into PR-4's territory (similarity/threshold/
 * matcher functions).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as normalizeModule from "../../src/normalize";
import * as anchorsModule from "../../src/anchors";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILES = [join(ROOT, "src", "normalize.ts"), join(ROOT, "src", "anchors.ts")];

/** Strips comments before scanning for forbidden *code* (not prose): both files' doc comments
 * talk *about* "document"/"fetch" in plain English (describing what this module must never
 * touch), which would otherwise false-positive against the bare-word checks below. Import/
 * require statements are never inside comments, so the import checks don't need this. */
function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const sources = FILES.map((f) => ({ file: f, text: readFileSync(f, "utf8"), code: stripComments(readFileSync(f, "utf8")) }));

/** R6 (PR-3): every way a module can pull in another one, not just `from "x"`: a static import
 * (`import x from "m"`, `export * from "m"`), a side-effect import (`import "m"`), a dynamic
 * import (`import("m")`) and `require("m")`. The pure modules may only reach siblings, so
 * every specifier found must be relative (`./...`). */
const MODULE_SPECIFIER_PATTERNS: RegExp[] = [
	/\bfrom\s*["']([^"']+)["']/g,
	/\bimport\s*["']([^"']+)["']/g,
	/\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g,
	/\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g,
];

/** Any `import(...)`/`require(...)` call whose argument is not a plain string literal can't be
 * checked statically, so it is itself forbidden. */
const NON_LITERAL_LOAD = /\b(?:import|require)\s*\(\s*(?!["'`])/;

function moduleSpecifiers(code: string): string[] {
	const found: string[] = [];
	for (const pattern of MODULE_SPECIFIER_PATTERNS) {
		for (const match of code.matchAll(pattern)) found.push(match[1]);
	}
	return found;
}

const FORBIDDEN_GLOBALS: { label: string; pattern: RegExp }[] = [
	{ label: "fetch(", pattern: /\bfetch\s*\(/ },
	{ label: "localStorage", pattern: /\blocalStorage\b/ },
	// Any reference to `document`, not only `document.` — `document[...]`, `typeof document`,
	// `const d = document` and a bare `document` are all DOM use.
	{ label: "document", pattern: /\bdocument\b/ },
	{ label: "window", pattern: /\bwindow\b/ },
	{ label: "globalThis", pattern: /\bglobalThis\b/ },
	{ label: "navigator", pattern: /\bnavigator\b/ },
	{ label: "process", pattern: /\bprocess\b/ },
];

describe("purity scan: the detectors catch the shapes they exist for (R6)", () => {
	it.each([
		['import "fs";', "fs"],
		['import("node:fs")', "node:fs"],
		["await import(`node:fs`)", "node:fs"],
		['import x from "obsidian";', "obsidian"],
		['export * from "@codemirror/state";', "@codemirror/state"],
		['const fs = require("fs");', "fs"],
	])("finds the module specifier in %s", (code, specifier) => {
		expect(moduleSpecifiers(code)).toContain(specifier);
	});

	it("flags an import()/require() whose argument is not a string literal", () => {
		expect('import(name)').toMatch(NON_LITERAL_LOAD);
		expect("require(modules[0])").toMatch(NON_LITERAL_LOAD);
		expect('import("./normalize")').not.toMatch(NON_LITERAL_LOAD);
	});

	it.each(["document[key]", "typeof document", "const d = document;", "document.body", "window.x", "globalThis.fetch"])(
		"flags DOM/global use in %s",
		(code) => {
			expect(FORBIDDEN_GLOBALS.some(({ pattern }) => pattern.test(code))).toBe(true);
		},
	);
});

describe("purity (F1/F8/F9): src/normalize.ts and src/anchors.ts have no I/O", () => {
	for (const { file, code } of sources) {
		describe(file, () => {
			it("imports only relative sibling modules (no obsidian, @codemirror, fs, node:* or other package)", () => {
				const specifiers = moduleSpecifiers(code);
				for (const specifier of specifiers) expect(specifier, specifier).toMatch(/^\.\//);
			});

			it("has no import()/require() call with a non-literal argument", () => {
				expect(code).not.toMatch(NON_LITERAL_LOAD);
			});

			it.each(FORBIDDEN_GLOBALS)("does not use $label", ({ pattern }) => {
				expect(code).not.toMatch(pattern);
			});
		});
	}
});

describe("exports: no similarity, threshold or matcher function (PR-4's territory)", () => {
	const forbiddenNamePattern = /similar|threshold|matcher/i;

	it("src/normalize.ts exports nothing matching similarity/threshold/matcher", () => {
		const names = Object.keys(normalizeModule);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(name).not.toMatch(forbiddenNamePattern);
		}
	});

	it("src/anchors.ts exports nothing matching similarity/threshold/matcher", () => {
		const names = Object.keys(anchorsModule);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(name).not.toMatch(forbiddenNamePattern);
		}
	});

	it("neither file's source text mentions similarity scoring, a threshold constant, or a match() function", () => {
		for (const { text } of sources) {
			expect(text).not.toMatch(/\bfunction\s+(similarity|match)\b/i);
			expect(text).not.toMatch(/\bexport\s+(function|const)\s+\w*[Tt]hreshold\w*/);
		}
	});
});
