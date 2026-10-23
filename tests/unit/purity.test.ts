/**
 * F1/F8/F9 — purity fence for the anchor-building module (PR-3): `src/normalize.ts` and
 * `src/anchors.ts` must have no Obsidian, CodeMirror, DOM, file or network dependency, and no
 * use of browser/runtime globals a pure text-in/data-out module has no business touching. This
 * is a static source scan, deliberately scoped to just these two files and, further down, the
 * PR-6 planner `src/embed-rematch.ts` (not all of `src/`, which `tests/unit/fence.test.ts` and
 * `tests/lint/fence.test.ts` already cover for the rest of the plugin).
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

const FORBIDDEN_IMPORTS: { label: string; pattern: RegExp }[] = [
	{ label: 'import ... from "obsidian"', pattern: /from\s+["']obsidian["']/ },
	{ label: 'import ... from "@codemirror/*"', pattern: /from\s+["']@codemirror\// },
	{ label: 'import ... from "fs"', pattern: /from\s+["']fs["']/ },
	{ label: 'import ... from "node:*"', pattern: /from\s+["']node:/ },
	{ label: 'require("obsidian")', pattern: /require\(\s*["']obsidian["']\s*\)/ },
	{ label: 'require("@codemirror/*")', pattern: /require\(\s*["']@codemirror\// },
	{ label: 'require("fs")', pattern: /require\(\s*["']fs["']\s*\)/ },
	{ label: 'require("node:*")', pattern: /require\(\s*["']node:/ },
];

const FORBIDDEN_GLOBALS: { label: string; pattern: RegExp }[] = [
	{ label: "fetch(", pattern: /\bfetch\s*\(/ },
	{ label: "localStorage", pattern: /\blocalStorage\b/ },
	{ label: "document", pattern: /\bdocument\./ },
];

describe("purity (F1/F8/F9): src/normalize.ts and src/anchors.ts have no I/O", () => {
	for (const { file, text, code } of sources) {
		describe(file, () => {
			it.each(FORBIDDEN_IMPORTS)("does not import or require $label", ({ pattern }) => {
				expect(text).not.toMatch(pattern);
			});

			it.each(FORBIDDEN_GLOBALS)("does not use $label", ({ pattern }) => {
				expect(code).not.toMatch(pattern);
			});
		});
	}
});

/**
 * PR-6: the embed re-match planner (src/embed-rematch.ts) is the same kind of module: text and
 * anchors in, a plan out. It may import the matcher, the anchors and their types, and nothing from
 * Obsidian, CodeMirror, Node or the DOM. The only scheduling it does is awaiting the `yieldToHost`
 * it is handed, so it names no timer.
 */
describe("purity (PR-6): src/embed-rematch.ts imports no Obsidian, CodeMirror, Node or DOM API", () => {
	const file = join(ROOT, "src", "embed-rematch.ts");
	const text = readFileSync(file, "utf8");
	const code = stripComments(text);

	it.each(FORBIDDEN_IMPORTS)("does not import or require $label", ({ pattern }) => {
		expect(text).not.toMatch(pattern);
	});

	it.each(FORBIDDEN_GLOBALS)("does not use $label", ({ pattern }) => {
		expect(code).not.toMatch(pattern);
	});

	it.each([
		{ label: "window", pattern: /\bwindow\b/ },
		{ label: "a timer (setTimeout, setInterval, requestAnimationFrame)", pattern: /\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\b/ },
		{ label: "a DOM type (Element, HTMLElement, Document, MutationObserver)", pattern: /\b(?:Element|HTMLElement|Document|MutationObserver|Node)\b/ },
	])("does not use $label", ({ pattern }) => {
		expect(code).not.toMatch(pattern);
	});

	it("imports only the local pure modules (./anchors, ./matcher)", () => {
		const sources = Array.from(text.matchAll(/from\s+["']([^"']+)["']/g)).map((m) => m[1]);
		expect(sources.length).toBeGreaterThan(0);
		for (const source of sources) expect(["./anchors", "./matcher"]).toContain(source);
	});
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
