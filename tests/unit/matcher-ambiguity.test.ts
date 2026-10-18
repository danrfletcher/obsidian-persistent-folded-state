/**
 * src/matcher.ts: E1 duplicate ordinal pairing, E2 ties in both directions, and the C14/C20
 * parent-chain tiebreak (C17-C20, C27).
 */
import { describe, expect, it, vi } from "vitest";
import * as similarityModule from "../../src/similarity";
import { matchAnchors } from "../../src/matcher";
import { anchorsFrom, indexOfAnchor } from "../fixtures/matcher/build-anchors";

describe("E1: identical normalized lines under one parent pair by order (C17)", () => {
	it("only the 2nd of three duplicates folded maps to the 2nd of the new three", async () => {
		const before = "# Section\n\t- [ ] dup\n\t- [ ] dup\n\t- [ ] dup";
		const after = "# Section\n\t- [ ] dup\n\t- [ ] dup\n\t- [ ] dup"; // unchanged structure
		const storedAll = anchorsFrom(before);
		const candidates = anchorsFrom(after);

		const secondDuplicate = storedAll.find((a) => a.kind === "task" && a.siblingIndex === 1);
		if (!secondDuplicate) throw new Error("fixture: expected a 2nd duplicate task");

		const expectedCandidateIdx = indexOfAnchor(
			candidates,
			(a) => a.kind === "task" && a.siblingIndex === 1,
		);

		const results = await matchAnchors([secondDuplicate], candidates);
		expect(results[0]).toEqual({ tier: "exact", target: expectedCandidateIdx });
	});
});

describe("E1: fewer duplicates now than the stored ordinal (C18)", () => {
	it("the surplus anchors are none/no-candidate, never remapped onto the one remaining duplicate", async () => {
		const before = "# Section\n	- [ ] dup\n	- [ ] dup\n	- [ ] dup";
		const after = "# Section\n	- [ ] dup"; // only the first of three survives
		const stored = anchorsFrom(before).filter((a) => a.kind === "task");
		const candidates = anchorsFrom(after);

		const results = await matchAnchors(stored, candidates);
		const survivorCandidateIdx = indexOfAnchor(candidates, (a) => a.kind === "task");

		expect(results[0]).toEqual({ tier: "exact", target: survivorCandidateIdx }); // 1st: direct match
		expect(results[1]).toEqual({ tier: "none", reason: "no-candidate" }); // 2nd: surplus
		expect(results[2]).toEqual({ tier: "none", reason: "no-candidate" }); // 3rd: surplus
	});
});

describe("E1: duplicates under different parents never cross-pair (C18)", () => {
	it("each parent's own duplicate is matched to itself, never to the other parent's", async () => {
		const before = "# A\n\t- [ ] dup\n# B\n\t- [ ] dup";
		const after = "# A\n\t- [ ] dup\n# B\n\t- [ ] dup"; // unchanged, both parents still match exactly
		const stored = anchorsFrom(before);
		const candidates = anchorsFrom(after);

		const storedUnderA = stored.find((a) => a.parentChain[0]?.text === "a");
		const storedUnderB = stored.find((a) => a.parentChain[0]?.text === "b");
		if (!storedUnderA || !storedUnderB) throw new Error("fixture: expected one task under each heading");

		const candidateUnderA = indexOfAnchor(candidates, (a) => a.kind === "task" && a.parentChain[0]?.text === "a");
		const candidateUnderB = indexOfAnchor(candidates, (a) => a.kind === "task" && a.parentChain[0]?.text === "b");

		const results = await matchAnchors([storedUnderA, storedUnderB], candidates);
		expect(results[0]).toEqual({ tier: "exact", target: candidateUnderA });
		expect(results[1]).toEqual({ tier: "exact", target: candidateUnderB });
	});
});

describe("E2 forward direction: two candidates tied for one anchor (C19)", () => {
	it("neither is folded: none/ambiguous, and nothing is consumed", async () => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.9); // clears every bar, uniformly
		const stored = anchorsFrom("- [ ] renamed task");
		// Two changed-position candidates under different (non-matching) parents, different
		// indent from stored to stay out of tier 2 — both score identically under the mock.
		const candidates = anchorsFrom("# A\n\t- [ ] candidate one\n# B\n\t- [ ] candidate two");

		const results = await matchAnchors(stored, candidates);
		expect(results[0]).toEqual({ tier: "none", reason: "ambiguous" });

		vi.restoreAllMocks();
	});
});

describe("E2 reverse direction: two anchors tied for one candidate (C19)", () => {
	it("neither takes it: both anchors stay none/ambiguous", async () => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.9); // clears every bar, uniformly
		// Two differently-worded stored anchors (so they don't exact-match each other or the
		// single candidate), both with no other eligible candidate at all.
		const stored = anchorsFrom("- [ ] first phrasing entirely\n- [ ] second phrasing entirely");
		const candidates = anchorsFrom("# Elsewhere\n\t- [ ] the only candidate here");

		const results = await matchAnchors(stored, candidates);
		expect(results[0]).toEqual({ tier: "none", reason: "ambiguous" });
		expect(results[1]).toEqual({ tier: "none", reason: "ambiguous" });

		vi.restoreAllMocks();
	});
});

describe("C14/C20: the parent chain separates a text tie only when it itself differs", () => {
	it("two candidates tied on text score are separated by whichever parent chain reads closer", async () => {
		// Real similarity() throughout — no mock — so the tiebreak is driven by actual text.
		const stored = anchorsFrom("# Tuesday\n- [ ] wash the dishes very thoroughly and carefully")[1];
		const after = [
			"# Something Unrelated",
			"- [ ] filler line one",
			"# Tuesday Morning",
			"- [ ] wash the dishes very thoroughly",
			"# Giraffe",
			"- [ ] wash the dishes very thoroughly",
		].join("\n");
		const candidates = anchorsFrom(after);

		// Sanity: the two tied candidates really do share one identical text, and their own
		// score against `stored` really is tied (same string on both sides of the comparison).
		const tuesdayMorningTask = indexOfAnchor(
			candidates,
			(a) => a.kind === "task" && a.parentChain[0]?.text === "tuesday morning",
		);
		const giraffeTask = indexOfAnchor(candidates, (a) => a.kind === "task" && a.parentChain[0]?.text === "giraffe");
		expect(candidates[tuesdayMorningTask].text).toBe(candidates[giraffeTask].text);

		const results = await matchAnchors([stored], candidates);
		// "Tuesday Morning" reads far closer to the stored anchor's old parent, "Tuesday", than
		// "Giraffe" does — the tiebreak should pick it, not leave the tie unresolved.
		expect(results[0]).toEqual({ tier: "positional", target: tuesdayMorningTask });
	});

	it("an unseparated tie (chains equally (dis)similar) stays ambiguous", async () => {
		vi.spyOn(similarityModule, "similarity").mockImplementation((a, b) => {
			// Chain comparisons are recognizable by the "kind:text" format `chainText` builds;
			// force every chain comparison to tie too, isolating the "chain also ties" case.
			if (/^[a-z]+:/.test(a) && /^[a-z]+:/.test(b)) return 0.5;
			return 0.9; // every text-score comparison clears every bar, uniformly
		});
		const stored = anchorsFrom("- [ ] renamed task");
		const candidates = anchorsFrom("# A\n\t- [ ] candidate one\n# B\n\t- [ ] candidate two");

		const results = await matchAnchors(stored, candidates);
		expect(results[0]).toEqual({ tier: "none", reason: "ambiguous" });

		vi.restoreAllMocks();
	});
});
