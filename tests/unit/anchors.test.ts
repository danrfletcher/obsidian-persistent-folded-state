/**
 * src/anchors.ts: anchor structure (kinds, indent, sibling index, parent chain), E13
 * (frontmatter/code/other-range anchors), the fence regression checks that belong with this
 * module's exports, and the edge cases listed in the PR-3 brief.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anchorKey, buildAnchors, parseAnchor, type Anchor, type AnchoredBlock } from "../../src/anchors";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function findOne(blocks: AnchoredBlock[], predicate: (b: AnchoredBlock) => boolean): AnchoredBlock {
	const matches = blocks.filter(predicate);
	expect(matches).toHaveLength(1);
	return matches[0];
}

describe("buildAnchors: kinds", () => {
	it("classifies every documented kind from one note", () => {
		const text = [
			"---",
			"k: v",
			"---",
			"# Heading",
			"- list item",
			"- [ ] task item",
			"> quote line",
			"",
			"> [!note] callout title",
			"```ts",
			"code",
			"```",
			"plain paragraph text",
		].join("\n");

		const blocks = buildAnchors(text);
		const kinds = blocks.map((b) => b.anchor.kind).sort();
		expect(new Set(kinds)).toEqual(
			new Set(["frontmatter", "heading", "list", "task", "blockquote", "callout", "code", "other"]),
		);
	});

	it("a plain bullet `- foo` is kind list and is not equal (by key) to `- [ ] foo`", () => {
		const bullets = buildAnchors("- foo");
		const tasks = buildAnchors("- [ ] foo");
		expect(bullets[0].anchor.kind).toBe("list");
		expect(tasks[0].anchor.kind).toBe("task");
		expect(bullets[0].anchor.text).toBe(tasks[0].anchor.text); // same normalized text ("foo")
		expect(anchorKey(bullets[0].anchor)).not.toBe(anchorKey(tasks[0].anchor)); // but different key
	});

	it("a task stays kind task across every status", () => {
		for (const status of [" ", "x", "X", "/", "-", ">", "!", "?", "~"]) {
			const blocks = buildAnchors(`- [${status}] foo`);
			expect(blocks[0].anchor.kind).toBe("task");
		}
	});
});

describe("buildAnchors: G5 — status changes don't move other anchors", () => {
	const before = [
		"- [ ] Draft proposal",
		"\t- [ ] Outline",
		"\t- [ ] Draft",
		"\t- [ ] Review",
		"- [ ] Send invoices",
	].join("\n");
	const after = [
		"- [x] Draft proposal",
		"\t- [x] Outline",
		"\t- [ ] Draft",
		"\t- [ ] Review",
		"- [ ] Send invoices",
	].join("\n");

	it("the changed task's anchor (kind, indent, text, siblingIndex, parentChain) is deep-equal across the status change", () => {
		const beforeBlocks = buildAnchors(before);
		const afterBlocks = buildAnchors(after);
		const beforeDraft = findOne(beforeBlocks, (b) => b.anchor.text === "draft proposal");
		const afterDraft = findOne(afterBlocks, (b) => b.anchor.text === "draft proposal");
		expect(afterDraft.anchor).toEqual(beforeDraft.anchor);
		expect(anchorKey(afterDraft.anchor)).toBe(anchorKey(beforeDraft.anchor));
	});

	it("every other block's anchor is unchanged, including siblings after the changed task", () => {
		const beforeBlocks = buildAnchors(before);
		const afterBlocks = buildAnchors(after);
		const beforeSendInvoices = findOne(beforeBlocks, (b) => b.anchor.text === "send invoices");
		const afterSendInvoices = findOne(afterBlocks, (b) => b.anchor.text === "send invoices");
		expect(afterSendInvoices.anchor).toEqual(beforeSendInvoices.anchor);

		const beforeDraftChild = findOne(beforeBlocks, (b) => b.anchor.text === "draft" && b.anchor.indent === 4);
		const afterDraftChild = findOne(afterBlocks, (b) => b.anchor.text === "draft" && b.anchor.indent === 4);
		expect(afterDraftChild.anchor).toEqual(beforeDraftChild.anchor);
	});
});

describe("buildAnchors: E13 — frontmatter", () => {
	it("a note starting with a closed --- block yields exactly one frontmatter anchor, fixed text, siblingIndex 0", () => {
		const text = ["---", "title: Note", "tags: [a, b]", "---", "# Heading"].join("\n");
		const blocks = buildAnchors(text);
		const frontmatterBlocks = blocks.filter((b) => b.anchor.kind === "frontmatter");
		expect(frontmatterBlocks).toHaveLength(1);
		expect(frontmatterBlocks[0].anchor.siblingIndex).toBe(0);
		expect(frontmatterBlocks[0].anchor.text).toBe("frontmatter");
		expect(frontmatterBlocks[0].range).toEqual({ startLine: 1, endLine: 4 });
	});

	it("editing a key or value inside frontmatter does not change the frontmatter anchor", () => {
		const original = ["---", "title: Note", "---", "# Heading"].join("\n");
		const edited = ["---", "title: A Completely Different Note", "owner: dan", "---", "# Heading"].join("\n");
		const a = buildAnchors(original).find((b) => b.anchor.kind === "frontmatter");
		const b = buildAnchors(edited).find((b) => b.anchor.kind === "frontmatter");
		expect(a?.anchor).toEqual(b?.anchor);
	});

	it("frontmatter body lines never produce their own anchors, even if they look like headings or tasks", () => {
		const text = ["---", "# not a heading", "- [ ] not a task", "---", "# Real Heading"].join("\n");
		const blocks = buildAnchors(text);
		expect(blocks.filter((b) => b.anchor.kind === "frontmatter")).toHaveLength(1);
		expect(blocks.filter((b) => b.anchor.kind === "heading")).toHaveLength(1);
		expect(blocks.filter((b) => b.anchor.kind === "task")).toHaveLength(0);
	});

	it("--- not on line 1 is not frontmatter and yields no frontmatter anchor", () => {
		const text = ["", "---", "title: Note", "---"].join("\n");
		const blocks = buildAnchors(text);
		expect(blocks.filter((b) => b.anchor.kind === "frontmatter")).toHaveLength(0);
	});

	it("--- with no closing delimiter is not frontmatter and yields no frontmatter anchor", () => {
		const text = ["---", "title: Note", "# Heading"].join("\n");
		const blocks = buildAnchors(text);
		expect(blocks.filter((b) => b.anchor.kind === "frontmatter")).toHaveLength(0);
	});

	it("a closing `...` also terminates frontmatter", () => {
		const text = ["---", "title: Note", "...", "# Heading"].join("\n");
		const blocks = buildAnchors(text);
		const frontmatterBlocks = blocks.filter((b) => b.anchor.kind === "frontmatter");
		expect(frontmatterBlocks).toHaveLength(1);
		expect(frontmatterBlocks[0].range).toEqual({ startLine: 1, endLine: 3 });
	});
});

describe("buildAnchors: E13 — fenced code blocks", () => {
	it("a backtick fence yields one code anchor with the normalized fence line as text", () => {
		const text = ["```ts", "const x = 1;", "```"].join("\n");
		const blocks = buildAnchors(text);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].anchor.kind).toBe("code");
		expect(blocks[0].anchor.text).toBe("ts");
		expect(blocks[0].range).toEqual({ startLine: 1, endLine: 3 });
	});

	it("a tilde fence also yields one code anchor", () => {
		const text = ["~~~python", "x = 1", "~~~"].join("\n");
		const blocks = buildAnchors(text);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].anchor.kind).toBe("code");
		expect(blocks[0].anchor.text).toBe("python");
	});

	it("lines inside the fence never produce anchors, even heading/task/--- lookalikes", () => {
		const text = ["```md", "# not a heading", "- [ ] not a task", "---", "```", "# Real Heading"].join("\n");
		const blocks = buildAnchors(text);
		expect(blocks).toHaveLength(2);
		expect(blocks[0].anchor.kind).toBe("code");
		expect(blocks[1].anchor.kind).toBe("heading");
	});

	it("two code blocks with the same fence line are told apart by sibling index under the same parent", () => {
		const text = ["# Section", "```js", "a", "```", "```js", "b", "```"].join("\n");
		const blocks = buildAnchors(text);
		const codeBlocks = blocks.filter((b) => b.anchor.kind === "code");
		expect(codeBlocks).toHaveLength(2);
		expect(codeBlocks[0].anchor.siblingIndex).toBe(0);
		expect(codeBlocks[1].anchor.siblingIndex).toBe(1);
		expect(codeBlocks[0].anchor.text).toBe(codeBlocks[1].anchor.text);
	});

	it("an unterminated fence runs to end of file and still yields one anchor", () => {
		const text = ["```js", "a", "b", "c"].join("\n");
		const blocks = buildAnchors(text);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].anchor.kind).toBe("code");
		expect(blocks[0].range).toEqual({ startLine: 1, endLine: 4 });
	});
});

describe("buildAnchors: E13 — callouts and blockquotes use their first line as text", () => {
	it("a callout's text keeps the type and title, not the body", () => {
		const text = ["> [!note] Important title", "> body line one", "> body line two"].join("\n");
		const blocks = buildAnchors(text);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].anchor.kind).toBe("callout");
		expect(blocks[0].anchor.text).toBe("[!note] important title");
		expect(blocks[0].range).toEqual({ startLine: 1, endLine: 3 });
	});

	it("a plain blockquote uses its first line", () => {
		const text = ["> First line", "> Second line"].join("\n");
		const blocks = buildAnchors(text);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].anchor.kind).toBe("blockquote");
		expect(blocks[0].anchor.text).toBe("first line");
	});

	it("changing only the callout/blockquote body does not change the anchor", () => {
		const a = buildAnchors(["> [!warning] Heads up", "> old body"].join("\n"));
		const b = buildAnchors(["> [!warning] Heads up", "> a completely different body, much longer"].join("\n"));
		expect(a[0].anchor).toEqual(b[0].anchor);
	});
});

describe("buildAnchors: anchor structure", () => {
	it("heading indent is always 0, and heading nesting comes from the parent chain (nearest shallower heading)", () => {
		const text = ["# One", "## Two", "### Three", "## Two B"].join("\n");
		const blocks = buildAnchors(text).filter((b) => b.anchor.kind === "heading");
		expect(blocks.every((b) => b.anchor.indent === 0)).toBe(true);

		const one = findOne(blocks, (b) => b.anchor.text === "one");
		const two = findOne(blocks, (b) => b.anchor.text === "two");
		const three = findOne(blocks, (b) => b.anchor.text === "three");
		const twoB = findOne(blocks, (b) => b.anchor.text === "two b");

		expect(one.anchor.parentChain).toEqual([]);
		expect(two.anchor.parentChain).toEqual([{ kind: "heading", text: "one" }]);
		expect(three.anchor.parentChain).toEqual([
			{ kind: "heading", text: "one" },
			{ kind: "heading", text: "two" },
		]);
		// "Two B" is a sibling of "Two" (same level) — demoted back to directly under "One", not
		// nested under "Three".
		expect(twoB.anchor.parentChain).toEqual([{ kind: "heading", text: "one" }]);
	});

	it("indent: nested list items get the right parents at the right indents", () => {
		const text = ["- a", "\t- a", "    - a", "\t\t- b"].join("\n");
		const blocks = buildAnchors(text).filter((b) => b.anchor.kind === "list");
		expect(blocks.map((b) => b.anchor.indent)).toEqual([0, 4, 4, 8]);

		const root = blocks[0]; // "- a"
		const firstChild = blocks[1]; // "\t- a"
		const secondChild = blocks[2]; // "    - a"
		const grandchild = blocks[3]; // "\t\t- b"

		expect(firstChild.anchor.parentChain).toEqual([{ kind: "list", text: "a" }]);
		expect(secondChild.anchor.parentChain).toEqual([{ kind: "list", text: "a" }]);
		expect(secondChild.anchor.siblingIndex).toBe(1); // sibling of firstChild under the same parent
		expect(grandchild.anchor.parentChain).toEqual([
			{ kind: "list", text: "a" },
			{ kind: "list", text: "a" },
		]);
		expect(root.anchor.parentChain).toEqual([]);
	});

	it("sibling index counts same-kind siblings under the same parent; a task between two lists does not shift list indices", () => {
		const text = ["- list one", "- [ ] a task", "- list two"].join("\n");
		const blocks = buildAnchors(text);
		const lists = blocks.filter((b) => b.anchor.kind === "list");
		const tasks = blocks.filter((b) => b.anchor.kind === "task");
		expect(lists.map((b) => b.anchor.siblingIndex)).toEqual([0, 1]);
		expect(tasks.map((b) => b.anchor.siblingIndex)).toEqual([0]);
	});

	it("the parent chain is excluded from anchorKey, so renaming a grandparent does not change a child's key", () => {
		const a = buildAnchors(["# Grandparent", "## Parent", "- child"].join("\n"));
		const b = buildAnchors(["# Renamed Grandparent", "## Parent", "- child"].join("\n"));
		const childA = findOne(a, (x) => x.anchor.text === "child");
		const childB = findOne(b, (x) => x.anchor.text === "child");
		expect(childA.anchor.parentChain).not.toEqual(childB.anchor.parentChain);
		expect(anchorKey(childA.anchor)).toBe(anchorKey(childB.anchor));
	});

	it("an Anchor carries no line number or offset", () => {
		const [block] = buildAnchors("- a");
		expect(new Set(Object.keys(block.anchor))).toEqual(new Set(["kind", "indent", "text", "siblingIndex", "parentChain"]));
	});

	it("the line range is a separate field on the returned block, not on the anchor", () => {
		const [block] = buildAnchors("- a");
		expect(block.range).toEqual({ startLine: 1, endLine: 1 });
		expect(new Set(Object.keys(block))).toEqual(new Set(["anchor", "range"]));
	});
});

describe("parseAnchor", () => {
	const valid: Anchor = {
		kind: "task",
		indent: 4,
		text: "draft proposal",
		siblingIndex: 2,
		parentChain: [{ kind: "heading", text: "tuesday" }],
	};

	it("round-trips a valid Anchor through JSON", () => {
		const roundTripped = parseAnchor(JSON.parse(JSON.stringify(valid)));
		expect(roundTripped).toEqual(valid);
	});

	it.each([
		["null", null],
		["a string", "not an anchor"],
		["a number", 42],
		["an array", []],
		["missing kind", { indent: 0, text: "a", siblingIndex: 0, parentChain: [] }],
		["unknown kind", { kind: "bogus", indent: 0, text: "a", siblingIndex: 0, parentChain: [] }],
		["missing indent", { kind: "task", text: "a", siblingIndex: 0, parentChain: [] }],
		["indent wrong type", { kind: "task", indent: "4", text: "a", siblingIndex: 0, parentChain: [] }],
		["negative indent", { kind: "task", indent: -1, text: "a", siblingIndex: 0, parentChain: [] }],
		["missing text", { kind: "task", indent: 0, siblingIndex: 0, parentChain: [] }],
		["text wrong type", { kind: "task", indent: 0, text: 5, siblingIndex: 0, parentChain: [] }],
		["missing siblingIndex", { kind: "task", indent: 0, text: "a", parentChain: [] }],
		["siblingIndex wrong type", { kind: "task", indent: 0, text: "a", siblingIndex: "0", parentChain: [] }],
		["missing parentChain", { kind: "task", indent: 0, text: "a", siblingIndex: 0 }],
		["parentChain not an array", { kind: "task", indent: 0, text: "a", siblingIndex: 0, parentChain: "nope" }],
		[
			"malformed parentChain entry",
			{ kind: "task", indent: 0, text: "a", siblingIndex: 0, parentChain: [{ kind: "heading" }] },
		],
		[
			"parentChain entry that isn't an object",
			{ kind: "task", indent: 0, text: "a", siblingIndex: 0, parentChain: ["not an object"] },
		],
		[
			"parentChain entry with a non-string/unknown kind",
			{ kind: "task", indent: 0, text: "a", siblingIndex: 0, parentChain: [{ kind: 5, text: "a" }] },
		],
	])("returns null for %s, never throws", (_label, input) => {
		let result: Anchor | null = valid;
		expect(() => (result = parseAnchor(input))).not.toThrow();
		expect(result).toBeNull();
	});
});

describe("buildAnchors: edge / failure cases", () => {
	it("empty string returns an empty list and does not throw", () => {
		expect(() => buildAnchors("")).not.toThrow();
		expect(buildAnchors("")).toEqual([]);
	});

	it("only whitespace returns an empty list", () => {
		expect(buildAnchors("   \t  ")).toEqual([]);
	});

	it("only blank lines return an empty list", () => {
		expect(buildAnchors("\n\n\n")).toEqual([]);
	});

	it("CRLF and LF text yield identical anchors", () => {
		const lf = "# Heading\n- [ ] task\n\t- child";
		const crlf = lf.replace(/\n/g, "\r\n");
		expect(buildAnchors(crlf)).toEqual(buildAnchors(lf));
	});

	it("a trailing newline (or missing one) changes nothing", () => {
		const withoutTrailing = "# Heading\n- item";
		const withTrailing = `${withoutTrailing}\n`;
		expect(buildAnchors(withTrailing)).toEqual(buildAnchors(withoutTrailing));
	});

	it("identical lines under one parent get distinct sibling indices in document order", () => {
		const text = ["- dup", "- dup", "- dup"].join("\n");
		const blocks = buildAnchors(text);
		expect(blocks.map((b) => b.anchor.siblingIndex)).toEqual([0, 1, 2]);
		expect(blocks.every((b) => b.anchor.text === "dup")).toBe(true);
	});

	it("input is never mutated; repeated calls on the same input give identical output", () => {
		const input = "# Heading\n- [ ] task";
		const frozenInput = `${input}`;
		const first = buildAnchors(input);
		const second = buildAnchors(input);
		expect(input).toBe(frozenInput);
		expect(first).toEqual(second);
	});

	it("a 20,000-line note is anchored in one linear pass, under 1 second", () => {
		const lines: string[] = ["# Root"];
		for (let i = 0; i < 20000; i++) {
			lines.push(i % 2 === 0 ? `- [ ] task number ${i}` : `\t- child of ${i}`);
		}
		const text = lines.join("\n");

		const start = performance.now();
		const blocks = buildAnchors(text);
		const elapsedMs = performance.now() - start;

		expect(blocks.length).toBeGreaterThan(20000);
		expect(elapsedMs).toBeLessThan(1000);
	});
});

describe("buildAnchors: Unicode", () => {
	it("accents, CJK, emoji and combining marks normalize without throwing", () => {
		const text = ["# r\u00e9sum\u00e9", "- \u4f1a\u8bae\u8bb0\u5f55", "- party \ud83c\udf89 time"].join("\n");
		expect(() => buildAnchors(text)).not.toThrow();
		const blocks = buildAnchors(text);
		expect(blocks).toHaveLength(3);
	});

	it("text that normalizes to empty (a bare `- [ ]`) gives an anchor with empty text, not an error", () => {
		expect(() => buildAnchors("- [ ]")).not.toThrow();
		const [block] = buildAnchors("- [ ]");
		expect(block.anchor.kind).toBe("task");
		expect(block.anchor.text).toBe("");
	});
});

describe("buildAnchors: fixture — the GP1/GP2 Tasks.md text", () => {
	const beforeText = readFileSync(join(FIXTURES, "tasks-before.md"), "utf8");
	const afterText = readFileSync(join(FIXTURES, "tasks-after.md"), "utf8");

	it("anchors every documented kind present in the fixture", () => {
		const blocks = buildAnchors(beforeText);
		const kinds = new Set(blocks.map((b) => b.anchor.kind));
		expect(kinds).toEqual(
			new Set(["frontmatter", "heading", "list", "task", "blockquote", "callout", "code", "other"]),
		);
	});

	it("GP2's 4 inserted lines above ## Tuesday don't change the Tuesday heading's anchor", () => {
		const beforeTuesday = findOne(buildAnchors(beforeText), (b) => b.anchor.kind === "heading" && b.anchor.text === "tuesday");
		const afterTuesday = findOne(buildAnchors(afterText), (b) => b.anchor.kind === "heading" && b.anchor.text === "tuesday");
		expect(afterTuesday.anchor).toEqual(beforeTuesday.anchor);
		expect(afterTuesday.range.startLine).not.toBe(beforeTuesday.range.startLine); // the line moved...
		expect(anchorKey(afterTuesday.anchor)).toBe(anchorKey(beforeTuesday.anchor)); // ...but the anchor didn't
	});

	it("GP2's renamed task ('Draft proposal' -> 'Draft proposal v2') gets a different anchor text/key", () => {
		const beforeDraft = findOne(buildAnchors(beforeText), (b) => b.anchor.kind === "task" && b.anchor.text === "draft proposal");
		const afterDraft = findOne(buildAnchors(afterText), (b) => b.anchor.kind === "task" && b.anchor.text === "draft proposal v2");
		expect(anchorKey(afterDraft.anchor)).not.toBe(anchorKey(beforeDraft.anchor));
	});

	it("GP2's untouched 'Send invoices' sibling keeps the same anchor even though a new child was appended under it", () => {
		const beforeSend = findOne(buildAnchors(beforeText), (b) => b.anchor.kind === "task" && b.anchor.text === "send invoices");
		const afterSend = findOne(buildAnchors(afterText), (b) => b.anchor.kind === "task" && b.anchor.text === "send invoices");
		expect(afterSend.anchor).toEqual(beforeSend.anchor);
	});

	it("GP2's frontmatter anchor is unchanged by the added owner: dan key", () => {
		const beforeFrontmatter = findOne(buildAnchors(beforeText), (b) => b.anchor.kind === "frontmatter");
		const afterFrontmatter = findOne(buildAnchors(afterText), (b) => b.anchor.kind === "frontmatter");
		expect(afterFrontmatter.anchor).toEqual(beforeFrontmatter.anchor);
	});
});
