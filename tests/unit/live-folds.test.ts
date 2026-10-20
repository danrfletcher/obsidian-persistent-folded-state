/**
 * T1/T22 — `src/live-folds.ts`'s pure line-range helpers, tested directly against synthetic
 * `LineRange`/`AnchoredBlock` shapes (not routed through `buildAnchors`), so the blank-line-only
 * guard in `widenLiveRangeToCandidate` can be exercised in situations `buildAnchors` itself
 * could never actually produce (see tests/unit/baseline.test.ts's own file comment on why a
 * real `buildAnchors` candidate's `endLine` can never be reached across a non-blank line).
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import type { AnchoredBlock } from "../../src/anchors";
import { groupCandidatesByStartLine, resolveCandidateForLiveRange, widenLiveRangeToCandidate } from "../../src/live-folds";

function stateFor(text: string): EditorState {
	return EditorState.create({ doc: text });
}

function block(startLine: number, endLine: number): AnchoredBlock {
	return {
		anchor: { kind: "list", indent: 0, text: `block-${startLine}-${endLine}`, siblingIndex: 0, parentChain: [] },
		range: { startLine, endLine },
	};
}

describe("widenLiveRangeToCandidate (T22)", () => {
	it("widens across a run of nothing but blank lines", () => {
		const state = stateFor("one\n\n\nfour\n");
		expect(widenLiveRangeToCandidate(state, { startLine: 1, endLine: 1 }, { startLine: 1, endLine: 3 })).toBe(true);
	});

	it("refuses to widen across a line that is not blank", () => {
		const state = stateFor("one\nnot blank\nthree\n");
		expect(widenLiveRangeToCandidate(state, { startLine: 1, endLine: 1 }, { startLine: 1, endLine: 2 })).toBe(false);
	});

	it("refuses when the candidate's startLine differs", () => {
		const state = stateFor("one\n\nthree\n");
		expect(widenLiveRangeToCandidate(state, { startLine: 1, endLine: 1 }, { startLine: 2, endLine: 3 })).toBe(false);
	});

	it("refuses when the candidate is not actually wider (equal or narrower)", () => {
		const state = stateFor("one\n\nthree\n");
		expect(widenLiveRangeToCandidate(state, { startLine: 1, endLine: 2 }, { startLine: 1, endLine: 2 })).toBe(false);
		expect(widenLiveRangeToCandidate(state, { startLine: 1, endLine: 2 }, { startLine: 1, endLine: 1 })).toBe(false);
	});

	it("refuses when the candidate's endLine is past the document's own line count", () => {
		const state = stateFor("one\ntwo\n");
		expect(widenLiveRangeToCandidate(state, { startLine: 1, endLine: 1 }, { startLine: 1, endLine: 50 })).toBe(false);
	});
});

describe("resolveCandidateForLiveRange (T1/T22)", () => {
	it("prefers an exact rangeKey match over widening, even when a wider candidate also shares the startLine", () => {
		const state = stateFor("one\n\nthree\n");
		const exact = block(1, 1);
		const wider = block(1, 2);
		const byStart = groupCandidatesByStartLine([wider, exact]);
		const resolved = resolveCandidateForLiveRange(state, { startLine: 1, endLine: 1 }, byStart);
		expect(resolved).toBe(exact);
	});

	it("falls back to widening once the exact match fails", () => {
		const state = stateFor("one\n\nthree\n");
		const wider = block(1, 2);
		const byStart = groupCandidatesByStartLine([wider]);
		const resolved = resolveCandidateForLiveRange(state, { startLine: 1, endLine: 1 }, byStart);
		expect(resolved).toBe(wider);
	});

	it("returns null when nothing shares the live range's startLine", () => {
		const state = stateFor("one\ntwo\n");
		const byStart = groupCandidatesByStartLine([block(2, 2)]);
		expect(resolveCandidateForLiveRange(state, { startLine: 1, endLine: 1 }, byStart)).toBeNull();
	});

	it("returns null when a same-startLine candidate exists but neither matches exactly nor widens cleanly", () => {
		const state = stateFor("one\nnot blank\nthree\n");
		const byStart = groupCandidatesByStartLine([block(1, 2)]); // line 2 is not blank
		expect(resolveCandidateForLiveRange(state, { startLine: 1, endLine: 1 }, byStart)).toBeNull();
	});
});

describe("groupCandidatesByStartLine", () => {
	it("groups by startLine, preserving every entry that shares one", () => {
		const a = block(1, 1);
		const b = block(1, 3);
		const c = block(5, 5);
		const grouped = groupCandidatesByStartLine([a, b, c]);
		expect(grouped.get(1)).toEqual([a, b]);
		expect(grouped.get(5)).toEqual([c]);
		expect(grouped.get(2)).toBeUndefined();
	});
});
