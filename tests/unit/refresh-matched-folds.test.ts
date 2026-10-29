/**
 * Warkworth-46 PR-3 (T1): `refreshMatchedFolds` (src/fold-restorer.ts) with explicit inputs: which
 * stored anchors are swapped for their block's current anchor, and which are left alone.
 */
import { describe, expect, it } from "vitest";
import { anchorKey, type Anchor, type AnchoredBlock } from "../../src/anchors";
import { refreshMatchedFolds } from "../../src/fold-restorer";
import type { MatchResult } from "../../src/matcher";
import type { StoredAnchor } from "../../src/types";

const anchor = (text: string, siblingIndex: number): Anchor => ({ kind: "task", indent: 0, text, siblingIndex, parentChain: [] });
const stored = (a: Anchor): StoredAnchor => a as unknown as StoredAnchor;
const block = (a: Anchor, line: number): AnchoredBlock => ({ anchor: a, range: { startLine: line, endLine: line + 1 } });
const exact = (target: number): MatchResult => ({ tier: "exact", target });
const none: MatchResult = { tier: "none", reason: "no-candidate" };
const keys = (m: Map<string, StoredAnchor>): string[] => [...m.keys()];

describe("refreshMatchedFolds", () => {
	it("swaps a moved anchor for its block's current one and keeps the order", () => {
		const a = anchor("a", 0);
		const b = anchor("b", 1);
		const c = anchor("c", 2);
		const bNow = anchor("b", 0); // b's sibling index shifted
		const candidates = [block(a, 1), block(bNow, 3)];
		const result = refreshMatchedFolds([stored(a), stored(b), stored(c)], [a, b, c], [exact(0), exact(1), none], candidates);
		expect(keys(result)).toEqual([anchorKey(a), anchorKey(bNow), anchorKey(c)]);
		expect(result.get(anchorKey(bNow))).toBe(candidates[1].anchor);
		expect(result.get(anchorKey(c))).toEqual(stored(c)); // unmatched: untouched, the caller sets it aside
	});

	it("returns the stored folds as they were when nothing moved", () => {
		const a = anchor("a", 0);
		const result = refreshMatchedFolds([stored(a)], [a], [exact(0)], [block(a, 1)]);
		expect(keys(result)).toEqual([anchorKey(a)]);
		expect(result.get(anchorKey(a))).toEqual(stored(a));
	});

	it("does not bring back an anchor the store no longer holds (E3)", () => {
		const a = anchor("a", 0);
		const aNow = anchor("a", 1);
		const result = refreshMatchedFolds([], [a], [exact(0)], [block(aNow, 1)]);
		expect(result.size).toBe(0);
	});

	it("handles a shift where one anchor's new key is another's old key", () => {
		const a0 = anchor("same", 0);
		const a1 = anchor("same", 1);
		const candidates = [block(anchor("same", 1), 5), block(anchor("same", 2), 8)];
		const result = refreshMatchedFolds([stored(a0), stored(a1)], [a0, a1], [exact(0), exact(1)], candidates);
		expect(keys(result)).toEqual([anchorKey(anchor("same", 1)), anchorKey(anchor("same", 2))]);
	});

	it("drops the old anchor instead of duplicating a block the user has folded meanwhile", () => {
		const old = anchor("a", 3);
		const now = anchor("a", 0);
		const result = refreshMatchedFolds([stored(old), stored(now)], [old], [exact(0)], [block(now, 1)]);
		expect(keys(result)).toEqual([anchorKey(now)]);
		expect(result.get(anchorKey(now))).toEqual(stored(now));
	});
});
