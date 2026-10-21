/**
 * src/matcher.ts: E1 duplicate ordinal pairing, E2 ties in both directions, and the C14/C20
 * parent-chain tiebreak (C17-C20, C27).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as similarityModule from "../../src/similarity";
import { matchAnchors } from "../../src/matcher";
import { anchorsFrom, indexOfAnchor } from "../fixtures/matcher/build-anchors";

// R15 (PR-4): restored after every test, not at the end of a test body, so a failed assertion
// can't leave a mocked similarity() in place for the tests that follow.
afterEach(() => {
	vi.restoreAllMocks();
});

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

	it("leftovers that don't share a literal siblingIndex value are paired by relative rank", async () => {
		// 4 duplicates before (siblingIndex 0,1,2,3), but only the 2nd and 4th were folded.
		// Only 2 duplicates survive in the new text (siblingIndex 0,1). The 2nd (siblingIndex
		// 1) still matches directly by its own siblingIndex value. The 4th (siblingIndex 3) has
		// no siblingIndex-3 candidate left, so it falls back to rank: among what's left after
		// the direct match consumes candidate 1, only candidate 0 remains, and it's the sole
		// leftover on both sides — so it's paired by rank, not literal siblingIndex equality.
		const before = "# Section\n\t- [ ] dup\n\t- [ ] dup\n\t- [ ] dup\n\t- [ ] dup";
		const after = "# Section\n\t- [ ] dup\n\t- [ ] dup";
		const storedAll = anchorsFrom(before).filter((a) => a.kind === "task");
		const candidates = anchorsFrom(after);

		const secondDuplicate = storedAll.find((a) => a.siblingIndex === 1);
		const fourthDuplicate = storedAll.find((a) => a.siblingIndex === 3);
		if (!secondDuplicate || !fourthDuplicate) throw new Error("fixture: expected 4 stored duplicates");

		const candidateSibling0 = indexOfAnchor(candidates, (a) => a.kind === "task" && a.siblingIndex === 0);
		const candidateSibling1 = indexOfAnchor(candidates, (a) => a.kind === "task" && a.siblingIndex === 1);

		const results = await matchAnchors([secondDuplicate, fourthDuplicate], candidates);
		expect(results[0]).toEqual({ tier: "exact", target: candidateSibling1 }); // direct siblingIndex match
		expect(results[1]).toEqual({ tier: "exact", target: candidateSibling0 }); // rank-based leftover pairing
	});
});

describe("E1: fewer duplicates now than the stored ordinal (C18)", () => {
	it("the surplus anchors are none/no-candidate, never remapped onto the one remaining duplicate", async () => {
		const before = "# Section\n\t- [ ] dup\n\t- [ ] dup\n\t- [ ] dup";
		const after = "# Section\n\t- [ ] dup"; // only the first of three survives
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
		const before = "# A\n	- [ ] dup\n# B\n	- [ ] dup";
		const after = "# A\n	- [ ] dup\n# B\n	- [ ] dup"; // unchanged, both parents still match exactly
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

	it("R8: a renamed-past-its-bar parent's file-wide fallback claims only a unique exact match", async () => {
		// Dan's repro: "Tue" is folded under; after renaming the Tue heading far enough that it
		// no longer matches at all, the task's file-wide fallback sees two identical-text
		// candidates (Mon's and the renamed heading's) — neither is a legitimate, unique
		// match, so the result must be none, never Mon's task.
		const before = "# Mon\n- [ ] follow up with client\n# Tue\n- [ ] follow up with client";
		const stored = anchorsFrom(before).find((a) => a.kind === "task" && a.parentChain[0]?.text === "tue");
		if (!stored) throw new Error("fixture: expected a task under Tue");

		const after = "# Mon\n- [ ] follow up with client\n# Something Else Entirely\n- [ ] follow up with client";
		const candidates = anchorsFrom(after);

		const tueScore = similarityModule.similarity("tue", "something else entirely");
		expect(tueScore).toBeLessThan(0.4); // sanity: Tue no longer matches at all

		const monTask = indexOfAnchor(candidates, (a) => a.kind === "task" && a.parentChain[0]?.text === "mon");
		expect(candidates[monTask].text).toBe(stored.text); // sanity: a genuine decoy, not the real match

		const results = await matchAnchors([stored], candidates);
		expect(results[0]).toEqual({ tier: "none", reason: "ambiguous" });
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

	});
});

describe("C14/C20: the parent chain separates a text tie only when it itself differs", () => {
	it("two candidates tied on text score are separated by whichever parent chain reads closer", async () => {
		// The stored anchor's own parent ("Tuesday") is mocked to never resolve at the ancestor
		// level (kept clearly below the positional bar for every heading candidate), so its
		// scope stays file-wide — both same-text candidates remain in the pool, genuinely tied
		// at the task level, and only the parent-chain tiebreak (not ancestor scoping) decides.
		vi.spyOn(similarityModule, "similarity").mockImplementation((a, b) => {
			// Chain-tiebreak calls use the "kind:text" format `chainText` builds: let "Tuesday
			// Morning"'s chain read far closer to the stored anchor's old parent than "Giraffe"'s.
			if (/^[a-z]+:/.test(a) && /^[a-z]+:/.test(b)) {
				return a.includes("tuesday morning") || b.includes("tuesday morning") ? 0.9 : 0.1;
			}
			// Ancestor-level resolution for "tuesday" against each heading candidate: force it
			// below the positional bar every time, so Tuesday's children pool stays file-wide.
			if (a === "tuesday" || b === "tuesday") return 0.1;
			// Leaf-level: the two same-text task candidates both tie at a high score.
			return 0.9;
		});
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

		// Sanity: the two tied candidates really do share one identical text.
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

	it("a reverse-direction claim with a clear (non-tied) winner needs no tiebreak at all", async () => {
		// Two anchors under different (now-renamed) parents fall back file-wide and are both
		// tier-2-eligible for the one shared candidate, but with clearly different (non-tied)
		// scores — pickWinner should take the stronger claimant outright (breakTieByChain's
		// own single-item short-circuit, never reaching its tie-separation logic at all).
		vi.spyOn(similarityModule, "similarity").mockImplementation((a, b) => {
			if (a === "wants it strongly" && b === "the shared candidate") return 0.9;
			if (a === "wants it weakly" && b === "the shared candidate") return 0.6;
			return 0.9;
		});
		const stored = anchorsFrom("# P1\n\t- [ ] wants it strongly\n# P2\n\t- [ ] wants it weakly").filter(
			(a) => a.kind === "task",
		);
		const candidates = anchorsFrom("# Elsewhere\n\t- [ ] the shared candidate");

		const results = await matchAnchors(stored, candidates);
		const target = indexOfAnchor(candidates, (a) => a.kind === "task");
		expect(results[0]).toEqual({ tier: "positional", target }); // the stronger claimant wins
		expect(results[1]).toEqual({ tier: "none", reason: "no-candidate" }); // nothing else left

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

	});
});

describe("Comparison memoization: a pair re-examined across deferred-acceptance passes is cached", () => {
	it("an anchor that loses its contest and retries the same unconsumed candidate hits the memo, not similarity() again", async () => {
		// t1 and t2 both prefer the shared candidate ca (tied -> stays unresolved every pass);
		// t3 cleanly wins cb in pass 1, which is the only reason there's a pass 2 at all. In
		// pass 2, t1 and t2 re-score against ca — a pair already computed in pass 1 — which
		// must come from the memo, not a fresh similarity() call.
		const table: Record<string, number> = {
			"t1|ca": 0.9,
			"t1|cb": 0.7,
			"t2|ca": 0.9,
			"t2|cb": 0.1,
			"t3|ca": 0.1,
			"t3|cb": 0.8,
		};
		const spy = vi.spyOn(similarityModule, "similarity").mockImplementation((a, b) => table[`${a}|${b}`] ?? 0.05);

		const stored = anchorsFrom("# P1\n\t- [ ] t1\n# P2\n\t- [ ] t2\n# P3\n\t- [ ] t3").filter((a) => a.kind === "task");
		const candidates = anchorsFrom("# X1\n\t- [ ] ca\n# X2\n\t- [ ] cb").filter((a) => a.kind === "task");

		const results = await matchAnchors(stored, candidates);

		expect(results[0]).toEqual({ tier: "none", reason: "ambiguous" }); // t1: tied for ca, every pass
		expect(results[1]).toEqual({ tier: "none", reason: "ambiguous" }); // t2: tied for ca, every pass
		expect(results[2]).toEqual({ tier: "positional", target: 1 }); // t3: wins cb cleanly in pass 1

		// Each distinct comparison is only ever actually computed once, however many passes
		// re-examine it: 6 distinct (anchor, candidate) text pairs (t1/t2/t3 each against ca and
		// cb), plus the 2 distinct chain-tiebreak pairs of the ca contest (R12: the tiebreak goes
		// through the same memoized budget, so pass 2's repeat of it is free). 6 + 2 = 8, not
		// 6 + 4 = 10 (tiebreak unmemoized) and not 6 + 6 = 12 (nothing memoized).
		expect(spy.mock.calls.length).toBe(8);

	});
});

describe("R15 (PR-4): the C14/C20 parent-chain tiebreak with real similarity() — nothing mocked", () => {
	it("two equally good children are separated by how well their parent chains read, using real text", async () => {
		// The stored task sat under `# Weekly review`. Neither new parent is close enough to
		// resolve as that parent (real similarity: 0.30 and 0.08, under the 0.4 bar), so the
		// child falls back to a file-wide search and finds two children tied on text. Only the
		// parent *chains* differ: "heading:weekly planning and review of the quarter" reads closer
		// to "heading:weekly review" (0.36) than "heading:garden" does (0.24), so it must win.
		const stored = anchorsFrom("# Weekly review\n\t- [ ] send report now").filter((a) => a.kind === "task");
		const candidates = anchorsFrom(
			"# Garden\n\t- [ ] send report soon\n# Weekly planning and review of the quarter\n\t- [ ] send report soon",
		);
		const wanted = candidates.findIndex((a) => a.kind === "task" && a.parentChain[0]?.text.startsWith("weekly planning"));
		expect(wanted).toBeGreaterThan(-1);

		const results = await matchAnchors(stored, candidates);
		expect(results[0]).toEqual({ tier: "positional", target: wanted });
	});
});

describe("R14 (PR-4): one candidate is never claimed by two stored anchors (C9) in the exact tier", () => {
	function targets(results: Awaited<ReturnType<typeof matchAnchors>>): number[] {
		return results.flatMap((r) => (r.tier === "none" ? [] : [r.target]));
	}

	it("repro A: a fallback-scope anchor yields the candidate to the anchor whose parent really matched", async () => {
		const stored = anchorsFrom("# Alpha\n- [ ] x\n# Beta\n- [ ] x").filter((a) => a.kind === "task");
		const candidates = anchorsFrom("# Something entirely different\n# Beta\n- [ ] x");
		const xIndex = candidates.findIndex((a) => a.kind === "task");

		const results = await matchAnchors(stored, candidates);
		expect(results[1]).toEqual({ tier: "exact", target: xIndex }); // Beta's own x
		expect(results[0].tier).toBe("none"); // Alpha's x does not also map to it
		expect(new Set(targets(results)).size).toBe(targets(results).length);
	});

	it("repro B: a candidate under a renamed-match parent goes to the anchor with identical ancestry", async () => {
		const stored = anchorsFrom("# Home\n- [ ] x\n# Home base\n- [ ] x").filter((a) => a.kind === "task");
		const candidates = anchorsFrom("# Home base\n- [ ] x");
		const xIndex = candidates.findIndex((a) => a.kind === "task");

		const results = await matchAnchors(stored, candidates);
		expect(results[1]).toEqual({ tier: "exact", target: xIndex }); // `Home base > x` is identical
		expect(results[0].tier).toBe("none");
		expect(new Set(targets(results)).size).toBe(targets(results).length);
	});

	it("two anchors tied for the same best-fit candidate both come back ambiguous and the candidate stays unclaimed", async () => {
		// Both stored `x` anchors have a parent (`# Home one`, `# Home two`) that no candidate
		// parent equals; each resolves to the single `# Home` candidate by similarity, so both
		// are real-scope with the same (different-from-the-candidate) ancestry rank.
		const stored = anchorsFrom("# Home one\n- [ ] x\n# Home two\n- [ ] x").filter((a) => a.kind === "task");
		const candidates = anchorsFrom("# Home\n- [ ] x");

		const results = await matchAnchors(stored, candidates);
		const claimed = targets(results);
		expect(new Set(claimed).size).toBe(claimed.length); // never the same target twice
		expect(claimed.length).toBeLessThanOrEqual(1);
	});
});
