/**
 * src/embed-restore-plan.ts: the pure stored-set vs live-set planner (ticket warkworth-21, PR-5,
 * G13, E4). The matches come from the real `matchAnchors` over the real `buildAnchors` of the
 * Rocketship example's slice (Lesson 8 and its sub-tasks); only the live arrows are hand-built.
 */
import { describe, expect, it } from "vitest";
import { buildAnchors } from "../../src/anchors";
import type { Anchor, AnchoredBlock } from "../../src/anchors";
import { parseEmbedLinktext } from "../../src/embed-key";
import { sliceEmbed } from "../../src/embed-slice";
import { planEmbedRestore, resolvedBlocks } from "../../src/embed-restore-plan";
import type { LiveArrow } from "../../src/embed-restore-plan";
import { matchAnchors } from "../../src/matcher";
import type { MatchResult } from "../../src/matcher";
import { SOURCE_TEXT } from "../fixtures/embed-recording-world";

function sliceOf(text: string, link: string): string {
	const parsed = parseEmbedLinktext(link);
	const slice = parsed === null ? null : sliceEmbed(text, parsed.subpath);
	if (slice === null) throw new Error(`fixture: no slice for ${link}`);
	return slice.text;
}

/** Lesson 8 as the embed shows it: the block with its two sub-tasks and one nested child. */
const LESSON_8_SLICE = sliceOf(SOURCE_TEXT, "Competitive Coding Fundamentals#^0169a6");
const CANDIDATES: AnchoredBlock[] = buildAnchors(LESSON_8_SLICE);
const FOLDABLE = CANDIDATES.map((c, i) => i).filter((i) => CANDIDATES[i].range.endLine > CANDIDATES[i].range.startLine);

function indexOfText(text: string): number {
	const hit = CANDIDATES.findIndex((c) => c.anchor.text.startsWith(text));
	if (hit === -1) throw new Error(`fixture: no block "${text}"`);
	return hit;
}

const LESSON_8 = indexOfText("lesson 8");
const COUNT_WORDS = indexOfText("count word frequency");
const READ_INPUT = indexOfText("read the input");

function stored(...indices: number[]): Anchor[] {
	return indices.map((i) => CANDIDATES[i].anchor);
}

async function plan(storedAnchors: Anchor[], arrows: LiveArrow[]) {
	const matches = await matchAnchors(storedAnchors, CANDIDATES.map((c) => c.anchor));
	return planEmbedRestore({ matches, candidates: CANDIDATES, arrows });
}

const arrow = (block: number | null, collapsed: boolean): LiveArrow => ({ block, collapsed });

describe("fixture sanity: the Rocketship slice", () => {
	it("has Lesson 8 and its nested sub-task as foldable blocks, and Read the input as a leaf", () => {
		expect(FOLDABLE).toContain(LESSON_8);
		expect(FOLDABLE).toContain(COUNT_WORDS);
		expect(FOLDABLE).not.toContain(READ_INPUT);
	});
});

describe("empty store and empty stored set (G13): the embed ends fully expanded", () => {
	it("nothing stored, nothing collapsed: plans nothing", async () => {
		expect(await plan([], [arrow(LESSON_8, false), arrow(COUNT_WORDS, false)])).toEqual({ fold: [], unfold: [] });
	});

	it("nothing stored, Obsidian showed Lesson 8 folded: it is unfolded, nothing is adopted", async () => {
		expect(await plan([], [arrow(LESSON_8, true), arrow(COUNT_WORDS, false)])).toEqual({ fold: [], unfold: [0] });
	});

	it("nothing stored: an arrow whose block could not be told is unfolded when collapsed", async () => {
		expect(await plan([], [arrow(null, true), arrow(null, false)])).toEqual({ fold: [], unfold: [0] });
	});

	it("no arrows at all plans nothing", async () => {
		expect(await plan(stored(LESSON_8), [])).toEqual({ fold: [], unfold: [] });
	});
});

describe("stored set = live set: a no-op", () => {
	it("Lesson 8 stored and already folded: plans nothing", async () => {
		expect(await plan(stored(LESSON_8), [arrow(LESSON_8, true), arrow(COUNT_WORDS, false)])).toEqual({ fold: [], unfold: [] });
	});

	it("two stored, both folded: plans nothing", async () => {
		const live = [arrow(LESSON_8, true), arrow(COUNT_WORDS, true)];
		expect(await plan(stored(LESSON_8, COUNT_WORDS), live)).toEqual({ fold: [], unfold: [] });
	});
});

describe("missing folds are applied (E4: native partial restore)", () => {
	it("Lesson 8 stored, nothing folded: fold it", async () => {
		expect(await plan(stored(LESSON_8), [arrow(LESSON_8, false), arrow(COUNT_WORDS, false)])).toEqual({ fold: [0], unfold: [] });
	});

	it("two stored, Obsidian restored one: only the missing one is folded", async () => {
		const live = [arrow(LESSON_8, true), arrow(COUNT_WORDS, false)];
		expect(await plan(stored(LESSON_8, COUNT_WORDS), live)).toEqual({ fold: [1], unfold: [] });
	});

	it("an arrow of unknown block is left alone while the set is not empty", async () => {
		expect(await plan(stored(LESSON_8), [arrow(null, false), arrow(LESSON_8, false)])).toEqual({ fold: [1], unfold: [] });
		expect(await plan(stored(LESSON_8), [arrow(null, true), arrow(LESSON_8, true)])).toEqual({ fold: [], unfold: [] });
	});
});

describe("stray folds are unfolded (E4: the stored set wins)", () => {
	it("Obsidian folded Lesson 8 and its sub-task, only the sub-task is stored: Lesson 8 is unfolded", async () => {
		const live = [arrow(LESSON_8, true), arrow(COUNT_WORDS, true)];
		expect(await plan(stored(COUNT_WORDS), live)).toEqual({ fold: [], unfold: [0] });
	});

	it("a stray is unfolded and a missing fold applied in the same plan", async () => {
		const live = [arrow(LESSON_8, true), arrow(COUNT_WORDS, false)];
		expect(await plan(stored(COUNT_WORDS), live)).toEqual({ fold: [1], unfold: [0] });
	});

	it("indices are ascending", async () => {
		const live = [arrow(COUNT_WORDS, true), arrow(LESSON_8, true), arrow(null, true)];
		const result = await plan([], live);
		expect(result.unfold).toEqual([0, 1, 2]);
	});
});

describe("ambiguous or unconfident matches fold nothing (rule 4)", () => {
	it("a stored anchor with no counterpart in the slice stays unfolded", async () => {
		const gone = buildAnchors("- [ ] Lesson 99: Not here\n  - [ ] child\n")[0].anchor;
		expect(await plan([gone], [arrow(LESSON_8, false), arrow(COUNT_WORDS, false)])).toEqual({ fold: [], unfold: [] });
	});

	it("an ambiguous (non-exact tie) result adds nothing to the set", () => {
		const matches: MatchResult[] = [{ tier: "none", reason: "ambiguous" }];
		expect(planEmbedRestore({ matches, candidates: CANDIDATES, arrows: [arrow(LESSON_8, false), arrow(COUNT_WORDS, true)] })).toEqual({
			fold: [],
			unfold: [1],
		});
	});

	it("a capped or below-threshold result adds nothing either", () => {
		const matches: MatchResult[] = [
			{ tier: "none", reason: "capped" },
			{ tier: "none", reason: "no-candidate" },
		];
		expect(resolvedBlocks(matches, CANDIDATES).size).toBe(0);
	});
});

describe("one anchor, one block", () => {
	it("a match onto a block with no children (nothing to collapse) is not in the set", () => {
		const matches: MatchResult[] = [{ tier: "exact", target: READ_INPUT }];
		expect(resolvedBlocks(matches, CANDIDATES).size).toBe(0);
	});

	it("a target outside the candidates is ignored, never thrown on", () => {
		const matches: MatchResult[] = [{ tier: "exact", target: 999 }];
		expect(resolvedBlocks(matches, CANDIDATES).size).toBe(0);
	});

	it("two identical lines stored once: only the paired block is folded, never both", async () => {
		const dup = "- [ ] dup\n  - [ ] a\n- [ ] dup\n  - [ ] b\n";
		const candidates = buildAnchors(dup);
		const dupBlocks = candidates.map((c, i) => i).filter((i) => candidates[i].anchor.text === "dup");
		expect(dupBlocks).toHaveLength(2);
		const second = candidates[dupBlocks[1]].anchor;
		const matches = await matchAnchors([second], candidates.map((c) => c.anchor));
		expect(matches[0]).toEqual({ tier: "exact", target: dupBlocks[1] });
		const live = dupBlocks.map((b) => arrow(b, false));
		expect(planEmbedRestore({ matches, candidates, arrows: live })).toEqual({ fold: [1], unfold: [] });
	});

	it("two stored anchors resolving to one block fold it once", () => {
		const matches: MatchResult[] = [
			{ tier: "exact", target: LESSON_8 },
			{ tier: "fuzzy", target: LESSON_8 },
		];
		expect(resolvedBlocks(matches, CANDIDATES)).toEqual(new Set([LESSON_8]));
		expect(planEmbedRestore({ matches, candidates: CANDIDATES, arrows: [arrow(LESSON_8, false)] })).toEqual({ fold: [0], unfold: [] });
	});
});
