/**
 * src/matcher.ts: G14 parent-first matching, a renamed parent's file-wide fallback across three
 * nesting levels, and G7's moved-block exclusion (C12, C13, C15, C27).
 */
import { describe, expect, it } from "vitest";
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
});
