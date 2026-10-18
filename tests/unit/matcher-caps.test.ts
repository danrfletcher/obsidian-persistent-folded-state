/**
 * src/matcher.ts: E6 fold cap, comparison cap, yielding (C21-C23, C28), plus the added edge
 * cases that don't have a more specific home — empty stored/candidates, a normalized-empty line,
 * and 200-run shuffle determinism with no candidate reused (C24, C25 second half).
 */
import { describe, expect, it, vi } from "vitest";
import * as similarityModule from "../../src/similarity";
import { matchAnchors } from "../../src/matcher";
import { anchorsFrom } from "../fixtures/matcher/build-anchors";

function tasksMarkdown(labels: string[]): string {
	return labels.map((label) => `- [ ] ${label}`).join("\n");
}

describe("E6 C21: at most maxFolds stored anchors are processed, in stored order", () => {
	it("the rest return none/capped without ever entering a tier", async () => {
		const labels = Array.from({ length: 10 }, (_, i) => `distinct task ${i}`);
		const stored = anchorsFrom(tasksMarkdown(labels));
		const candidates = anchorsFrom(tasksMarkdown(labels)); // every one has an exact match

		const results = await matchAnchors(stored, candidates, { maxFolds: 3 });

		for (let i = 0; i < 3; i++) expect(results[i].tier).toBe("exact");
		for (let i = 3; i < 10; i++) expect(results[i]).toEqual({ tier: "none", reason: "capped" });
	});

	it("MAX_FOLDS defaults to 500", async () => {
		const { MAX_FOLDS } = await import("../../src/matcher");
		expect(MAX_FOLDS).toBe(500);
	});
});

describe("E6 C22: at most maxComparisons similarity() calls per run", () => {
	it("tier 1 lookups don't count, only tiers 2/3 do; capped folds are never reported as matched", async () => {
		// 10 top-level tasks, each with its own distinct, slightly-reworded candidate at the
		// same sibling index — one tier-2 comparison per anchor, 10 possible in total.
		const storedLabels = Array.from({ length: 10 }, (_, i) => `task number ${i} changed`);
		const candidateLabels = Array.from({ length: 10 }, (_, i) => `task number ${i}`);
		const stored = anchorsFrom(tasksMarkdown(storedLabels));
		const candidates = anchorsFrom(tasksMarkdown(candidateLabels));

		const spy = vi.spyOn(similarityModule, "similarity"); // real implementation, just counted

		const results = await matchAnchors(stored, candidates, { maxComparisons: 3 });

		expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
		expect(spy.mock.calls.length).toBe(3); // the cap is reached, not merely respected
		for (let i = 0; i < 3; i++) expect(results[i]).toEqual({ tier: "positional", target: i }); // earlier matches kept
		for (let i = 3; i < 10; i++) expect(results[i]).toEqual({ tier: "none", reason: "capped" });

		vi.restoreAllMocks();
	});

	it("lowering the caps through options never reports a capped fold as matched", async () => {
		const storedLabels = Array.from({ length: 5 }, (_, i) => `another task ${i} changed`);
		const candidateLabels = Array.from({ length: 5 }, (_, i) => `another task ${i}`);
		const stored = anchorsFrom(tasksMarkdown(storedLabels));
		const candidates = anchorsFrom(tasksMarkdown(candidateLabels));

		const results = await matchAnchors(stored, candidates, { maxComparisons: 0 });
		for (const result of results) {
			expect(result.tier).toBe("none");
			expect("target" in result).toBe(false);
		}
	});

	it("MAX_COMPARISONS defaults to 5000", async () => {
		const { MAX_COMPARISONS } = await import("../../src/matcher");
		expect(MAX_COMPARISONS).toBe(5000);
	});
});

describe("E6 C23: matchAnchors is async and yields through an injected yieldToHost", () => {
	it("returns a Promise", () => {
		const result = matchAnchors([], []);
		expect(result).toBeInstanceOf(Promise);
	});

	it("awaits yieldToHost at least every chunkSize comparisons, more than once over enough comparisons", async () => {
		const storedLabels = Array.from({ length: 10 }, (_, i) => `yield task ${i} changed`);
		const candidateLabels = Array.from({ length: 10 }, (_, i) => `yield task ${i}`);
		const stored = anchorsFrom(tasksMarkdown(storedLabels));
		const candidates = anchorsFrom(tasksMarkdown(candidateLabels));

		let yieldCalls = 0;
		const fakeYield = () => {
			yieldCalls++;
		};

		await matchAnchors(stored, candidates, { chunkSize: 2, yieldToHost: fakeYield });

		// 10 comparisons at chunkSize 2 -> a yield after every 2nd, i.e. 5 times.
		expect(yieldCalls).toBe(5);
		expect(yieldCalls).toBeGreaterThan(1);
	});

	it("CHUNK_SIZE defaults to 250", async () => {
		const { CHUNK_SIZE } = await import("../../src/matcher");
		expect(CHUNK_SIZE).toBe(250);
	});
});

describe("Added edge cases (C24): empty stored, empty candidates, both empty", () => {
	it("empty stored returns [] and never throws", async () => {
		await expect(matchAnchors([], anchorsFrom("- [ ] something"))).resolves.toEqual([]);
	});

	it("empty candidates returns one none/no-candidate result per stored anchor and never throws", async () => {
		const stored = anchorsFrom("- [ ] a\n- [ ] b");
		await expect(matchAnchors(stored, [])).resolves.toEqual([
			{ tier: "none", reason: "no-candidate" },
			{ tier: "none", reason: "no-candidate" },
		]);
	});

	it("both empty returns [] and never throws", async () => {
		await expect(matchAnchors([], [])).resolves.toEqual([]);
	});

	it("a normalized-empty line matches only an identical empty candidate", async () => {
		const stored = anchorsFrom("- [ ]"); // normalizes to text ""
		const candidates = anchorsFrom("- [ ]\n- [ ] something");
		const results = await matchAnchors(stored, candidates);
		expect(results[0]).toEqual({ tier: "exact", target: 0 });
	});

	it("a normalized-empty line is never fuzzy-matched to a non-empty candidate", async () => {
		// similarity("", nonEmpty) is defined to be exactly 0 — below every bar — so an empty
		// stored line can never clear tier 2 or tier 3 against any non-empty candidate.
		const stored = anchorsFrom("- [ ]");
		const candidates = anchorsFrom("- [ ] a\n- [ ] b");
		const results = await matchAnchors(stored, candidates);
		expect(results[0].tier).toBe("none");
	});
});

describe("Added edge cases (C25): 200-run seeded shuffle gives a stable result, one candidate each", () => {
	it("the same content mapping holds under 200 reorderings of the candidate list, with no candidate reused", async () => {
		const storedLabels = Array.from({ length: 10 }, (_, i) => `shuffle fixture task ${i}`);
		const decoyLabels = Array.from({ length: 5 }, (_, i) => `shuffle fixture decoy ${i}`);
		const stored = anchorsFrom(tasksMarkdown(storedLabels));
		const baseCandidates = anchorsFrom(tasksMarkdown([...storedLabels, ...decoyLabels]));

		// A small seeded LCG — deterministic across runs/machines, no external dependency.
		let seed = 42;
		function nextRandom(): number {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		}
		function shuffled<T>(items: T[]): T[] {
			const copy = [...items];
			for (let i = copy.length - 1; i > 0; i--) {
				const j = Math.floor(nextRandom() * (i + 1));
				[copy[i], copy[j]] = [copy[j], copy[i]];
			}
			return copy;
		}

		for (let run = 0; run < 200; run++) {
			const candidates = shuffled(baseCandidates);
			const results = await matchAnchors(stored, candidates);

			const usedTargets = new Set<number>();
			for (let i = 0; i < stored.length; i++) {
				const result = results[i];
				expect(result.tier).toBe("exact"); // exact text match is content-identity, not index
				if (result.tier !== "none") {
					expect(candidates[result.target].text).toBe(stored[i].text); // content-stable
					expect(usedTargets.has(result.target)).toBe(false); // never reused this run
					usedTargets.add(result.target);
				}
			}
		}
	});
});
