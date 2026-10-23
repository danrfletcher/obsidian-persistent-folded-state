/**
 * F7/F10 and purity for the embed key and slice modules (ticket warkworth-21 PR-3): static scan of
 * `src/embed-key.ts` and `src/embed-slice.ts`, patterned on tests/unit/purity.test.ts. Forbidden
 * imports and globals are checked on comment-stripped code; the doc comments name what the
 * modules must never touch.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as keyModule from "../../src/embed-key";
import * as sliceModule from "../../src/embed-slice";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILES = [join(ROOT, "src", "embed-key.ts"), join(ROOT, "src", "embed-slice.ts")];

function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const sources = FILES.map((file) => {
	const text = readFileSync(file, "utf8");
	return { file, text, code: stripComments(text) };
});

const FORBIDDEN_IMPORTS: { label: string; pattern: RegExp }[] = [
	{ label: 'import ... from "obsidian"', pattern: /from\s+["']obsidian["']/ },
	{ label: 'import ... from "@codemirror/*"', pattern: /from\s+["']@codemirror\// },
	{ label: 'import ... from "fs"', pattern: /from\s+["']fs["']/ },
	{ label: 'import ... from "node:*"', pattern: /from\s+["']node:/ },
	{ label: "require(...)", pattern: /\brequire\s*\(/ },
	{ label: "dynamic import(...)", pattern: /\bimport\s*\(/ },
];

const FORBIDDEN_GLOBALS: { label: string; pattern: RegExp }[] = [
	{ label: "document.", pattern: /\bdocument\./ },
	{ label: "fetch(", pattern: /\bfetch\s*\(/ },
	{ label: "window", pattern: /\bwindow\b/ },
	{ label: "setTimeout / setInterval / setImmediate", pattern: /\b(?:setTimeout|setInterval|setImmediate)\b/ },
	{ label: "requestAnimationFrame / requestIdleCallback", pattern: /\b(?:requestAnimationFrame|requestIdleCallback)\b/ },
	{ label: "queueMicrotask", pattern: /\bqueueMicrotask\b/ },
	{ label: "Date.now / new Date", pattern: /\bDate\.now\b|\bnew\s+Date\b/ },
	{ label: "Math.random", pattern: /\bMath\.random\b/ },
];

/** F7: nothing in these modules writes anywhere. */
const FORBIDDEN_WRITES: { label: string; pattern: RegExp }[] = [
	{ label: "vault", pattern: /\bvault\b/ },
	{ label: "process", pattern: /\bprocess\b/ },
	{ label: "adapter", pattern: /\badapter\b/ },
	{ label: "editor", pattern: /\beditor\b/ },
	{ label: "replaceRange / replaceSelection / setValue", pattern: /\b(?:replaceRange|replaceSelection|replaceAll|setValue)\b/ },
	{ label: "a file API (writeFile, createWriteStream, appendFile)", pattern: /\b(?:writeFile\w*|createWriteStream|appendFile\w*)\b/ },
	{ label: "dispatch", pattern: /\bdispatch\b/ },
];

/** F10: no use of Obsidian's local storage fold store. */
const FORBIDDEN_STORAGE: { label: string; pattern: RegExp }[] = [
	{ label: "localStorage", pattern: /localStorage/ },
	{ label: "loadLocalStorage", pattern: /loadLocalStorage/ },
	{ label: "saveLocalStorage", pattern: /saveLocalStorage/ },
];

describe("purity: src/embed-key.ts and src/embed-slice.ts have no I/O", () => {
	for (const { file, text, code } of sources) {
		describe(file, () => {
			it.each(FORBIDDEN_IMPORTS)("does not import or require $label", ({ pattern }) => {
				expect(text).not.toMatch(pattern);
			});

			it.each(FORBIDDEN_GLOBALS)("does not use $label", ({ pattern }) => {
				expect(code).not.toMatch(pattern);
			});

			it("imports only the allowed sibling modules (types, normalize, and hashText from fold-store)", () => {
				const specifiers = [...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
				const allowed = new Set(["./types", "./normalize", "./fold-store"]);
				for (const specifier of specifiers) expect(allowed.has(specifier), specifier).toBe(true);
			});
		});
	}
});

describe("F7: nothing in the new modules writes anywhere", () => {
	for (const { file, code, text } of sources) {
		describe(file, () => {
			it.each(FORBIDDEN_WRITES)("does not use $label", ({ pattern }) => {
				expect(code).not.toMatch(pattern);
			});

			it("has no fold-store write call (the only store import is hashText)", () => {
				const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/fold-store["']/g)];
				for (const match of imports) expect(match[1].trim()).toBe("hashText");
			});
		});
	}
});

describe("F10: no localStorage fold store", () => {
	for (const { file, text } of sources) {
		it.each(FORBIDDEN_STORAGE)(`${file} does not use $label`, ({ pattern }) => {
			expect(text).not.toMatch(pattern);
		});
	}
});

describe("exports: no matcher, similarity or store function", () => {
	const forbiddenName = /similar|threshold|matcher|match(?!es)|store|persist|record|restore|migrate|prune|forget|dormant/i;

	it("src/embed-key.ts exports the expected names and nothing matcher-like", () => {
		const names = Object.keys(keyModule).sort();
		expect(names).toEqual(
			["buildChainKey", "buildEmbedKey", "encodeEmbedKey", "findEmbedKey", "findEmbeds", "listEmbedKeys", "parseEmbedLinktext"].sort(),
		);
		for (const name of names) expect(name).not.toMatch(forbiddenName);
	});

	it("src/embed-slice.ts exports only sliceEmbed", () => {
		const names = Object.keys(sliceModule);
		expect(names).toEqual(["sliceEmbed"]);
		for (const name of names) expect(name).not.toMatch(forbiddenName);
	});

	it("neither source declares a similarity, threshold or match function", () => {
		for (const { code } of sources) {
			expect(code).not.toMatch(/\bfunction\s+\w*(?:[Ss]imilarity|[Mm]atch(?:er)?|[Tt]hreshold)\w*/);
			expect(code).not.toMatch(/\bexport\s+(?:function|const)\s+\w*[Tt]hreshold\w*/);
		}
	});
});
