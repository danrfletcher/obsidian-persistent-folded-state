/**
 * src/matcher.ts: G14 parent-first matching, a renamed parent's file-wide fallback across three
 * nesting levels, and G7's moved-block exclusion (C12, C13, C15, C27).
 */
import { describe, expect, it, vi } from "vitest";
import * as similarityModule from "../../src/similarity";
import type { Anchor } from "../../src/anchors";
import { matchAnchors } from "../../src/matcher";
import { anchorsFrom, indexOfAnchor } from "../fixtures/matcher/build-anchors";

describe("G14 C12: a child is matched among its matched parent's children first", () => {
	it("an identical-text decoy under a different, unrelated parent is never considered", async () => {
		const stored = anchorsFrom("# Home\n- [ ] task one\n# Other\n- [ ] task one")[1];
		const after = "# Home\n- [ ] task one revised\n# Other\n- [ ] task one";
		const candidates = anchorsFrom(after);

		// The decoy: Other's child still literally equals the stored anchor's old text — if the
		// pool weren't restricted to Home's own children, this would win as an exact match.
		const decoyUnderOther = indexOfAnchor(
			candidates,
			(a) => a.kind === "task" && a.parentChain[0]?.text === "other",
		);
		const renamedUnderHome = indexOfAnchor(
			candidates,
			(a) => a.kind === "task" && a.parentChain[0]?.text === "home",
		);
		expect(candidates[decoyUnderOther].text).toBe(stored.text); // sanity: a genuine decoy

		const results = await matchAnchors([stored], candidates);
		expect(results[0]).toEqual({ tier: "positional", target: renamedUnderHome });
	});
});

describe("G14 C13: a renamed parent doesn't demote the folds beneath it (three levels)", () => {
	const before = "# Project\n- Phase one\n\t- [ ] sub task alpha";
	const after = "# Totally Renamed Heading\n- Phase one\n\t- [ ] sub task alpha";

	it("the list item (one level down) still falls back to a unique file-wide match", async () => {
		const stored = anchorsFrom(before).find((a) => a.kind === "list");
		if (!stored) throw new Error("fixture: expected a list-item anchor");
		const candidates = anchorsFrom(after);
		const target = indexOfAnchor(candidates, (a) => a.kind === "list");

		const results = await matchAnchors([stored], candidates);
		expect(results[0]).toEqual({ tier: "exact", target });
	});

	it("the sub-item task (two levels down) still falls back to a unique file-wide match", async () => {
		const stored = anchorsFrom(before).find((a) => a.kind === "task");
		if (!stored) throw new Error("fixture: expected a task anchor");
		const candidates = anchorsFrom(after);
		const target = indexOfAnchor(candidates, (a) => a.kind === "task");

		const results = await matchAnchors([stored], candidates);
		expect(results[0]).toEqual({ tier: "exact", target });
	});

	it("both the list item and the sub-item resolve together in a single run, unaffected by the renamed heading's own fate", async () => {
		const all = anchorsFrom(before);
		const stored = [all.find((a) => a.kind === "list"), all.find((a) => a.kind === "task")];
		if (!stored[0] || !stored[1]) throw new Error("fixture: expected both a list item and a task");
		const candidates = anchorsFrom(after);

		const results = await matchAnchors(stored as [Anchor, Anchor], candidates);
		expect(results[0].tier).toBe("exact");
		expect(results[1].tier).toBe("exact");
	});
});

describe("G7 C15: a block moved under a different (still-matching) parent gets none", () => {
	it("the identical text now sitting under the new parent is never claimed", async () => {
		const stored = anchorsFrom("# Home\n- [ ] move me\n# Other\n- [ ] something else")[1];
		// "move me" is now under Other; Home's old slot holds different text. Home itself is
		// unchanged, so its children stay in scope — Other's children are never searched.
		const after = "# Home\n- [ ] something else\n# Other\n- [ ] move me";
		const candidates = anchorsFrom(after);

		const movedCandidateIdx = indexOfAnchor(candidates, (a) => a.text === "move me");
		expect(candidates[movedCandidateIdx].parentChain[0]?.text).toBe("other"); // sanity: it did move

		const results = await matchAnchors([stored], candidates);
		expect(results[0]).toEqual({ tier: "none", reason: "below-threshold" });
	});

	it("R9: the old parent is edited but still matches positionally — the moved block still gets none", async () => {
		// Dan's repro: "Home" -> "Home base" still reads close enough to match positionally
		// (similarity ~0.47, clearing the 40% bar), so Home's children stay scoped to Home's
		// own real children — "move me", now sitting under the unrelated, unchanged "Other",
		// is never claimed even though its text is identical.
		const stored = anchorsFrom("# Home\n- [ ] move me\n# Other\n- [ ] something else")[1];
		const after = "# Home base\n- [ ] something else\n# Other\n- [ ] move me";
		const candidates = anchorsFrom(after);

		const movedCandidateIdx = indexOfAnchor(candidates, (a) => a.text === "move me");
		expect(candidates[movedCandidateIdx].parentChain[0]?.text).toBe("other"); // sanity: it did move
		const homeBaseScore = similarityModule.similarity("home", "home base");
		expect(homeBaseScore).toBeGreaterThanOrEqual(0.4); // sanity: Home still matches positionally

		const results = await matchAnchors([stored], candidates);
		expect(results[0]).toEqual({ tier: "none", reason: "below-threshold" });
	});
});

describe("G14/R9: a parent that is edited but still matches scopes its children to its real children", () => {
	it("an identical-text decoy under a different, unrelated (unchanged) parent is still never considered", async () => {
		// Before: the decoy under "Other" and the real task under "Home" happen to land at the
		// same siblingIndex, and the decoy is iterated *first* — without the R9 fix, the naive
		// file-wide fallback this used to trigger would pick the decoy by array order.
		const before = "# Other\n- [ ] task one\n# Home\n- [ ] task one";
		const after = "# Other\n- [ ] task one\n# Home base\n- [ ] task one";
		const stored = anchorsFrom(before).find((a) => a.kind === "task" && a.parentChain[0]?.text === "home");
		if (!stored) throw new Error("fixture: expected a task under Home");
		const candidates = anchorsFrom(after);

		const decoyUnderOther = indexOfAnchor(
			candidates,
			(a) => a.kind === "task" && a.parentChain[0]?.text === "other",
		);
		const realUnderHomeBase = indexOfAnchor(
			candidates,
			(a) => a.kind === "task" && a.parentChain[0]?.text === "home base",
		);
		expect(candidates[decoyUnderOther].text).toBe(stored.text); // sanity: a genuine decoy

		const results = await matchAnchors([stored], candidates);
		expect(results[0]).toEqual({ tier: "exact", target: realUnderHomeBase });
	});

	it("cascades through three levels: the middle (list item) parent is edited but still matches", async () => {
		// Heading unchanged; the list item is reworded but still reads close enough to match
		// (similarity well above 40%) — the sub-task below it should scope to its real new
		// children, not fall back file-wide the way C13's "renamed past its bar" case does.
		const before = "# Section\n- Phase one\n	- [ ] sub task alpha";
		const after = "# Section\n- Phase one revised\n	- [ ] sub task alpha";
		const stored = anchorsFrom(before).find((a) => a.kind === "task");
		if (!stored) throw new Error("fixture: expected a sub-task anchor");
		const candidates = anchorsFrom(after);

		const listScore = similarityModule.similarity("phase one", "phase one revised");
		expect(listScore).toBeGreaterThanOrEqual(0.4); // sanity: the list item still matches

		const target = indexOfAnchor(candidates, (a) => a.kind === "task");
		const results = await matchAnchors([stored], candidates);
		expect(results[0]).toEqual({ tier: "exact", target });
	});
});

describe("Scope resolution edge cases: an ambiguous ancestor still falls back correctly", () => {
	it("two candidates sharing one ancestor's exact text leave that ancestor unresolved (ambiguous), not picked by order", async () => {
		// Two headings literally named "Duplicate" (an AnchorParentRef only ever carries kind +
		// text, never a sibling index, so these two are indistinguishable as *ancestors*).
		// Resolving either stored task's parent hits two exact matches — ambiguous, so both
		// fall back file-wide — but each task's own text is still unique there, so the file-wide
		// fallback still finds it (via a genuinely unique exact match, never an order guess).
		const before = "# Duplicate\n- [ ] alpha\n# Duplicate\n- [ ] beta";
		const after = "# Duplicate\n- [ ] alpha\n# Duplicate\n- [ ] beta";
		const stored = anchorsFrom(before).filter((a) => a.kind === "task");
		const candidates = anchorsFrom(after);

		const alphaTarget = indexOfAnchor(candidates, (a) => a.text === "alpha");
		const betaTarget = indexOfAnchor(candidates, (a) => a.text === "beta");

		const results = await matchAnchors(stored, candidates);
		expect(results[0]).toEqual({ tier: "exact", target: alphaTarget });
		expect(results[1]).toEqual({ tier: "exact", target: betaTarget });
	});

	it("two differently-named candidate ancestors tied on similarity leave the ancestor unresolved", async () => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.5); // ties every ancestor comparison
		// The leaf text is unique and resolves by exact tier (no similarity() call needed for
		// it), so the mocked score only ever drives the *ancestor* resolution here.
		const stored = anchorsFrom("# Zzz\n- [ ] shared leaf text")[1];
		const after = "# Foo\n- [ ] shared leaf text\n# Bar\n- [ ] decoy text";
		const candidates = anchorsFrom(after);
		const target = indexOfAnchor(candidates, (a) => a.text === "shared leaf text");

		const results = await matchAnchors([stored], candidates);
		expect(results[0]).toEqual({ tier: "exact", target });

		vi.restoreAllMocks();
	});
});
