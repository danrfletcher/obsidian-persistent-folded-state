/**
 * src/embed-rematch.ts (ticket warkworth-21, PR-6): the pure re-match planner. Table-driven over
 * the tier rules (G3), ambiguity and tie rules (E2), the one-stored-anchor-per-block rule, the
 * 500-fold cap and the shared 5,000-comparison host budget (E7). Anchors are built with the real
 * extractor through tests/fixtures/matcher/build-anchors.ts. The boundary rows pin the similarity
 * score with a spy on `similarity.ts`, as tests/unit/matcher-tiers.test.ts does, so they are
 * about the thresholds and not about how two crafted strings happen to score.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnchors } from "../../src/anchors";
import type { Anchor } from "../../src/anchors";
import { HostComparisonBudget, planEmbedRematch } from "../../src/embed-rematch";
import type { RematchInput } from "../../src/embed-rematch";
import { hashText } from "../../src/fold-store";
import { FUZZY_THRESHOLD_LONG, FUZZY_THRESHOLD_SHORT, MAX_COMPARISONS, MAX_FOLDS, POSITIONAL_THRESHOLD, SHORT_LONG_SPLIT } from "../../src/matcher";
import * as similarityModule from "../../src/similarity";
import { anchorsFrom } from "../fixtures/matcher/build-anchors";

afterEach(() => {
	vi.restoreAllMocks();
});

const tasks = (labels: string[]): string => labels.map((label) => `- [ ] ${label}`).join("\n");

/** An input for a slice that changed: the record's hash is of `oldText`, the slice is `newText`. */
function changed(oldText: string, newText: string, pick: (anchors: Anchor[]) => Anchor[] = (a) => a, budget = new HostComparisonBudget()): RematchInput {
	return {
		stored: pick(anchorsFrom(oldText)),
		storedHash: hashText(oldText),
		sliceHash: hashText(newText),
		candidates: buildAnchors(newText),
		budget,
		yieldToHost: () => undefined,
	};
}

describe("G3: the tiers and thresholds are the matcher's own", () => {
	it("re-exports nothing of its own: the constants the rows below use are the matcher's", () => {
		expect([POSITIONAL_THRESHOLD, FUZZY_THRESHOLD_LONG, FUZZY_THRESHOLD_SHORT, SHORT_LONG_SPLIT]).toEqual([0.4, 0.6, 0.8, 20]);
	});

	it("exact: identical normalized text places the fold with no similarity comparison", async () => {
		const spy = vi.spyOn(similarityModule, "similarity");
		const out = await planEmbedRematch(changed(tasks(["Draft proposal"]), tasks(["draft **proposal**"])));
		expect(out.matches).toEqual([{ tier: "exact", target: 0 }]);
		expect(out.comparisons).toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});

	it.each([
		[POSITIONAL_THRESHOLD - 0.01, "none"],
		[POSITIONAL_THRESHOLD, "positional"],
		[POSITIONAL_THRESHOLD + 0.01, "positional"],
	])("positional (same sibling index and indent): similarity %s -> %s", async (score, tier) => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(score);
		const out = await planEmbedRematch(changed(tasks(["alpha"]), tasks(["alpha renamed"])));
		expect(out.matches[0].tier).toBe(tier);
		expect(out.update !== null).toBe(tier === "positional");
		expect(out.comparisons).toBe(1);
	});

	// The stored anchor is the 2nd task (sibling index 1); the slice holds only one task (index 0), so
	// the only candidate is at a changed position: the fuzzy tier, whose bar depends on line length.
	const LONG = "a line that is long enough to count"; // 20 characters or more
	const SHORT = "a short line"; // fewer than 20
	it.each([
		[LONG, FUZZY_THRESHOLD_LONG - 0.01, "none"],
		[LONG, FUZZY_THRESHOLD_LONG, "fuzzy"],
		[SHORT, FUZZY_THRESHOLD_SHORT - 0.01, "none"],
		[SHORT, FUZZY_THRESHOLD_SHORT, "fuzzy"],
		[SHORT, FUZZY_THRESHOLD_LONG, "none"],
	])("fuzzy on %j: similarity %s -> %s", async (line, score, tier) => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(score);
		const input = changed(tasks(["first", line]), tasks([`${line} edited`]), (a) => [a[1]]);
		expect(input.stored[0].siblingIndex).toBe(1);
		const out = await planEmbedRematch(input);
		expect(out.matches[0].tier).toBe(tier);
		expect(out.update !== null).toBe(tier === "fuzzy");
	});

	it("a below-threshold or unmatched fold places nothing and writes nothing (F6, G16)", async () => {
		const out = await planEmbedRematch(changed(tasks(["alpha"]), tasks(["entirely different words here"])));
		expect(out.matches).toEqual([{ tier: "none", reason: "below-threshold" }]);
		expect(out.update).toBeNull();
	});

	it("candidates come from the slice given, not from anywhere else: a block that is not in it is never placed", async () => {
		const stored = anchorsFrom(tasks(["Lesson 8: Collections"]));
		const out = await planEmbedRematch({ ...changed("x", "y"), stored, candidates: buildAnchors(tasks(["Lesson 9: Graphs"])) });
		expect(out.matches[0].tier).toBe("none");
	});
});

describe("E2: ties fold nothing", () => {
	it("forward: one stored anchor, two candidates scoring the same -> neither is taken", async () => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.9);
		const out = await planEmbedRematch(changed(tasks(["a", "b", "review chapter"]), tasks(["review chapter one", "review chapter two"]), (a) => [a[2]]));
		expect(out.matches).toEqual([{ tier: "none", reason: "ambiguous" }]);
		expect(out.update).toBeNull();
	});

	it("reverse: two stored anchors tied for one candidate -> neither takes it", async () => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.9);
		const out = await planEmbedRematch(changed(tasks(["a", "b", "review one", "review two"]), tasks(["review"]), (a) => [a[2], a[3]]));
		expect(out.matches).toEqual([
			{ tier: "none", reason: "ambiguous" },
			{ tier: "none", reason: "ambiguous" },
		]);
		expect(out.update).toBeNull();
	});

	it("one stored anchor per block: of two anchors wanting one candidate the better score takes it, the other gets nothing", async () => {
		vi.spyOn(similarityModule, "similarity").mockImplementation((a) => (a === "review one" ? 0.9 : 0.7));
		const out = await planEmbedRematch(changed(tasks(["a", "b", "review one", "review two"]), tasks(["review"]), (a) => [a[2], a[3]]));
		expect(out.matches[0]).toEqual({ tier: "fuzzy", target: 0 });
		expect(out.matches[1].tier).toBe("none");
		const taken = out.matches.filter((m) => m.tier !== "none");
		expect(taken).toHaveLength(1);
	});
});

describe("G4: the same slice re-applies the stored set without the matcher", () => {
	const text = "- [ ] Lesson 8\n  - [ ] child\n- [ ] Lesson 9\n  - [ ] other child";

	it("same hash and every stored anchor in the slice: placed as they are, matcher not run, nothing to write", async () => {
		const spy = vi.spyOn(similarityModule, "similarity");
		const out = await planEmbedRematch({
			stored: anchorsFrom(text).filter((a) => a.text.startsWith("lesson")),
			storedHash: hashText(text),
			sliceHash: hashText(text),
			candidates: buildAnchors(text),
			budget: new HostComparisonBudget(0), // no budget at all: it must not be needed
			yieldToHost: () => undefined,
		});
		expect(out.usedMatcher).toBe(false);
		expect(out.matches).toEqual([
			{ tier: "exact", target: 0 },
			{ tier: "exact", target: 2 },
		]);
		expect(out.update).toBeNull();
		expect(out.comparisons).toBe(0);
		expect(spy).not.toHaveBeenCalled();
	});

	it("same hash but a stored anchor is not in the slice (the record and the slice disagree): the matcher decides", async () => {
		const out = await planEmbedRematch({
			stored: anchorsFrom("- [ ] Lesson 8 old\n  - [ ] child"),
			storedHash: hashText(text),
			sliceHash: hashText(text),
			candidates: buildAnchors(text),
			budget: new HostComparisonBudget(),
			yieldToHost: () => undefined,
		});
		expect(out.usedMatcher).toBe(true);
	});

	it("a different hash runs the matcher even when every anchor would be found", async () => {
		const out = await planEmbedRematch({ ...changed(text, text + "\n"), stored: anchorsFrom(text).slice(0, 1) });
		expect(out.usedMatcher).toBe(true);
	});

	it("an embed with no stored folds plans nothing and writes nothing", async () => {
		const out = await planEmbedRematch({ ...changed(text, "other"), stored: [] });
		expect(out).toEqual({ matches: [], usedMatcher: false, comparisons: 0, budgetExhausted: false, foldsOverCap: 0, update: null });
	});
});

describe("G3/G4: the record after a successful re-match", () => {
	it("a placed anchor is replaced by its block's current anchor and the hash is the new slice's", async () => {
		const oldText = tasks(["Lesson 8: Collections and frequency counting"]);
		const newText = tasks(["Lesson 8 (revised): Collections and frequency counting"]);
		const out = await planEmbedRematch(changed(oldText, newText));
		expect(out.matches[0]).toEqual({ tier: "positional", target: 0 });
		expect(out.update).toEqual({ folds: anchorsFrom(newText), contentHash: hashText(newText) });
	});

	it("a second edit then matches against the latest state (the update fed back in)", async () => {
		const v1 = tasks(["Lesson 8: Collections and frequency counting"]);
		const v2 = tasks(["Lesson 8 (revised): Collections and frequency counting"]);
		const v3 = tasks(["Lesson 8 (revised twice): Collections and frequency counting"]);
		const first = await planEmbedRematch(changed(v1, v2));
		const second = await planEmbedRematch({ ...changed(v2, v3), stored: first.update?.folds ?? [], storedHash: first.update?.contentHash });
		expect(second.matches[0].tier).toBe("positional");
		expect(second.update?.folds).toEqual(anchorsFrom(v3));
	});

	it("an anchor with no confident match is kept exactly as stored, beside the ones that matched", async () => {
		const oldText = tasks(["keep this one", "this one will vanish entirely"]);
		const newText = tasks(["keep this one", "zzz"]);
		const stored = anchorsFrom(oldText);
		const out = await planEmbedRematch(changed(oldText, newText));
		expect(out.matches.map((m) => m.tier)).toEqual(["exact", "none"]);
		expect(out.update?.folds).toEqual([anchorsFrom(newText)[0], stored[1]]);
	});

	it("nothing placed: no update", async () => {
		const out = await planEmbedRematch(changed(tasks(["alpha"]), tasks(["completely unrelated text"])));
		expect(out.update).toBeNull();
	});

	it("only blocks that had a stored fold are in the update (G16): a new block in the slice is never added", async () => {
		const out = await planEmbedRematch(changed(tasks(["alpha"]), tasks(["alpha", "brand new block"])));
		expect(out.update?.folds).toHaveLength(1);
		expect(out.update?.folds[0].text).toBe("alpha");
	});
});

describe("E7: at most 500 folds are placed per embed", () => {
	const headings = (n: number, suffix = ""): string => Array.from({ length: n }, (_, i) => `## Heading ${i + 1}${suffix}\nbody ${i + 1}`).join("\n");

	const onlyHeadings = (anchors: Anchor[]): Anchor[] => anchors.filter((a) => a.kind === "heading");

	it("MAX_FOLDS is 500", () => {
		expect(MAX_FOLDS).toBe(500);
	});

	it("600 stored folds: the first 500 are placed, the other 100 are capped, kept in the update untouched and not applied", async () => {
		const oldText = headings(600);
		const newText = headings(600) + "\n\nnew trailing paragraph";
		const input = changed(oldText, newText, onlyHeadings);
		expect(input.stored).toHaveLength(600);
		const out = await planEmbedRematch(input);
		expect(out.matches.slice(0, 500).every((m) => m.tier === "exact")).toBe(true);
		expect(out.matches.slice(500)).toEqual(Array.from({ length: 100 }, () => ({ tier: "none", reason: "capped" })));
		expect(out.foldsOverCap).toBe(100);
		expect(out.budgetExhausted).toBe(false); // the fold cap is not the comparison budget
		expect(out.update?.folds).toHaveLength(600);
		expect(out.update?.folds.slice(500)).toEqual(input.stored.slice(500));
	});

	it("the same cap holds on the same-slice path", async () => {
		const text = headings(600);
		const out = await planEmbedRematch(changed(text, text, onlyHeadings));
		expect(out.usedMatcher).toBe(false);
		expect(out.matches.filter((m) => m.tier === "exact")).toHaveLength(500);
		expect(out.foldsOverCap).toBe(100);
	});
});

describe("E7: 5,000 comparisons per host per render pass, shared by every embed", () => {
	/** An embed of `n` reworded tasks: one positional comparison each. */
	const reworded = (n: number): [string, string] => [
		tasks(Array.from({ length: n }, (_, i) => `task number ${i} original`)),
		tasks(Array.from({ length: n }, (_, i) => `task number ${i} reworded`)),
	];

	it("MAX_COMPARISONS is 5,000 and a new budget holds all of it", () => {
		expect(MAX_COMPARISONS).toBe(5000);
		expect(new HostComparisonBudget().remaining).toBe(5000);
	});

	it("each embed is charged exactly the comparisons it made, and the next one gets what is left", async () => {
		const budget = new HostComparisonBudget(10);
		const [oldText, newText] = reworded(6);
		const a = await planEmbedRematch(changed(oldText, newText, undefined, budget));
		expect(a.comparisons).toBe(6);
		expect(budget.remaining).toBe(4);
		const b = await planEmbedRematch(changed(oldText, newText, undefined, budget));
		expect(b.comparisons).toBe(4);
		expect(b.budgetExhausted).toBe(true);
		expect(b.matches.filter((m) => m.tier === "positional")).toHaveLength(4);
		expect(b.matches.filter((m) => m.tier === "none" && m.reason === "capped")).toHaveLength(2);
		expect(budget.remaining).toBe(0);
	});

	it("an embed that runs out of budget gets no record update: its stored folds are kept, not forgotten", async () => {
		const budget = new HostComparisonBudget(2);
		const [oldText, newText] = reworded(6);
		const out = await planEmbedRematch(changed(oldText, newText, undefined, budget));
		expect(out.budgetExhausted).toBe(true);
		expect(out.update).toBeNull();
	});

	it("an embed with no budget left still places what needs no comparison (exact text)", async () => {
		const budget = new HostComparisonBudget(0);
		const out = await planEmbedRematch(changed(tasks(["same text"]), tasks(["same text", "added"]), undefined, budget));
		expect(out.matches).toEqual([{ tier: "exact", target: 0 }]);
		expect(out.budgetExhausted).toBe(false);
	});

	it("51 embeds of 200 comparisons each share 5,000 between them (run one after another)", async () => {
		const budget = new HostComparisonBudget();
		const [oldText, newText] = reworded(200);
		let total = 0;
		const outcomes = [];
		for (let i = 0; i < 51; i++) {
			const out = await planEmbedRematch(changed(oldText, newText, undefined, budget));
			total += out.comparisons;
			outcomes.push(out);
		}
		expect(total).toBe(5000); // not 51 x 200 = 10,200, and not 51 x 5,000
		expect(budget.remaining).toBe(0);
		expect(outcomes.slice(0, 25).every((o) => !o.budgetExhausted)).toBe(true); // 25 x 200 = 5,000
		expect(outcomes.slice(25).every((o) => o.budgetExhausted && o.comparisons === 0 && o.update === null)).toBe(true);
	});

	it("embeds matching at the same time cannot overspend: the budget serialises them", async () => {
		const budget = new HostComparisonBudget();
		const [oldText, newText] = reworded(200);
		const outcomes = await Promise.all(Array.from({ length: 51 }, () => planEmbedRematch(changed(oldText, newText, undefined, budget))));
		expect(outcomes.reduce((sum, o) => sum + o.comparisons, 0)).toBe(5000);
		expect(budget.remaining).toBe(0);
	});

	it("a task that throws does not stop the embeds queued behind it", async () => {
		const budget = new HostComparisonBudget();
		await expect(budget.exclusive(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		await expect(budget.exclusive(async () => "next")).resolves.toBe("next");
	});
});

describe("E7: comparisons are made in yielded chunks", () => {
	it("yields to the host every CHUNK_SIZE (250) comparisons", async () => {
		const [oldText, newText] = [
			tasks(Array.from({ length: 600 }, (_, i) => `task number ${i} original`)),
			tasks(Array.from({ length: 600 }, (_, i) => `task number ${i} reworded`)),
		];
		let yields = 0;
		const input = changed(oldText, newText);
		const out = await planEmbedRematch({ ...input, yieldToHost: () => void yields++ });
		expect(out.comparisons).toBe(500); // the fold cap: 500 of the 600 are processed
		expect(yields).toBe(2); // after the 250th and the 500th comparison
	});

	it("the chunk size is the matcher's, and the hook it is handed is the one awaited", async () => {
		const [oldText, newText] = [tasks(["a one", "b two", "c three", "d four"]), tasks(["a one!", "b two!", "c three!", "d four!"])];
		let yields = 0;
		const out = await planEmbedRematch({
			...changed(oldText, newText),
			matcherOptions: { chunkSize: 2, yieldToHost: () => void yields++ },
		});
		expect(out.comparisons).toBe(4);
		expect(yields).toBe(2);
	});
});
