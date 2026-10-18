/**
 * src/restore-plan.ts: the pure planning step, table-driven over the acceptance items that are
 * purely about "given a match, do we fold it, defer it, or leave it out" — G2, G3, G13, E3, E6
 * and F4's "never fold an absent block" rule — plus the ordering guarantee G14's wiring note
 * depends on. Fixtures are small documents (string pairs: `before`/`after`) run through the real
 * `buildAnchors` for candidates, but the matcher's own output is stubbed by hand per the PR-5
 * brief ("matcher output stubbed") — this file is about what `planRestore` does with a decision,
 * not about re-proving the matcher itself (that's tests/unit/matcher-*.test.ts).
 *
 * `buildAnchors` turns *every* non-blank line into some kind of anchor (plain paragraph text
 * included, kind "other") — so `matches` must always carry one entry per `stored` anchor, not
 * just the one under test. `matchesFor` builds that full-length array, defaulting every anchor
 * to "no-candidate" except the ones explicitly given.
 */
import { describe, expect, it } from "vitest";
import { buildAnchors, type Anchor, type AnchoredBlock } from "../../src/anchors";
import type { MatchResult } from "../../src/matcher";
import { planRestore, type RestorePlanInput } from "../../src/restore-plan";

function candidatesFrom(markdown: string): AnchoredBlock[] {
	return buildAnchors(markdown);
}

function storedFrom(markdown: string): Anchor[] {
	return buildAnchors(markdown).map((b) => b.anchor);
}

/** One `MatchResult` per `stored` anchor; every index not named in `given` defaults to
 * "no-candidate" (the matcher's own catch-all for "found nothing"). */
function matchesFor(stored: Anchor[], given: Record<number, MatchResult>): MatchResult[] {
	return stored.map((_, i) => given[i] ?? { tier: "none", reason: "no-candidate" });
}

function baseInput(overrides: Partial<RestorePlanInput> & Pick<RestorePlanInput, "stored" | "matches" | "candidates">): RestorePlanInput {
	return {
		alreadyFolded: [],
		cursorLine: null,
		liveAnchorKeys: null,
		...overrides,
	};
}

describe("planRestore: G2 — external edit above/below a fold, anchor text untouched", () => {
	const before = "## Tuesday\nbody line";

	it("4 lines inserted above: the match still folds the heading's current (shifted) range", () => {
		const after = "intro 1\nintro 2\nintro 3\nintro 4\n## Tuesday\nbody line";
		const stored = storedFrom(before);
		const candidates = candidatesFrom(after);
		// candidates: [other, other, other, other, heading, other] — the heading is index 4.
		const headingCandidateIndex = candidates.findIndex((c) => c.anchor.kind === "heading");
		const matches = matchesFor(stored, { 0: { tier: "exact", target: headingCandidateIndex } });

		const plan = planRestore(baseInput({ stored, matches, candidates }));
		expect(plan.toFold).toEqual([{ anchorIndex: 0, range: candidates[headingCandidateIndex].range }]);
		expect(plan.deferred).toEqual([]);
	});

	it("lines deleted below the fold: still matched and folded", () => {
		const after = "## Tuesday\nbody line";
		const stored = storedFrom(before);
		const candidates = candidatesFrom(after);
		const matches = matchesFor(stored, { 0: { tier: "exact", target: 0 } });

		const plan = planRestore(baseInput({ stored, matches, candidates }));
		expect(plan.toFold).toHaveLength(1);
		expect(plan.toFold[0]).toEqual({ anchorIndex: 0, range: candidates[0].range });
	});

	it("a change in line count elsewhere in the file doesn't block the fold", () => {
		const after = "## Tuesday\nbody line one\nbody line two\nbody line three\nbody line four";
		const stored = storedFrom(before);
		const candidates = candidatesFrom(after);
		const matches = matchesFor(stored, { 0: { tier: "exact", target: 0 } });

		const plan = planRestore(baseInput({ stored, matches, candidates }));
		expect(plan.toFold).toEqual([{ anchorIndex: 0, range: candidates[0].range }]);
	});
});

describe("planRestore: G3 — external edit inside the folded body (children added/removed/edited)", () => {
	const before = ["- [ ] Draft proposal", "\t- [ ] Outline", "\t- [ ] Draft", "\t- [ ] Review"].join("\n");
	const after = ["- [ ] Draft proposal v2", "\t- [x] Outline", "\t- [ ] Draft", "\t- [ ] Review"].join("\n");

	it("the fold stays on the parent task even though its children changed", () => {
		const stored = storedFrom(before);
		const candidates = candidatesFrom(after);
		// Fuzzy match on the reworded parent task (siblingIndex/kind both still line up); its
		// stored index is 0 (the first — and here only top-level — anchor).
		const matches = matchesFor(stored, { 0: { tier: "fuzzy", target: 0 } });

		const plan = planRestore(baseInput({ stored, matches, candidates }));
		expect(plan.toFold).toEqual([{ anchorIndex: 0, range: candidates[0].range }]);
	});
});

describe("planRestore: G13 — cursor inside a block that would be re-folded", () => {
	const before = "## Tuesday\nbody line";

	it("defers instead of folding when the cursor sits inside the matched range", () => {
		const stored = storedFrom(before);
		const candidates = candidatesFrom(before);
		const range = candidates[0].range;
		const matches = matchesFor(stored, { 0: { tier: "exact", target: 0 } });

		const plan = planRestore(baseInput({ stored, matches, candidates, cursorLine: range.startLine + 1 }));
		expect(plan.toFold).toEqual([]);
		expect(plan.deferred).toEqual([{ anchorIndex: 0, range }]);
	});

	it("folds normally once the cursor is outside the range", () => {
		const stored = storedFrom(before);
		const candidates = candidatesFrom(before);
		const range = candidates[0].range;
		const matches = matchesFor(stored, { 0: { tier: "exact", target: 0 } });

		const plan = planRestore(baseInput({ stored, matches, candidates, cursorLine: range.endLine + 5 }));
		expect(plan.toFold).toEqual([{ anchorIndex: 0, range }]);
		expect(plan.deferred).toEqual([]);
	});

	it("a cursor exactly on the range's boundary line still counts as inside (deferred)", () => {
		const stored = storedFrom(before);
		const candidates = candidatesFrom(before);
		const range = candidates[0].range;
		const matches = matchesFor(stored, { 0: { tier: "exact", target: 0 } });

		const plan = planRestore(baseInput({ stored, matches, candidates, cursorLine: range.startLine }));
		expect(plan.toFold).toEqual([]);
		expect(plan.deferred).toHaveLength(1);
	});
});

describe("planRestore: E3 — a fold the user unfolded since the snapshot is not re-applied", () => {
	const text = "## Tuesday\nbody line";

	it("liveAnchorKeys excludes the stored anchor's key: it's left out of both toFold and deferred", () => {
		const stored = storedFrom(text);
		const candidates = candidatesFrom(text);
		const matches = matchesFor(stored, { 0: { tier: "exact", target: 0 } });

		const plan = planRestore(baseInput({ stored, matches, candidates, liveAnchorKeys: new Set() }));
		expect(plan.toFold).toEqual([]);
		expect(plan.deferred).toEqual([]);
	});

	it("liveAnchorKeys is null: the check is skipped entirely and the match still applies", () => {
		const stored = storedFrom(text);
		const candidates = candidatesFrom(text);
		const matches = matchesFor(stored, { 0: { tier: "exact", target: 0 } });

		const plan = planRestore(baseInput({ stored, matches, candidates, liveAnchorKeys: null }));
		expect(plan.toFold).toHaveLength(1);
	});
});

describe("planRestore: E6 — a capped match is never folded", () => {
	it("tier none / reason capped is skipped, same as any other 'none'", () => {
		const text = "## Tuesday\nbody";
		const stored = storedFrom(text);
		const candidates = candidatesFrom(text);
		const matches = matchesFor(stored, { 0: { tier: "none", reason: "capped" } });

		const plan = planRestore(baseInput({ stored, matches, candidates }));
		expect(plan.toFold).toEqual([]);
		expect(plan.deferred).toEqual([]);
	});
});

describe("planRestore: F4 — a block absent from the map is never folded", () => {
	it.each(["no-candidate", "below-threshold", "ambiguous", "capped"] as const)(
		"tier none (reason %s) never produces a fold target",
		(reason) => {
			const text = "## Tuesday\nbody";
			const stored = storedFrom(text);
			const candidates = candidatesFrom(text);
			const matches = matchesFor(stored, { 0: { tier: "none", reason } });

			const plan = planRestore(baseInput({ stored, matches, candidates }));
			expect(plan.toFold).toEqual([]);
			expect(plan.deferred).toEqual([]);
		},
	);
});

describe("planRestore: a matched block that's no longer foldable is skipped", () => {
	it("a single-line range (e.g. a heading whose body disappeared) is left out, not forced", () => {
		const stored = storedFrom("## Tuesday\nbody line");
		const candidates = candidatesFrom("## Tuesday\n## Wednesday"); // nothing left under Tuesday
		const headingCandidateIndex = candidates.findIndex((c) => c.anchor.text === "tuesday");
		const matches = matchesFor(stored, { 0: { tier: "exact", target: headingCandidateIndex } });

		const plan = planRestore(baseInput({ stored, matches, candidates }));
		expect(plan.toFold).toEqual([]);
		expect(plan.deferred).toEqual([]);
	});
});

describe("planRestore: idempotent re-apply", () => {
	it("a match whose range is already folded live is not re-dispatched", () => {
		const text = "## Tuesday\nbody line";
		const stored = storedFrom(text);
		const candidates = candidatesFrom(text);
		const matches = matchesFor(stored, { 0: { tier: "exact", target: 0 } });

		const plan = planRestore(baseInput({ stored, matches, candidates, alreadyFolded: [candidates[0].range] }));
		expect(plan.toFold).toEqual([]);
		expect(plan.deferred).toEqual([]);
	});
});

describe("planRestore: an out-of-range match target is defensive, not a throw", () => {
	it("a target index outside candidates is simply left out", () => {
		const text = "## Tuesday\nbody";
		const stored = storedFrom(text);
		const candidates = candidatesFrom(text);
		const matches = matchesFor(stored, { 0: { tier: "exact", target: 99 } });

		let plan: ReturnType<typeof planRestore> | undefined;
		expect(() => (plan = planRestore(baseInput({ stored, matches, candidates })))).not.toThrow();
		expect(plan?.toFold).toEqual([]);
	});
});

describe("planRestore: G14 wiring guard — matches are walked in order, never re-ordered or filtered beyond the rules above", () => {
	it("three matched anchors come back in the same relative order they were given in", () => {
		const text = ["## Monday", "a", "## Tuesday", "b", "## Wednesday", "c"].join("\n");
		const stored = storedFrom(text);
		const candidates = candidatesFrom(text);
		// stored/candidates order (buildAnchors, document order): Monday(0), a(1), Tuesday(2),
		// b(3), Wednesday(4), c(5) — only the three headings are given matches here.
		const matches = matchesFor(stored, {
			0: { tier: "exact", target: 4 }, // Monday -> Wednesday's candidate (deliberately scrambled)
			2: { tier: "exact", target: 0 }, // Tuesday -> Monday's candidate
			4: { tier: "exact", target: 2 }, // Wednesday -> Tuesday's candidate
		});

		const plan = planRestore(baseInput({ stored, matches, candidates }));
		expect(plan.toFold.map((t) => t.anchorIndex)).toEqual([0, 2, 4]);
		expect(plan.toFold.map((t) => t.range)).toEqual([candidates[4].range, candidates[0].range, candidates[2].range]);
	});
});

describe("planRestore: empty inputs never throw", () => {
	it("no stored anchors, no matches, no candidates", () => {
		const plan = planRestore(baseInput({ stored: [], matches: [], candidates: [] }));
		expect(plan).toEqual({ toFold: [], deferred: [] });
	});
});
