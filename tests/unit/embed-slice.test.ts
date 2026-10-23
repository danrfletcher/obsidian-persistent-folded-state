/**
 * src/embed-slice.ts: the slice rule per embed kind, null versus empty, hash stability, line
 * endings, cost, and the anchor property (ticket warkworth-21 PR-3: G12, GP1, E1).
 */
import { describe, expect, it } from "vitest";
import { sliceEmbed } from "../../src/embed-slice";
import { buildAnchors } from "../../src/anchors";
import { hashText } from "../../src/fold-store";

function text(subpath: string, target: string): string | null {
	return sliceEmbed(target, subpath)?.text ?? null;
}

describe("block slice", () => {
	const cases: { name: string; target: string; subpath: string; expected: string }[] = [
		{
			name: "id on a list item covers the item and every deeper child",
			target: "- Lesson 7\n- Lesson 8 ^abc\n  - [ ] a\n    - [ ] b\n  - [ ] c\n- Lesson 9\n  - [ ] d",
			subpath: "^abc",
			expected: "- Lesson 8 ^abc\n  - [ ] a\n    - [ ] b\n  - [ ] c",
		},
		{
			name: "children indented with tabs (tab = 4 columns)",
			target: "- Lesson 8 ^abc\n\t- [ ] a\n\t\t- [ ] b\n- next",
			subpath: "^abc",
			expected: "- Lesson 8 ^abc\n\t- [ ] a\n\t\t- [ ] b",
		},
		{
			name: "a tab child under a four-space item is a child (tab = 4)",
			target: "    - item ^abc\n\t\t- deeper\n\t- same level\n- out",
			subpath: "^abc",
			expected: "- item ^abc\n\t- deeper",
		},
		{
			name: "a nested item is dedented so its first line has indent 0",
			target: "- parent\n  - child ^abc\n    - grandchild\n  - sibling",
			subpath: "^abc",
			expected: "- child ^abc\n  - grandchild",
		},
		{
			name: "blank lines inside the children stay, trailing blanks go",
			target: "- item ^abc\n  - a\n\n  - b\n\n- next",
			subpath: "^abc",
			expected: "- item ^abc\n  - a\n\n  - b",
		},
		{
			name: "id on a list item inside a callout covers its children, shown without the markers",
			target: "> [!note]\n> - item ^abc\n>   - child\n>     - grandchild\n> - sibling\n\nafter",
			subpath: "^abc",
			expected: "- item ^abc\n  - child\n    - grandchild",
		},
		{
			name: "a callout list item's children end where the callout ends",
			target: "> - item ^abc\n>   - child\n  - not quoted\n> - other",
			subpath: "^abc",
			expected: "- item ^abc\n  - child",
		},
		{
			name: "a list item in a blockquote with a blank quoted line between children",
			target: "> - item ^abc\n>   - a\n>\n>   - b\n>\n> - next",
			subpath: "^abc",
			expected: "- item ^abc\n  - a\n\n  - b",
		},
		{
			name: "a nested callout list item",
			target: "> > - item ^abc\n> >   - child\n> > - next",
			subpath: "^abc",
			expected: "- item ^abc\n  - child",
		},
		{
			name: "an id inside a fence in a callout does not count",
			target: "> ```\n> fake ^abc\n> ```\n\nreal ^abc",
			subpath: "^abc",
			expected: "real ^abc",
		},
		{
			name: "a quoted fence line inside an ordinary code block does not close it",
			target: "```\n> ```\nfake ^abc\n```\n\nreal ^abc",
			subpath: "^abc",
			expected: "real ^abc",
		},
		{
			name: "ordered list item",
			target: "1. one ^abc\n   - child\n2. two",
			subpath: "^abc",
			expected: "1. one ^abc\n   - child",
		},
		{
			name: "id on a paragraph covers the paragraph",
			target: "before\n\nfirst line\nsecond line ^abc\n\nafter",
			subpath: "^abc",
			expected: "first line\nsecond line ^abc",
		},
		{
			name: "a single-line paragraph",
			target: "before\n\nonly line ^abc\nnext line",
			subpath: "^abc",
			expected: "only line ^abc",
		},
		{
			name: "a paragraph directly under a heading stops at the heading",
			target: "# Title\nbody ^abc",
			subpath: "^abc",
			expected: "body ^abc",
		},
		{
			name: "id on a heading line covers the heading line",
			target: "## Part ^abc\nbody",
			subpath: "^abc",
			expected: "## Part ^abc",
		},
		{
			name: "an id alone on the line after a paragraph refers to that paragraph",
			target: "intro\n\nthe block\nover two lines\n\n^abc\n\nafter",
			subpath: "^abc",
			expected: "the block\nover two lines",
		},
		{
			name: "an id alone directly under the block",
			target: "the block\n^abc",
			subpath: "^abc",
			expected: "the block",
		},
		{
			name: "an id alone after a list refers to the list",
			target: "text\n\n- a\n  - b\n- c\n\n^abc\n",
			subpath: "^abc",
			expected: "- a\n  - b\n- c",
		},
		{
			name: "an id alone after a code block refers to the whole block",
			target: "x\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\n^abc",
			subpath: "^abc",
			expected: "```js\nconst a = 1;\n\nconst b = 2;\n```",
		},
		{
			name: "ids match case-insensitively and the first match wins",
			target: "first ^ABC\n\nsecond ^abc",
			subpath: "^abc",
			expected: "first ^ABC",
		},
		{
			name: "ids with hyphens",
			target: "item ^a-b-1",
			subpath: "^a-b-1",
			expected: "item ^a-b-1",
		},
		{
			name: "a caret inside the line is not an id",
			target: "a ^abc b\n\nreal ^abc",
			subpath: "^abc",
			expected: "real ^abc",
		},
		{
			name: "an id inside a fenced code block does not count",
			target: "```\nfake ^abc\n```\n\nreal ^abc",
			subpath: "^abc",
			expected: "real ^abc",
		},
		{
			name: "an id inside frontmatter does not count",
			target: "---\nkey: value ^abc\n---\nreal ^abc",
			subpath: "^abc",
			expected: "real ^abc",
		},
	];

	it.each(cases)("$name", ({ target, subpath, expected }) => {
		expect(text(subpath, target)).toBe(expected);
	});

	it("GP1: Lesson 8 with its sub-tasks, ending before the next sibling lesson", () => {
		const target = [
			"# Competitive Coding Fundamentals",
			"",
			"- Lesson 7: Recursion",
			"  - [x] Watch [[Recursion video|the video]] (12:30)",
			"- Lesson 8: Collections and frequency counting ^0169a6",
			"  - [x] Watch [[Collections video|video]] (14:02)",
			"  - [x] Do the [[Frequency exercises#Set A|exercises]] — done 2026-09-30 09:15",
			"  - [ ] Review the sub-tasks",
			"- Lesson 9: Sorting",
			"  - [ ] Merge sort",
		].join("\n");
		const slice = sliceEmbed(target, "^0169a6");
		const lines = (slice?.text ?? "").split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toBe("- Lesson 8: Collections and frequency counting ^0169a6");
		expect(lines[3]).toBe("  - [ ] Review the sub-tasks");
	});
});

describe("heading slice", () => {
	const target = [
		"# Title",
		"intro",
		"## Alpha",
		"alpha body",
		"### Alpha deeper",
		"deeper body",
		"## Beta",
		"beta body",
		"### Beta deeper",
		"# Other",
		"other body",
		"## Alpha",
		"second alpha",
	].join("\n");

	const cases: { name: string; subpath: string; expected: string }[] = [
		{
			name: "runs to the next heading of the same level; a deeper heading stays inside",
			subpath: "Alpha",
			expected: "## Alpha\nalpha body\n### Alpha deeper\ndeeper body",
		},
		{ name: "runs to the next heading of a higher level", subpath: "Beta deeper", expected: "### Beta deeper" },
		{ name: "the last section runs to the end of the note", subpath: "Other", expected: "# Other\nother body\n## Alpha\nsecond alpha" },
		{ name: "a top heading holds everything until the next top heading", subpath: "Title", expected: target.split("\n").slice(0, 9).join("\n") },
		{ name: "nested subpath A#B resolves B under A", subpath: "Other#Alpha", expected: "## Alpha\nsecond alpha" },
		{ name: "nested subpath skips a same-named heading outside A", subpath: "Title#Alpha", expected: "## Alpha\nalpha body\n### Alpha deeper\ndeeper body" },
		{ name: "the heading text is compared after normalizeText (case, emphasis)", subpath: "ALPHA", expected: "## Alpha\nalpha body\n### Alpha deeper\ndeeper body" },
	];

	it.each(cases)("$name", ({ subpath, expected }) => {
		expect(text(subpath, target)).toBe(expected);
	});

	it("matches a heading written with emphasis markup", () => {
		expect(text("Plain words", "## **Plain** _words_\nbody\n## next")).toBe("## **Plain** _words_\nbody");
	});

	it("a heading whose text starts like a list marker still matches", () => {
		expect(text("1. Intro", "## 1. Intro\nbody\n## 2. Next")).toBe("## 1. Intro\nbody");
	});

	it("# lines inside a code fence are not headings", () => {
		const note = "## Real\ntext\n```bash\n# comment\n## also comment\n```\nmore\n## Next";
		expect(text("Real", note)).toBe("## Real\ntext\n```bash\n# comment\n## also comment\n```\nmore");
		expect(text("comment", note)).toBeNull();
	});

	it("a quoted fence line inside an ordinary code block does not close it", () => {
		expect(text("H", "```\n> ```\n# H\n```\n# H\nbody")).toBe("# H\nbody");
	});

	it("a callout fence still hides its # lines and ends with the callout", () => {
		expect(text("H", "> ```\n> # H\n> ```\n# H\nbody")).toBe("# H\nbody");
	});

	it("# lines in frontmatter are not headings", () => {
		expect(text("not a heading", "---\n# not a heading\n---\n## Real\nbody")).toBeNull();
	});

	it("an indented heading is dedented", () => {
		expect(text("Part", "  ## Part\n  body\n## Next")).toBe("## Part\nbody");
	});

	it("a hashtag or a # with no space is not a heading", () => {
		expect(text("tag", "#tag\n## Real")).toBeNull();
	});
});

describe("whole-note slice", () => {
	it("is the body without frontmatter", () => {
		expect(text("", "---\ntitle: x\ntags: [a]\n---\n# Title\n\n- item")).toBe("# Title\n\n- item");
	});

	it("is the whole text when there is no frontmatter", () => {
		expect(text("", "# Title\nbody")).toBe("# Title\nbody");
	});

	it("frontmatter closed by ... also ends", () => {
		expect(text("", "---\nk: v\n...\nbody")).toBe("body");
	});

	it("an unclosed --- is not frontmatter (same rule as anchors)", () => {
		expect(text("", "---\nk: v\nbody")).toBe("---\nk: v\nbody");
	});

	it("a --- that is not on the first line is not frontmatter", () => {
		expect(text("", "intro\n---\nk: v\n---\nbody")).toBe("intro\n---\nk: v\n---\nbody");
	});

	it("a frontmatter-only note gives the empty string, not null", () => {
		expect(sliceEmbed("---\nk: v\n---\n", "")?.text).toBe("");
		expect(sliceEmbed("---\nk: v\n---", "")?.text).toBe("");
		expect(sliceEmbed("---\nk: v\n---\n", "")?.hash).toBe(hashText(""));
	});

	it("a note of only blank lines gives the empty string", () => {
		expect(text("", "\n\n")).toBe("");
	});

	it("the first body line keeps its indent when it is the whole note", () => {
		expect(text("", "---\nk: v\n---\n  indented first")).toBe("indented first");
	});
});

describe("null versus empty", () => {
	const cases: { name: string; target: string; subpath: string }[] = [
		{ name: "missing block id", target: "item ^abc", subpath: "^zzz" },
		{ name: "missing heading", target: "# Real", subpath: "Missing" },
		{ name: "missing nested heading", target: "# A\n## B", subpath: "A#Missing" },
		{ name: "nested heading that exists only outside the parent", target: "# A\n# B\n## C", subpath: "A#C" },
		{ name: "empty target text, whole note", target: "", subpath: "" },
		{ name: "empty target text, block", target: "", subpath: "^abc" },
		{ name: "empty target text, heading", target: "", subpath: "Heading" },
		{ name: "empty block id", target: "item ^abc", subpath: "^" },
		{ name: "block id with bad characters", target: "item ^abc", subpath: "^a b" },
		{ name: "blank subpath", target: "# Real", subpath: "   " },
		{ name: "bare #", target: "# Real", subpath: "#" },
		{ name: "empty segment in a nested path", target: "# A\n## B", subpath: "A##B" },
		{ name: "block id alone on the first line with nothing above", target: "^abc\nafter", subpath: "^abc" },
		{ name: "a block id that exists only in frontmatter", target: "---\nk: ^abc\n---\nbody", subpath: "^abc" },
	];

	it.each(cases)("$name returns null", ({ target, subpath }) => {
		expect(sliceEmbed(target, subpath)).toBeNull();
	});

	it("does not throw on non-string input", () => {
		expect(sliceEmbed(undefined as unknown as string, "")).toBeNull();
		expect(sliceEmbed("x", null as unknown as string)).toBeNull();
	});
});

describe("hash", () => {
	const target = "# Top\n\n- a\n- Lesson 8 ^abc\n  - [ ] x\n  - [ ] y\n- b\n\n## Next\nbody";

	it("is hashText of the slice text", () => {
		const slice = sliceEmbed(target, "^abc");
		expect(slice?.hash).toBe(hashText(slice?.text ?? ""));
		expect(slice?.hash).toBe(hashText("- Lesson 8 ^abc\n  - [ ] x\n  - [ ] y"));
	});

	it("is unchanged by edits elsewhere in the target", () => {
		const before = sliceEmbed(target, "^abc");
		for (const edited of [
			`new first line\n${target}`,
			target.replace("- a\n", "- a changed\n- inserted\n"),
			target.replace("- b\n", "- b changed\n"),
			`${target}\nmore at the end\n`,
			target.replace("body", "different body"),
		]) {
			expect(sliceEmbed(edited, "^abc")).toEqual(before);
		}
	});

	it("changes when a line inside the slice changes", () => {
		const before = sliceEmbed(target, "^abc");
		for (const edited of [
			target.replace("[ ] x", "[ ] x edited"),
			target.replace("  - [ ] y", "  - [ ] y\n  - [ ] z"),
			target.replace("Lesson 8", "Lesson 8 (revised)"),
		]) {
			const after = sliceEmbed(edited, "^abc");
			expect(after?.hash).not.toBe(before?.hash);
		}
	});

	it("heading and whole-note hashes follow the same rule", () => {
		const heading = sliceEmbed(target, "Next");
		expect(sliceEmbed(target.replace("- a\n", "- zzz\n"), "Next")).toEqual(heading);
		expect(sliceEmbed(target.replace("body", "other"), "Next")?.hash).not.toBe(heading?.hash);
		expect(sliceEmbed(target, "")?.hash).not.toBe(sliceEmbed(target.replace("body", "other"), "")?.hash);
	});
});

describe("line endings and whitespace at the edges", () => {
	const lf = "# H\n\n- Lesson ^abc\n  - [ ] a\n- next\n\n## Two\nbody\n";
	const variants: [string, string][] = [
		["CRLF", lf.replace(/\n/g, "\r\n")],
		["bare CR", lf.replace(/\n/g, "\r")],
		["no trailing newline", lf.slice(0, -1)],
		["extra trailing blank lines", `${lf}\n\n`],
	];

	it.each(variants)("%s gives the same slices and hashes as LF", (_name, variant) => {
		for (const subpath of ["^abc", "H", "Two", "H#Two", ""]) {
			const expected = sliceEmbed(lf, subpath);
			expect(expected).not.toBeNull();
			expect(sliceEmbed(variant, subpath)).toEqual(expected);
		}
	});

	it("slice text never contains a carriage return", () => {
		expect(sliceEmbed("- a ^x\r\n  - b\r\n", "^x")?.text).toBe("- a ^x\n  - b");
	});

	it("unicode, emoji and CJK survive unchanged", () => {
		expect(text("見出し 🚀", "## 見出し 🚀\n内容 ☕\n## 次")).toBe("## 見出し 🚀\n内容 ☕");
		expect(text("^a1", "- 日本語 🚀 ^a1\n  - [ ] ☕")).toBe("- 日本語 🚀 ^a1\n  - [ ] ☕");
	});
});

describe("cost: one pass over the lines", () => {
	const big = (): string => {
		const lines: string[] = ["---", "k: v", "---"];
		for (let i = 0; i < 1250; i++) {
			lines.push(`## Section ${i}`, `- item ${i} ^id${i}`, `  - [ ] child ${i}`, "paragraph text");
		}
		return lines.join("\n");
	};

	it("a 5,000-line target is sliced quickly for every kind", () => {
		const target = big();
		expect(target.split("\n").length).toBeGreaterThanOrEqual(5000);
		const start = performance.now();
		expect(sliceEmbed(target, "^id1249")).not.toBeNull();
		expect(sliceEmbed(target, "Section 1249")).not.toBeNull();
		expect(sliceEmbed(target, "Section 100#Nothing")).toBeNull();
		expect(sliceEmbed(target, "")).not.toBeNull();
		expect(performance.now() - start).toBeLessThan(250);
	});

	it("the work grows with the target, not with the square of it", () => {
		const small = ["- x ^end"].concat(Array.from({ length: 20_000 }, (_, i) => `line ${i}`)).join("\n");
		const large = ["- x ^end"].concat(Array.from({ length: 80_000 }, (_, i) => `line ${i}`)).join("\n");
		const time = (t: string): number => {
			const start = performance.now();
			sliceEmbed(t, "Missing heading");
			return performance.now() - start;
		};
		const a = Math.max(Math.min(time(small), time(small), time(small)), 1);
		const b = Math.min(time(large), time(large), time(large));
		// 4x the lines: a repeated rescan per line would be ~16x; allow generous noise.
		expect(b / a).toBeLessThan(12);
		expect(b).toBeLessThan(500);
	});

	it("a wide list of many siblings under one block does not slow the slice", () => {
		const lines = ["- parent ^p"];
		for (let i = 0; i < 20_000; i++) lines.push(`  - child ${i}`);
		const start = performance.now();
		const slice = sliceEmbed(lines.join("\n"), "^p");
		expect(slice?.text.split("\n")).toHaveLength(20_001);
		expect(performance.now() - start).toBeLessThan(500);
	});
});

describe("anchors over a block slice (E1)", () => {
	const block = "- Lesson 8 ^abc\n  - [ ] Count words\n  - [ ] Count words\n  - [ ] Group anagrams";
	const base = `# Course\n\n- Lesson 7\n${block}\n- Lesson 9`;

	it("identical task lines inside one slice stay distinguishable through sibling indexes", () => {
		const slice = sliceEmbed(base, "^abc");
		const anchors = buildAnchors(slice?.text ?? "").map((b) => b.anchor);
		const counts = anchors.filter((a) => a.text === "count words");
		expect(counts.map((a) => a.siblingIndex)).toEqual([0, 1]);
	});

	it("buildAnchors over the slice gives the same anchors after other lines are added above", () => {
		const reference = buildAnchors(sliceEmbed(base, "^abc")?.text ?? "").map((b) => b.anchor);
		expect(reference.length).toBeGreaterThan(0);
		for (const edited of [
			`new top line\n\n${base}`,
			base.replace("- Lesson 7\n", "- Lesson 7\n- Lesson 7b\n  - [ ] sub\n"),
			base.replace("# Course", "---\nk: v\n---\n# Course\n\n## Added\n\n- added item"),
			base.replace(/\n/g, "\r\n"),
		]) {
			const anchors = buildAnchors(sliceEmbed(edited, "^abc")?.text ?? "").map((b) => b.anchor);
			expect(anchors).toEqual(reference);
		}
	});

	it("a nested block gives anchors independent of its depth in the target", () => {
		const nested = "- outer\n  - Lesson 8 ^abc\n    - [ ] Count words\n    - [ ] Count words";
		const flat = "- Lesson 8 ^abc\n  - [ ] Count words\n  - [ ] Count words";
		const a = buildAnchors(sliceEmbed(nested, "^abc")?.text ?? "").map((b) => b.anchor);
		const b = buildAnchors(sliceEmbed(flat, "^abc")?.text ?? "").map((x) => x.anchor);
		expect(a).toEqual(b);
	});
});

describe("determinism: same input, same output, input untouched", () => {
	const target = "---\nk: v\n---\n# H\n- a ^x\n  - b\n## Two\ntext ^y";
	const subpaths = ["", "^x", "^y", "H", "H#Two", "^missing", "Missing"];

	it.each(subpaths)("subpath %j gives deeply equal output on a second call", (subpath) => {
		expect(sliceEmbed(target, subpath)).toEqual(sliceEmbed(target, subpath));
	});

	it("is a pure function of its two string arguments (strings cannot be mutated)", () => {
		const frozen = Object.freeze({ target, subpath: "^x" });
		const first = sliceEmbed(frozen.target, frozen.subpath);
		expect(sliceEmbed(frozen.target, frozen.subpath)).toEqual(first);
		expect(frozen.target).toBe(target);
	});

	it("returns a fresh object each call, so callers cannot corrupt a shared result", () => {
		const first = sliceEmbed(target, "^x");
		const second = sliceEmbed(target, "^x");
		expect(first).not.toBe(second);
		if (first !== null) first.text = "changed";
		expect(sliceEmbed(target, "^x")?.text).toBe("- a ^x\n  - b");
	});
});
