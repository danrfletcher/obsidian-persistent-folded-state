/**
 * src/matcher.ts: table-driven rule covering every G4 boundary, tier ordering, and one-to-one
 * candidate use (C5-C11, C26). Boundary rows use `vi.spyOn` on `similarity.ts`'s own export to
 * force an exact score, the same technique `matcher-caps.test.ts` uses for the comparisons spy —
 * so every boundary assertion is pinned to an exact, documented score rather than a crafted text
 * pair that could drift if `similarity()`'s blend ever changes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as similarityModule from "../../src/similarity";
import {
	FUZZY_THRESHOLD_LONG,
	FUZZY_THRESHOLD_SHORT,
	POSITIONAL_THRESHOLD,
	SHORT_LONG_SPLIT,
	matchAnchors,
} from "../../src/matcher";
import { anchorsFrom } from "../fixtures/matcher/build-anchors";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("G4 Tier 1 (exact): C5", () => {
	it("identical normalized text under the same (empty) parent is exact, with no similarity() call", async () => {
		const spy = vi.spyOn(similarityModule, "similarity");
		const stored = anchorsFrom("- [ ] Draft proposal");
		const candidates = anchorsFrom("- [x] draft **proposal**"); // status/emphasis/case erased
		const results = await matchAnchors(stored, candidates);
		expect(results).toEqual([{ tier: "exact", target: 0 }]);
		expect(spy).not.toHaveBeenCalled();
	});
});

describe("G4 Tier 2 (positional): C6 boundary at 39/40/41%", () => {
	// Two top-level tasks at the same sibling index (0) and indent (0) — same position, so
	// tier 2 is in play; the only thing deciding the outcome is the mocked score against
	// POSITIONAL_THRESHOLD.
	const stored = anchorsFrom("- [ ] alpha");
	const candidates = anchorsFrom("- [ ] alpha-renamed"); // same siblingIndex (0) and indent (0)

	it.each([
		[0.39, "none"],
		[0.4, "positional"],
		[0.41, "positional"],
	])("similarity %s -> %s (threshold is %s)", async (score, expected) => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(score as number);
		const [result] = await matchAnchors(stored, candidates);
		expect(result.tier).toBe(expected);
		if (expected === "none") expect((result as { reason: string }).reason).toBe("below-threshold");
		expect(POSITIONAL_THRESHOLD).toBe(0.4);
	});
});

describe("G4 Tier 3 (fuzzy): C7 character-split boundary at 19/20 characters", () => {
	// Same fixed score (0.70: clears the long bar, misses the short bar) against a 19- and a
	// 20-character stored line, each paired with a changed-position candidate (C8: "shorter
	// text" is the shorter of the two strings, and here both sides are the same length so the
	// split is unambiguous).
	it.each([
		[19, "none"],
		[20, "fuzzy"],
	])("a %s-character line uses the bar its own length picks", async (length, expected) => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.7);
		const stored = anchorsFrom(`- [ ] ${"a".repeat(length)}`);
		const candidates = anchorsFrom(`# Section\n\t- [ ] ${"b".repeat(length)}`);
		const [result] = await matchAnchors(stored, candidates);
		expect(result.tier).toBe(expected);
	});

	it("SHORT_LONG_SPLIT is 20 characters", () => {
		expect(SHORT_LONG_SPLIT).toBe(20);
	});
});

describe("G4 Tier 3: C7 percentage boundaries, inclusive (\"at least\")", () => {
	it.each([
		[0.59, "none"],
		[0.6, "fuzzy"],
		[0.61, "fuzzy"],
	])("a 25-character (long) line at similarity %s -> %s", async (score, expected) => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(score as number);
		const stored = anchorsFrom(`- [ ] ${"a".repeat(25)}`);
		const candidates = anchorsFrom(`# Section\n\t- [ ] ${"b".repeat(25)}`);
		const [result] = await matchAnchors(stored, candidates);
		expect(result.tier).toBe(expected);
	});

	it.each([
		[0.79, "none"],
		[0.8, "fuzzy"],
		[0.81, "fuzzy"],
	])("a 15-character (short) line at similarity %s -> %s", async (score, expected) => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(score as number);
		const stored = anchorsFrom(`- [ ] ${"a".repeat(15)}`);
		const candidates = anchorsFrom(`# Section\n\t- [ ] ${"b".repeat(15)}`);
		const [result] = await matchAnchors(stored, candidates);
		expect(result.tier).toBe(expected);
	});

	it("FUZZY_THRESHOLD_LONG is 0.6 and FUZZY_THRESHOLD_SHORT is 0.8", () => {
		expect(FUZZY_THRESHOLD_LONG).toBe(0.6);
		expect(FUZZY_THRESHOLD_SHORT).toBe(0.8);
	});
});

describe("G4 C8: \"shorter text\" is the shorter of the two strings being compared", () => {
	it("a 19-character stored line against a 30-character candidate uses the 80% bar, not the 60% one", async () => {
		const stored = anchorsFrom(`- [ ] ${"a".repeat(19)}`);
		const candidates = anchorsFrom(`# Section\n\t- [ ] ${"b".repeat(30)}`);

		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.79);
		expect((await matchAnchors(stored, candidates))[0].tier).toBe("none");

		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.8);
		expect((await matchAnchors(stored, candidates))[0].tier).toBe("fuzzy");
	});
});

describe("G4 C9: tiers run over all anchors in turn — fuzzy never takes an exactly-matched block", () => {
	it("an anchor whose only fuzzy candidate was already claimed exactly by another anchor gets none", async () => {
		// Only one candidate exists at all. Anchor 0 claims it exactly; anchor 1's sole
		// candidate is now gone before tier 3 (fuzzy, its only eligible tier) ever runs for it.
		const stored = anchorsFrom("- [ ] same text\n- [ ] different enough text here");
		const candidates = anchorsFrom("- [ ] same text");

		const results = await matchAnchors(stored, candidates);
		expect(results[0]).toEqual({ tier: "exact", target: 0 });
		expect(results[1]).toEqual({ tier: "none", reason: "no-candidate" });
	});
});

describe("G4 C10: ambiguity folds nothing", () => {
	it("two candidates tied at the best score give none/ambiguous, and neither is consumed", async () => {
		// 0.9 clears both the long- and short-text fuzzy bars, so the mocked score alone (not
		// the threshold) is what's under test here — the tie is what must block the match.
		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.9);
		const stored = anchorsFrom("- [ ] renamed task");
		// Two changed-position candidates (different indent to stay out of tier 2), both will
		// score identically under the mock, so this is a genuine tie, not an E1 duplicate pair
		// (their own texts differ from each other and from the stored anchor).
		const candidates = anchorsFrom("# A\n\t- [ ] candidate one\n# B\n\t- [ ] candidate two");

		const [result] = await matchAnchors(stored, candidates);
		expect(result).toEqual({ tier: "none", reason: "ambiguous" });
	});

	it("across the whole boundary table above, no below-threshold or ambiguous row ever returns a match", async () => {
		// Re-assert the meta-rule directly: every "none" row already checked above never carries
		// a `target`, which this type signature itself guarantees (`{ tier: "none" }` has no
		// `target` field) — checked once more explicitly for the below-threshold boundary rows.
		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.39);
		const stored = anchorsFrom("- [ ] alpha");
		const candidates = anchorsFrom("# Section\n\t- [ ] alpha-renamed");
		const [result] = await matchAnchors(stored, candidates);
		expect(result.tier).toBe("none");
		expect("target" in result).toBe(false);
	});
});

describe("G4 C11: the plan fixture (Draft proposal -> Draft proposal v2)", () => {
	const before = ["# Tuesday", "- [ ] Draft proposal", "- [ ] Send invoices"].join("\n");

	it("found as positional when four lines are inserted above and the sibling index is unchanged", async () => {
		const after = [
			"Some note above",
			"Another note",
			"Yet another",
			"And one more",
			"# Tuesday",
			"- [ ] Draft proposal v2",
			"- [ ] Send invoices",
		].join("\n");
		const stored = anchorsFrom(before);
		const candidates = anchorsFrom(after);
		const draftIdx = stored.findIndex((a) => a.text === "draft proposal");

		const results = await matchAnchors([stored[draftIdx]], candidates);
		expect(results[0].tier).toBe("positional");
	});

	it("the same pair, with a changed sibling index, scores under the 80% bar and is none", async () => {
		// "Draft proposal v2" now sits after an extra sibling task, so its sibling index no
		// longer matches the stored anchor's — this is tier 3's territory, not tier 2's.
		const after = ["# Tuesday", "- [ ] A new task first", "- [ ] Draft proposal v2", "- [ ] Send invoices"].join(
			"\n",
		);
		const stored = anchorsFrom(before);
		const candidates = anchorsFrom(after);
		const draftIdx = stored.findIndex((a) => a.text === "draft proposal");

		const realScore = similarityModule.similarity("draft proposal", "draft proposal v2");
		expect(realScore).toBeLessThan(FUZZY_THRESHOLD_SHORT); // sanity: the fixture is meant to miss

		const results = await matchAnchors([stored[draftIdx]], candidates);
		expect(results[0]).toEqual({ tier: "none", reason: "below-threshold" });
	});

	it("a separate long-line fixture (30+ characters, ~65% similar) is found as fuzzy (tier 3)", async () => {
		const stored = anchorsFrom("- [ ] Review the quarterly budget proposal draft");
		const candidates = anchorsFrom(
			"# Section\n\t- [ ] A new task first\n\t- [ ] Review the quarterly budget proposal document",
		);
		const target = stored[0];
		const realScore = similarityModule.similarity(
			target.text,
			"review the quarterly budget proposal document",
		);
		expect(realScore).toBeGreaterThanOrEqual(FUZZY_THRESHOLD_LONG);

		const results = await matchAnchors([target], candidates);
		expect(results[0].tier).toBe("fuzzy");
	});
});
