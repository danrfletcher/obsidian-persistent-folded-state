/**
 * E14 — pure duplicate cleanup (`src/dedupe-store.ts`). Table-driven; the anchors are the same
 * fixtures `tests/unit/dormant.test.ts` uses. Expected lists are written out literally.
 */
import { describe, expect, it } from "vitest";
import { dedupeFoldsDormant } from "../../src/dedupe-store";
import { MAX_DORMANT_AGE_MS, expireDormant } from "../../src/dormant";
import type { Anchor } from "../../src/anchors";
import type { StoredAnchor } from "../../src/types";

const TUESDAY: Anchor = { kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] };
const WEDNESDAY: Anchor = { kind: "heading", indent: 0, text: "wednesday", siblingIndex: 1, parentChain: [] };

const stored = (value: unknown): StoredAnchor => value as StoredAnchor;
const active = (anchor: Anchor): StoredAnchor => stored({ ...anchor });
const dormantAt = (anchor: Anchor, dormantSince: number): StoredAnchor => stored({ ...anchor, dormantSince });

const NOW = 5_000_000;

interface Row {
	label: string;
	folds: StoredAnchor[];
	dormant: StoredAnchor[];
	expectDormant: StoredAnchor[];
	expectRemoved: number;
}

const rows: Row[] = [
	{
		label: "no overlap: nothing is removed",
		folds: [active(TUESDAY)],
		dormant: [dormantAt(WEDNESDAY, 1000)],
		expectDormant: [dormantAt(WEDNESDAY, 1000)],
		expectRemoved: 0,
	},
	{
		label: "no folds at all: dormant is untouched",
		folds: [],
		dormant: [dormantAt(TUESDAY, 1000), dormantAt(WEDNESDAY, 2000)],
		expectDormant: [dormantAt(TUESDAY, 1000), dormantAt(WEDNESDAY, 2000)],
		expectRemoved: 0,
	},
	{
		label: "full overlap: every dormant entry goes, whatever its dormantSince",
		folds: [active(TUESDAY), active(WEDNESDAY)],
		dormant: [dormantAt(TUESDAY, 1000), dormantAt(WEDNESDAY, 4_999_999)],
		expectDormant: [],
		expectRemoved: 2,
	},
	{
		label: "partial overlap: only the duplicated key goes; the other keeps its dormantSince and place",
		folds: [active(TUESDAY)],
		dormant: [dormantAt(WEDNESDAY, 2222), dormantAt(TUESDAY, 1111)],
		expectDormant: [dormantAt(WEDNESDAY, 2222)],
		expectRemoved: 1,
	},
	{
		label: "overlap whose dormant copy is already past the window: still removed from dormant",
		folds: [active(TUESDAY)],
		dormant: [dormantAt(TUESDAY, NOW - MAX_DORMANT_AGE_MS - 1)],
		expectDormant: [],
		expectRemoved: 1,
	},
	{
		label: "malformed dormant entries are carried over, not counted and not thrown on",
		folds: [active(TUESDAY)],
		dormant: [stored(null), stored("nope"), stored({ kind: "nope" }), dormantAt(TUESDAY, 1000), dormantAt(WEDNESDAY, 3000)],
		expectDormant: [stored(null), stored("nope"), stored({ kind: "nope" }), dormantAt(WEDNESDAY, 3000)],
		expectRemoved: 1,
	},
	{
		label: "malformed fold entries match nothing",
		folds: [stored(null), stored({ kind: "heading" }), stored(42)],
		dormant: [dormantAt(TUESDAY, 1000)],
		expectDormant: [dormantAt(TUESDAY, 1000)],
		expectRemoved: 0,
	},
	{
		label: "the same key twice inside dormant and also in folds: both copies go",
		folds: [active(TUESDAY)],
		dormant: [dormantAt(TUESDAY, 1000), dormantAt(TUESDAY, 2000)],
		expectDormant: [],
		expectRemoved: 2,
	},
	{
		label: "the same key twice inside dormant and not in folds: neither is touched",
		folds: [active(WEDNESDAY)],
		dormant: [dormantAt(TUESDAY, 1000), dormantAt(TUESDAY, 2000)],
		expectDormant: [dormantAt(TUESDAY, 1000), dormantAt(TUESDAY, 2000)],
		expectRemoved: 0,
	},
	{
		label: "an unknown extra field on the dormant copy does not hide the duplicate (matched by key, not raw JSON)",
		folds: [active(TUESDAY)],
		dormant: [stored({ ...TUESDAY, dormantSince: 9, extra: "x" })],
		expectDormant: [],
		expectRemoved: 1,
	},
	{
		label: "a dormant copy whose dormantSince is bad is still recognised as the duplicate",
		folds: [active(TUESDAY)],
		dormant: [stored({ ...TUESDAY, dormantSince: "soon" })],
		expectDormant: [],
		expectRemoved: 1,
	},
	{
		label: "same text but a different siblingIndex is a different anchor: kept",
		folds: [active(TUESDAY)],
		dormant: [dormantAt({ ...TUESDAY, siblingIndex: 1 }, 1000)],
		expectDormant: [dormantAt({ ...TUESDAY, siblingIndex: 1 }, 1000)],
		expectRemoved: 0,
	},
	{
		label: "empty lists",
		folds: [],
		dormant: [],
		expectDormant: [],
		expectRemoved: 0,
	},
];

describe("dedupeFoldsDormant (E14)", () => {
	for (const row of rows) {
		it(row.label, () => {
			const foldsBefore = JSON.stringify(row.folds);
			const dormantBefore = JSON.stringify(row.dormant);
			const result = dedupeFoldsDormant(row.folds, row.dormant);
			expect(result.dormant).toEqual(row.expectDormant);
			expect(result.removed).toBe(row.expectRemoved);
			expect(result.folds).toEqual(row.folds); // the active list is never changed
			// Never mutates its input.
			expect(JSON.stringify(row.folds)).toBe(foldsBefore);
			expect(JSON.stringify(row.dormant)).toBe(dormantBefore);
		});
	}

	it("carries every kept dormant entry over as the same object", () => {
		const keep = dormantAt(WEDNESDAY, 2222);
		const result = dedupeFoldsDormant([active(TUESDAY)], [dormantAt(TUESDAY, 1), keep]);
		expect(result.dormant[0]).toBe(keep);
	});

	it("leaves nothing for expiry to do on the active copy: expireDormant never sees `folds`", () => {
		const result = dedupeFoldsDormant([active(TUESDAY)], [dormantAt(TUESDAY, 0), dormantAt(WEDNESDAY, NOW - MAX_DORMANT_AGE_MS - 1)]);
		expect(result.folds).toEqual([active(TUESDAY)]);
		expect(expireDormant(result.dormant, NOW)).toEqual([]);
	});

	it("a 136-anchor record, all in both lists, ends with 136 folds and 0 dormant", () => {
		const anchors: Anchor[] = Array.from({ length: 136 }, (_, i) => ({ kind: "task", indent: 0, text: `lesson ${i}`, siblingIndex: i, parentChain: [] }));
		const result = dedupeFoldsDormant(
			anchors.map(active),
			anchors.map((anchor) => dormantAt(anchor, 1000)),
		);
		expect(result.folds).toHaveLength(136);
		expect(result.dormant).toEqual([]);
		expect(result.removed).toBe(136);
	});
});
