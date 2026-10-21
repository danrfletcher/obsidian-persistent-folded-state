/**
 * F1/F8 — purity fence for PR-4's two modules: `src/similarity.ts` and `src/matcher.ts` must
 * have no Obsidian, CodeMirror, DOM, file or network dependency, and no timer/`Date.now()`/
 * storage use — plain data in, plain data out. Also checks F6: no export, option or result
 * field anywhere refers to a "moved" block (the only out-of-scope search this module ever does
 * is the G14 file-wide fallback), and that `src/main.ts` doesn't import the matcher yet (wiring
 * it in is PR-5's job).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as similarityModule from "../../src/similarity";
import * as matcherModule from "../../src/matcher";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SIMILARITY_FILE = join(ROOT, "src", "similarity.ts");
const MATCHER_FILE = join(ROOT, "src", "matcher.ts");
const MAIN_FILE = join(ROOT, "src", "main.ts");
const FILES = [SIMILARITY_FILE, MATCHER_FILE];

/** Strips comments before scanning for forbidden *code* (not prose): both files' doc comments
 * talk *about* forbidden things in plain English (describing what this module must never
 * touch), which would otherwise false-positive against the bare-word checks below. Import
 * statements are never inside comments, so the import allow-list doesn't need this. */
function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const sources = FILES.map((f) => ({
	file: f,
	text: readFileSync(f, "utf8"),
	code: stripComments(readFileSync(f, "utf8")),
}));

/** Only the standard library and PR-3's own modules (`./anchors`, `./normalize`) are allowed;
 * everything else — named explicitly below — is forbidden. */
const FORBIDDEN_IMPORTS: { label: string; pattern: RegExp }[] = [
	{ label: 'import ... from "obsidian"', pattern: /from\s+["']obsidian["']/ },
	{ label: 'import ... from "@codemirror/*"', pattern: /from\s+["']@codemirror\// },
	{ label: 'import ... from "fs"/"node:fs"', pattern: /from\s+["'](node:)?fs["']/ },
	{ label: 'import ... from "node:*"', pattern: /from\s+["']node:/ },
	{ label: "require(...)", pattern: /\brequire\s*\(/ },
];

const FORBIDDEN_GLOBALS: { label: string; pattern: RegExp }[] = [
	{ label: "document", pattern: /\bdocument\./ },
	{ label: "window", pattern: /\bwindow\./ },
	{ label: "localStorage", pattern: /\blocalStorage\b/ },
	{ label: "sessionStorage", pattern: /\bsessionStorage\b/ },
	{ label: "fetch(", pattern: /\bfetch\s*\(/ },
	{ label: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/ },
	{ label: "WebSocket", pattern: /\bWebSocket\b/ },
	{ label: "setTimeout(", pattern: /\bsetTimeout\s*\(/ },
	{ label: "setInterval(", pattern: /\bsetInterval\s*\(/ },
	{ label: "Date.now()", pattern: /\bDate\.now\s*\(/ },
	{ label: "new Date(", pattern: /\bnew\s+Date\s*\(/ },
	{ label: "performance.now()", pattern: /\bperformance\.now\s*\(/ },
];

describe("purity (F1/F8): src/similarity.ts and src/matcher.ts have no I/O or timers", () => {
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

	it("src/matcher.ts imports similarity only from ./similarity and the Anchor type only from ./anchors", () => {
		const matches = sources[1].text.match(/^import[^;]+;/gm) ?? [];
		for (const line of matches) {
			expect(line).toMatch(/from\s+["']\.\/(similarity|anchors)["']/);
		}
	});

	it("src/similarity.ts has no import statements at all (it needs nothing but the language itself)", () => {
		const matches = sources[0].text.match(/^import[^;]+;/gm) ?? [];
		expect(matches).toEqual([]);
	});
});

describe("F6: no export, option or result field anywhere refers to a moved block", () => {
	const movePattern = /\bmove[ds]?\b/i;

	it("src/matcher.ts's exported names don't mention moves", () => {
		for (const name of Object.keys(matcherModule)) {
			expect(name).not.toMatch(movePattern);
		}
	});

	it("MatcherOptions' and MatchResult's own field/reason names don't mention moves (source scan)", () => {
		// Field names live only in the type declarations, not at runtime, so this is a source
		// scan of the interface/type bodies rather than an Object.keys check.
		const typeSection = sources[1].code.match(/export (?:interface|type) [\s\S]*?\n}/g)?.join("\n") ?? "";
		expect(typeSection.length).toBeGreaterThan(0);
		expect(typeSection).not.toMatch(movePattern);
	});

	it("neither file's source text (code, not comments) mentions a moved-block concept", () => {
		for (const { code } of sources) {
			expect(code).not.toMatch(movePattern);
		}
	});
});

describe("R13 (PR-4): exports and option/reason names are pinned by snapshot", () => {
	// A new export, option field or reason name must show up as a snapshot diff someone reviews,
	// not pass silently through the /move/ regex above.
	const typeSource = sources[1].code;

	function interfaceFields(name: string): string[] {
		const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(typeSource)?.[1] ?? "";
		return [...body.matchAll(/^\t(\w+)\??:/gm)].map((m) => m[1]).sort();
	}

	function stringUnion(name: string): string[] {
		const decl = new RegExp(`export type ${name} =([^;]+);`).exec(typeSource)?.[1] ?? "";
		return [...decl.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
	}

	it("src/matcher.ts runtime exports", () => {
		expect(Object.keys(matcherModule).sort()).toMatchInlineSnapshot(`
			[
			  "CHUNK_SIZE",
			  "FUZZY_THRESHOLD_LONG",
			  "FUZZY_THRESHOLD_SHORT",
			  "MAX_COMPARISONS",
			  "MAX_FOLDS",
			  "POSITIONAL_THRESHOLD",
			  "SHORT_LONG_SPLIT",
			  "matchAnchors",
			]
		`);
	});

	it("src/similarity.ts runtime exports", () => {
		expect(Object.keys(similarityModule).sort()).toMatchInlineSnapshot(`
			[
			  "similarity",
			]
		`);
	});

	it("MatcherOptions field names", () => {
		expect(interfaceFields("MatcherOptions")).toMatchInlineSnapshot(`
			[
			  "chunkSize",
			  "fuzzyThresholdLong",
			  "fuzzyThresholdShort",
			  "maxComparisons",
			  "maxFolds",
			  "positionalThreshold",
			  "shortLongSplit",
			  "yieldToHost",
			]
		`);
	});

	it("MatchTier and NoMatchReason members", () => {
		expect({ tiers: stringUnion("MatchTier"), reasons: stringUnion("NoMatchReason") }).toMatchInlineSnapshot(`
			{
			  "reasons": [
			    "ambiguous",
			    "below-threshold",
			    "capped",
			    "no-candidate",
			  ],
			  "tiers": [
			    "exact",
			    "fuzzy",
			    "positional",
			  ],
			}
		`);
	});
});

describe("src/main.ts does not import the matcher yet (wiring it in is PR-5's job)", () => {
	it("has no import of ./matcher or ./similarity", () => {
		const mainText = readFileSync(MAIN_FILE, "utf8");
		expect(mainText).not.toMatch(/from\s+["']\.\/matcher["']/);
		expect(mainText).not.toMatch(/from\s+["']\.\/similarity["']/);
	});
});

describe("exports sanity: both modules actually export something", () => {
	it("src/similarity.ts exports similarity", () => {
		expect(typeof similarityModule.similarity).toBe("function");
	});

	it("src/matcher.ts exports matchAnchors and its named constants", () => {
		expect(typeof matcherModule.matchAnchors).toBe("function");
		expect(Object.keys(matcherModule).length).toBeGreaterThan(1);
	});
});
