/**
 * The fold-to-store rules of the embed recorder (PR-4, G1, G16): a fold upserts one anchor in the
 * embed's list, an unfold removes it, untouched anchors carry over, repeats collapse to one entry,
 * and every anchor is described against the embed's slice text, not the whole source note.
 * Pure: no DOM. Expected anchors are written out literally.
 */
import { describe, expect, it } from "vitest";
import { anchorForToggle, applyEmbedFold, displayText, embedKindOf, locateEmbed } from "../../src/embed-fold-recorder";
import type { EmbedLevelFacts, ToggleRef } from "../../src/embed-fold-recorder";
import { sliceEmbed } from "../../src/embed-slice";
import type { Anchor } from "../../src/anchors";
import type { EmbedFoldRecord, EmbedIdentity } from "../../src/types";
import { LESSONS_TEXT, SOURCE_TEXT } from "../fixtures/embed-recording-world";

/** An anchor that is also a plain stored record. */
type StoredAnchorLike = Anchor & Record<string, unknown>;
const LESSON_1: StoredAnchorLike = { kind: "task", indent: 0, text: "lesson 1: arrays", siblingIndex: 0, parentChain: [] };
const LESSON_2: StoredAnchorLike = { kind: "task", indent: 0, text: "lesson 2: maps", siblingIndex: 1, parentChain: [] };
const LESSON_3: StoredAnchorLike = { kind: "task", indent: 0, text: "lesson 3: graphs", siblingIndex: 2, parentChain: [] };
const COUNT: StoredAnchorLike = { kind: "task", indent: 2, text: "count word frequency", siblingIndex: 0, parentChain: [{ kind: "task", text: "lesson 2: maps" }] };

const IDENTITY: EmbedIdentity = { host: "Host.md", target: "Lessons.md", subpath: "", occurrence: 0 };
const toggle = (over: Partial<ToggleRef>): ToggleRef => ({ family: "list", text: "", sameBefore: 0, sameTotal: 1, index: 0, total: 1, ...over });

describe("applyEmbedFold: fold upserts, unfold removes", () => {
	it("a first fold creates the record with only that fold in it", () => {
		const next = applyEmbedFold(undefined, IDENTITY, "h1", LESSON_2, true);
		expect(next).toEqual({ host: "Host.md", target: "Lessons.md", subpath: "", occurrence: 0, contentHash: "h1", folds: [LESSON_2], dormant: [] });
	});

	it("a flat embed's record carries no `outer` key", () => {
		const next = applyEmbedFold(undefined, IDENTITY, "h1", LESSON_2, true);
		expect(Object.keys(next ?? {})).not.toContain("outer");
	});

	it("a second fold adds one anchor and carries the first over untouched", () => {
		const first = applyEmbedFold(undefined, IDENTITY, "h1", LESSON_1, true) as EmbedFoldRecord;
		const second = applyEmbedFold(first, IDENTITY, "h1", LESSON_3, true);
		expect(second?.folds).toEqual([LESSON_1, LESSON_3]);
	});

	it("folding the same anchor again changes nothing (repeats collapse to one entry)", () => {
		const first = applyEmbedFold(undefined, IDENTITY, "h1", LESSON_1, true) as EmbedFoldRecord;
		expect(applyEmbedFold(first, IDENTITY, "h1", LESSON_1, true)).toBeNull();
		expect(first.folds).toHaveLength(1);
	});

	it("an unfold removes that anchor and carries every other over", () => {
		const record: EmbedFoldRecord = { ...IDENTITY, contentHash: "h1", folds: [LESSON_1, LESSON_2, LESSON_3], dormant: [] };
		const next = applyEmbedFold(record, IDENTITY, "h1", LESSON_2, false);
		expect(next?.folds).toEqual([LESSON_1, LESSON_3]);
	});

	it("unfolding the parent does not delete the child's entry, and folding both stores two distinct anchors", () => {
		const parentOnly = applyEmbedFold(undefined, IDENTITY, "h1", LESSON_2, true) as EmbedFoldRecord;
		const both = applyEmbedFold(parentOnly, IDENTITY, "h1", COUNT, true) as EmbedFoldRecord;
		expect(both.folds).toEqual([LESSON_2, COUNT]);
		const parentUnfolded = applyEmbedFold(both, IDENTITY, "h1", LESSON_2, false);
		expect(parentUnfolded?.folds).toEqual([COUNT]);
	});

	it("unfolding the last fold leaves the record with an empty set (the entry stays, the anchor is gone)", () => {
		const record: EmbedFoldRecord = { ...IDENTITY, contentHash: "h1", folds: [LESSON_2], dormant: [] };
		expect(applyEmbedFold(record, IDENTITY, "h1", LESSON_2, false)?.folds).toEqual([]);
	});

	it("an unfold in an embed with no record creates none (G16: state exists only once Dan folds something)", () => {
		expect(applyEmbedFold(undefined, IDENTITY, "h1", LESSON_2, false)).toBeNull();
	});

	it("an unfold of an anchor that is not stored changes nothing", () => {
		const record: EmbedFoldRecord = { ...IDENTITY, contentHash: "h1", folds: [LESSON_1], dormant: [] };
		expect(applyEmbedFold(record, IDENTITY, "h1", LESSON_3, false)).toBeNull();
	});

	it("dormant anchors carry over untouched, and the slice hash is refreshed", () => {
		const dormant = { ...LESSON_3, dormantSince: 1_000 };
		const record: EmbedFoldRecord = { ...IDENTITY, contentHash: "old", folds: [LESSON_1], dormant: [dormant] };
		const next = applyEmbedFold(record, IDENTITY, "new", LESSON_2, true);
		expect(next?.dormant).toEqual([dormant]);
		expect(next?.contentHash).toBe("new");
	});

	it("never mutates the record it is given", () => {
		const record: EmbedFoldRecord = { ...IDENTITY, contentHash: "h1", folds: [LESSON_1], dormant: [] };
		const snapshot = structuredClone(record);
		applyEmbedFold(record, IDENTITY, "h1", LESSON_2, true);
		applyEmbedFold(record, IDENTITY, "h1", LESSON_1, false);
		expect(record).toEqual(snapshot);
	});

	it("a malformed stored fold is dropped while the well-formed ones carry over", () => {
		const record = { ...IDENTITY, contentHash: "h1", folds: [LESSON_1, { kind: "nonsense" }], dormant: [] } as unknown as EmbedFoldRecord;
		const next = applyEmbedFold(record, IDENTITY, "h1", LESSON_3, true);
		expect(next?.folds).toEqual([LESSON_1, LESSON_3]);
	});

	it("a nested embed's record keeps its chain", () => {
		const nested: EmbedIdentity = { ...IDENTITY, outer: [{ target: "Outer.md", subpath: "^o1", occurrence: 0 }] };
		const next = applyEmbedFold(undefined, nested, "h1", LESSON_1, true);
		expect(next?.outer).toEqual([{ target: "Outer.md", subpath: "^o1", occurrence: 0 }]);
	});
});

describe("anchorForToggle: described against the slice text, not the source note", () => {
	const slice = LESSONS_TEXT;

	it("a top-level lesson is its anchor in the slice", () => {
		expect(anchorForToggle(slice, toggle({ text: "lesson 2: maps", index: 1, total: 3 }))).toEqual(LESSON_2);
	});

	it("a nested child is its anchor, with the parent chain", () => {
		expect(anchorForToggle(slice, toggle({ text: "count word frequency", index: 2, total: 3 }))).toEqual(COUNT);
	});

	it("a leaf (nothing under it, so no arrow) is never an anchor", () => {
		expect(anchorForToggle(slice, toggle({ text: "two pointers" }))).toBeNull();
	});

	it("a block embed's anchors are those of its own slice: the lesson is first, with no parent heading", () => {
		const block = sliceEmbed(SOURCE_TEXT, "^0169a6");
		expect(block?.text).toBe(
			["- [ ] Lesson 8: Collections and frequency counting ^0169a6", "  - [ ] Count word frequency with a map", "    - [ ] Handle case folding", "  - [ ] Read the input"].join("\n")
		);
		expect(anchorForToggle(block?.text ?? "", toggle({ text: "lesson 8: collections and frequency counting", sameBefore: 0, sameTotal: 1, index: 0, total: 2 }))).toEqual({
			kind: "task",
			indent: 0,
			text: "lesson 8: collections and frequency counting ^0169a6",
			siblingIndex: 0,
			parentChain: [],
		});
	});

	it("identical rows are paired by order (E1)", () => {
		const text = ["- [ ] Step", "  - [ ] a", "- [ ] Step", "  - [ ] b"].join("\n");
		const first = anchorForToggle(text, toggle({ text: "step", sameBefore: 0, sameTotal: 2 }));
		const second = anchorForToggle(text, toggle({ text: "step", sameBefore: 1, sameTotal: 2 }));
		expect([first?.siblingIndex, second?.siblingIndex]).toEqual([0, 1]);
	});

	it("rows the DOM and the source disagree on in count are not guessed", () => {
		const text = ["- [ ] Step", "  - [ ] a", "- [ ] Step", "  - [ ] b"].join("\n");
		expect(anchorForToggle(text, toggle({ text: "step", sameBefore: 0, sameTotal: 1 }))).toBeNull();
	});

	it("a row whose block id Obsidian hides is found by text, not by position, whatever the arrow count (R1)", () => {
		const text = ["- [ ] Intro ^a1", "  continuation line", "- [ ] Lesson 8 ^0169a6", "  - [ ] a"].join("\n");
		const hit = anchorForToggle(text, toggle({ text: "lesson 8", index: 0, total: 1 }));
		expect(hit).toEqual({ kind: "task", indent: 0, text: "lesson 8 ^0169a6", siblingIndex: 1, parentChain: [] });
	});

	it("a row with a piped wikilink is found by its alias, and a plain one by its target (R1)", () => {
		const text = ["- [ ] See [[Other note|the other]]", "  - [ ] a", "- [ ] Read [[Plain note]]", "  - [ ] b"].join("\n");
		expect(anchorForToggle(text, toggle({ text: "see the other", index: 0, total: 9 }))?.siblingIndex).toBe(0);
		expect(anchorForToggle(text, toggle({ text: "read plain note", index: 1, total: 9 }))?.siblingIndex).toBe(1);
	});

	it("when the rendered text still differs from the source line, the arrow's position is used if the counts agree", () => {
		const text = ["- [ ] Run `npm test`", "  - [ ] a", "- [ ] Plain", "  - [ ] b"].join("\n");
		expect(anchorForToggle(text, toggle({ text: "run npm test", index: 0, total: 2 }))?.text).toBe("run `npm test`");
	});

	it("when the text still differs and the counts disagree, nothing is guessed", () => {
		const text = ["- [ ] Run `npm test`", "  - [ ] a", "- [ ] Plain", "  - [ ] b"].join("\n");
		expect(anchorForToggle(text, toggle({ text: "run npm test", index: 0, total: 3 }))).toBeNull();
	});

	it("a heading arrow finds the heading, not a list row of the same text", () => {
		const text = ["## Lesson 8", "- [ ] Lesson 8", "  - [ ] a"].join("\n");
		expect(anchorForToggle(text, toggle({ family: "heading", text: "lesson 8" }))?.kind).toBe("heading");
		expect(anchorForToggle(text, toggle({ family: "list", text: "lesson 8" }))?.kind).toBe("task");
	});
});

describe("anchorForToggle: refusals", () => {
	const two = ["- [ ] Step", "  - [ ] a", "- [ ] Step", "  - [ ] b"].join("\n");

	it("a block of a kind that is neither a heading nor a list row (a multi-line paragraph) is never a candidate", () => {
		const text = ["First line of a paragraph", "second line of the same paragraph", "", "- [ ] Item", "  - [ ] child"].join("\n");
		// The paragraph is not an arrow's row: the only candidate is the list item, whatever text is asked for.
		expect(anchorForToggle(text, toggle({ text: "first line of a paragraph", index: 0, total: 2 }))).toBeNull();
		expect(anchorForToggle(text, toggle({ text: "first line of a paragraph", index: 0, total: 1 }))?.text).toBe("item");
	});

	it("a text match whose order index is past the rows the slice has is null", () => {
		expect(anchorForToggle(two, toggle({ text: "step", sameBefore: 5, sameTotal: 2 }))).toBeNull();
	});

	it("a positional match whose index is past the foldable blocks is null", () => {
		expect(anchorForToggle(two, toggle({ text: "no such row", index: 7, total: 2 }))).toBeNull();
	});

	it("a positional match of the other family is null", () => {
		const text = ["## Head", "- [ ] item", "  - [ ] child"].join("\n");
		expect(anchorForToggle(text, toggle({ family: "list", text: "unknown", index: 0, total: 2 }))).toBeNull();
		expect(anchorForToggle(text, toggle({ family: "heading", text: "unknown", index: 1, total: 2 }))).toBeNull();
	});
});

describe("displayText: an anchor's text as Obsidian renders the row", () => {
	it.each([
		["lesson 8: collections ^0169a6", "lesson 8: collections"],
		["see [[other note|the other]] ^b2", "see the other"],
		["read [[plain note]]", "read plain note"],
		["open [the docs](https://example.com/a)", "open the docs"],
		["plain text", "plain text"],
		["keeps ^mid id here", "keeps ^mid id here"],
	])("%s -> %s", (input, shown) => {
		expect(displayText(input)).toBe(shown);
	});
});

describe("embedKindOf", () => {
	it.each([
		["", "whole-note"],
		["^0169a6", "block"],
		["Lesson 8", "heading"],
		["A#B", "heading"],
	])("subpath %j is a %s embed", (subpath, kind) => {
		expect(embedKindOf(subpath)).toBe(kind);
	});
});

describe("locateEmbed: which embed of the text is this element (G7, E1)", () => {
	const resolve = (lt: string): string | null => (lt === "Lessons" || lt === "Lessons.md" ? "Lessons.md" : null);
	const level = (over: Partial<EmbedLevelFacts>): EmbedLevelFacts => ({ src: "Lessons", siblingSrcs: ["Lessons"], index: 0, ...over });

	it("one embed of that note: index 0, no DOM needed", () => {
		expect(locateEmbed("![[Lessons]]\n", "Host.md", level({ siblingSrcs: [] }), resolve, null)).toEqual({ target: "Lessons.md", subpath: "", occurrence: 0 });
	});

	it("two identical embeds and a full DOM: the element's order among them", () => {
		const text = "![[Lessons]]\n\ntext\n\n![[Lessons|again]]\n";
		const dom = ["Lessons", "Lessons"];
		expect(locateEmbed(text, "Host.md", level({ siblingSrcs: dom, index: 1 }), resolve, null)?.occurrence).toBe(1);
		expect(locateEmbed(text, "Host.md", level({ siblingSrcs: dom, index: 0 }), resolve, null)?.occurrence).toBe(0);
	});

	it("two identical embeds but only one in the DOM and no position: not guessed", () => {
		const text = "![[Lessons]]\n\n![[Lessons]]\n";
		expect(locateEmbed(text, "Host.md", level({ siblingSrcs: ["Lessons"], index: 0 }), resolve, null)).toBeNull();
	});

	it("two identical embeds but only one in the DOM, with a position: counted from the text", () => {
		const text = "![[Lessons]]\n\n![[Lessons]]\n";
		const second = text.lastIndexOf("![[");
		expect(locateEmbed(text, "Host.md", level({ siblingSrcs: ["Lessons"] }), resolve, second)?.occurrence).toBe(1);
		expect(locateEmbed(text, "Host.md", level({ siblingSrcs: ["Lessons"] }), resolve, 0)?.occurrence).toBe(0);
	});

	it("a position at the end of the widget's text still means the same embed", () => {
		const text = "![[Lessons]]\n\n![[Lessons]]\n";
		const endOfSecond = text.lastIndexOf("]]") + 2;
		expect(locateEmbed(text, "Host.md", level({ siblingSrcs: ["Lessons"] }), resolve, endOfSecond)?.occurrence).toBe(1);
	});

	it("other embeds in between do not count", () => {
		const text = "![[Lessons]]\n![[Other]]\n![[Lessons#^x]]\n![[Lessons]]\n";
		expect(locateEmbed(text, "Host.md", level({ siblingSrcs: ["Lessons", "Other", "Lessons#^x", "Lessons"], index: 3 }), resolve, null)?.occurrence).toBe(1);
	});

	it("an embed that is not in the text (unsaved, or broken) is null", () => {
		expect(locateEmbed("no embeds here", "Host.md", level({}), resolve, null)).toBeNull();
	});

	it("the same link text inside code or a comment is not an embed of the host", () => {
		const text = "`![[Lessons]]`\n![[Lessons]]\n";
		expect(locateEmbed(text, "Host.md", level({ siblingSrcs: ["Lessons"] }), resolve, null)?.occurrence).toBe(0);
	});

	it("a ![](x.md) embed written with percent-encoding resolves like the wikilink form", () => {
		const text = "![](Lessons.md)\n";
		expect(locateEmbed(text, "Host.md", level({ src: "Lessons.md", siblingSrcs: [] }), resolve, null)).toEqual({ target: "Lessons.md", subpath: "", occurrence: 0 });
	});

	it("an element whose src is empty cannot be told", () => {
		expect(locateEmbed("![[Lessons]]\n", "Host.md", level({ src: "", siblingSrcs: [""] }), resolve, null)).toBeNull();
	});

	it("a percent-encoded src is read as its decoded link text", () => {
		const spaced = (lt: string): string | null => (lt === "My Notes" ? "My Notes.md" : null);
		const text = "![[My Notes]]\n";
		expect(locateEmbed(text, "Host.md", level({ src: "My%20Notes", siblingSrcs: [] }), spaced, null)).toEqual({ target: "My Notes.md", subpath: "", occurrence: 0 });
	});

	it("a src with a stray percent sign that does not decode is still tried as written", () => {
		const odd = (lt: string): string | null => (lt === "100%" ? "100%.md" : null);
		expect(locateEmbed("![[100%]]\n", "Host.md", level({ src: "100%", siblingSrcs: [] }), odd, null)).toEqual({ target: "100%.md", subpath: "", occurrence: 0 });
	});

	it("an embed of the host's own heading (empty target) is keyed to the host", () => {
		const own = locateEmbed("# Part\n\n![[#Part]]\n", "Host.md", level({ src: "#Part", siblingSrcs: [] }), resolve, null);
		expect(own).toEqual({ target: "Host.md", subpath: "Part", occurrence: 0 });
	});

	it("a link that does not resolve falls back to the written target, so a not-yet-created note still has a key", () => {
		const none = (): string | null => null;
		expect(locateEmbed("![[Draft.md]]\n", "Host.md", level({ src: "Draft.md", siblingSrcs: [] }), none, null)).toEqual({ target: "Draft", subpath: "", occurrence: 0 });
	});

	it("a position before any '![' is taken as given", () => {
		const text = "x ![[Lessons]]\n![[Lessons]]\n";
		expect(locateEmbed(text, "Host.md", level({ siblingSrcs: ["Lessons"] }), resolve, 1)?.occurrence).toBe(0);
	});

	it("a position after every embed of that note counts none of them as this one", () => {
		const text = "![[Lessons]]\n![[Lessons]]\n![x";
		expect(locateEmbed(text, "Host.md", level({ siblingSrcs: ["Lessons"] }), resolve, text.length)).toBeNull();
	});

	it("the element's own index not among the identical embeds is null", () => {
		const text = "![[Lessons]]\n![[Lessons]]\n![[Other]]\n";
		const dom = ["Lessons", "Lessons", "Other"];
		expect(locateEmbed(text, "Host.md", level({ siblingSrcs: dom, index: 2 }), resolve, null)).toBeNull();
	});
});
