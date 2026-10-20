/**
 * src/normalize.ts: G5 (checkbox status is ignored) and the settled normalization rules.
 */
import { describe, expect, it } from "vitest";
import { indentColumns, normalizeText } from "../../src/normalize";

describe("normalizeText: G5 — checkbox status is ignored", () => {
	const statuses = [" ", "x", "X", "/", "-", ">", "!", "?", "~"];

	it.each(statuses)("`- [%s] Draft proposal` normalizes the same as `- [ ] Draft proposal`", (status) => {
		expect(normalizeText(`- [${status}] Draft proposal`)).toBe(normalizeText("- [ ] Draft proposal"));
	});

	it("all nine statuses collapse to one identical string", () => {
		const results = new Set(statuses.map((s) => normalizeText(`- [${s}] Draft proposal`)));
		expect(results.size).toBe(1);
		expect([...results][0]).toBe("draft proposal");
	});

	it("works for every list marker, not just `-`", () => {
		expect(normalizeText("* [x] Draft proposal")).toBe("draft proposal");
		expect(normalizeText("+ [x] Draft proposal")).toBe("draft proposal");
		expect(normalizeText("1. [x] Draft proposal")).toBe("draft proposal");
		expect(normalizeText("1) [x] Draft proposal")).toBe("draft proposal");
	});

	it("a bare `- [ ]` with nothing after it normalizes to an empty string, not an error", () => {
		expect(() => normalizeText("- [ ]")).not.toThrow();
		expect(normalizeText("- [ ]")).toBe("");
	});
});

describe("normalizeText: only the leading marker is dropped", () => {
	it("`[x]` later in the line survives", () => {
		expect(normalizeText("- today I did [x] already")).toBe("today i did [x] already");
	});

	it("`[[wikilinks]]` survive intact, including when immediately after the list marker", () => {
		expect(normalizeText("- [[Project Plan]] kickoff")).toBe("[[project plan]] kickoff");
	});

	it("`[text](url)` markdown links survive intact, including immediately after the list marker", () => {
		expect(normalizeText("- [docs](https://example.com) reference")).toBe("[docs](https://example.com) reference");
	});

	it("`[x] foo` with no list marker in front is not read as a status", () => {
		expect(normalizeText("[x] foo")).toBe("[x] foo");
	});

	it("heading hashes are the only thing dropped from a heading line", () => {
		expect(normalizeText("## [[Tuesday]] plan")).toBe("[[tuesday]] plan");
	});
});

describe("normalizeText: table-driven rule coverage (one row per rule, plus a combined row)", () => {
	const rows: { label: string; input: string; expected: string }[] = [
		{ label: "drops a `-` list marker", input: "- hello", expected: "hello" },
		{ label: "drops a `*` list marker", input: "* hello", expected: "hello" },
		{ label: "drops a `+` list marker", input: "+ hello", expected: "hello" },
		{ label: "drops a `1.` ordered marker", input: "1. hello", expected: "hello" },
		{ label: "drops a `1)` ordered marker", input: "1) hello", expected: "hello" },
		{ label: "drops a checkbox marker after a list marker", input: "- [x] hello", expected: "hello" },
		{ label: "drops heading hashes", input: "### hello", expected: "hello" },
		{ label: "strips `**bold**`", input: "**hello**", expected: "hello" },
		{ label: "strips `__bold__`", input: "__hello__", expected: "hello" },
		{ label: "strips `*italic*`", input: "*hello*", expected: "hello" },
		{ label: "strips `_italic_` but keeps snake_case", input: "_hello_ snake_case", expected: "hello snake_case" },
		{ label: "strips `~~strike~~`", input: "~~hello~~", expected: "hello" },
		{ label: "strips `==highlight==`", input: "==hello==", expected: "hello" },
		{ label: "ignores case", input: "HeLLo", expected: "hello" },
		{ label: "collapses whitespace runs", input: "hello    world", expected: "hello world" },
		{ label: "trims leading/trailing whitespace", input: "   hello   ", expected: "hello" },
		{ label: "applies Unicode NFC", input: "cafe\u0301", expected: "caf\u00e9" },
		{
			label: "combined: marker + checkbox + emphasis + case + whitespace + snake_case",
			input: "-   [X]   **HELLO**   _world_  snake_case  ",
			expected: "hello world snake_case",
		},
	];

	it.each(rows)("$label", ({ input, expected }) => {
		expect(normalizeText(input)).toBe(expected);
	});
});

describe("normalizeText: Unicode", () => {
	it("accented characters normalize consistently regardless of composed/decomposed form", () => {
		const composed = "r\u00e9sum\u00e9"; // résumé (composed é)
		const decomposed = "re\u0301sume\u0301"; // résumé (combining acute accent)
		expect(normalizeText(composed)).toBe(normalizeText(decomposed));
	});

	it("CJK text normalizes without throwing and preserves the characters", () => {
		expect(normalizeText("- \u4f1a\u8bae\u8bb0\u5f55")).toBe("\u4f1a\u8bae\u8bb0\u5f55");
	});

	it("emoji and combining marks pass through without throwing", () => {
		expect(() => normalizeText("- party \ud83c\udf89 time")).not.toThrow();
		expect(normalizeText("- party \ud83c\udf89 time")).toBe("party \ud83c\udf89 time");
	});
});

describe("normalizeText: empty / whitespace-only input", () => {
	it("empty string normalizes to empty string, no throw", () => {
		expect(() => normalizeText("")).not.toThrow();
		expect(normalizeText("")).toBe("");
	});

	it("whitespace-only input normalizes to empty string", () => {
		expect(normalizeText("    ")).toBe("");
		expect(normalizeText("\t\t")).toBe("");
	});
});

describe("normalizeText: purity", () => {
	it("never mutates its input and gives identical output on repeated calls", () => {
		const input = "- [x] **Draft proposal**";
		const frozen = Object.freeze({ input });
		const first = normalizeText(frozen.input);
		const second = normalizeText(frozen.input);
		expect(frozen.input).toBe(input);
		expect(first).toBe(second);
		expect(first).toBe("draft proposal");
	});
});

describe("indentColumns: a tab counts as 4 columns", () => {
	it("no leading whitespace is indent 0", () => {
		expect(indentColumns("- a")).toBe(0);
	});

	it("4 leading spaces is indent 4", () => {
		expect(indentColumns("    - a")).toBe(4);
	});

	it("1 leading tab is indent 4", () => {
		expect(indentColumns("\t- a")).toBe(4);
	});

	it("2 leading tabs is indent 8", () => {
		expect(indentColumns("\t\t- b")).toBe(8);
	});

	it("mixed tabs and spaces accumulate", () => {
		expect(indentColumns("\t  - a")).toBe(6);
	});

	it("an all-whitespace line counts to the end of the line", () => {
		expect(indentColumns("\t\t")).toBe(8);
	});
});
