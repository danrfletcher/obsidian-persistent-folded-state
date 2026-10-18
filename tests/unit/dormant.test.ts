/**
 * G6/E8 — pure dormant-fold bookkeeping (`src/dormant.ts`). Table-driven over the explicit `now`
 * argument; `Date.now()` is never read internally, so every clock-dependent rule here is tested
 * deterministically.
 */
import { describe, expect, it } from "vitest";
import { addDormant, expireDormant, parseDormantAnchor, retryDormant, MAX_DORMANT_AGE_MS } from "../../src/dormant";
import { anchorKey, type Anchor } from "../../src/anchors";

const TUESDAY: Anchor = { kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] };
const WEDNESDAY: Anchor = { kind: "heading", indent: 0, text: "wednesday", siblingIndex: 1, parentChain: [] };

describe("parseDormantAnchor (E8)", () => {
	const rows: { label: string; value: unknown; expectNull: boolean }[] = [
		{ label: "a well-formed anchor + numeric dormantSince", value: { ...TUESDAY, dormantSince: 1000 }, expectNull: false },
		{ label: "dormantSince: 0 is valid (not falsy-rejected)", value: { ...TUESDAY, dormantSince: 0 }, expectNull: false },
		{ label: "missing dormantSince", value: { ...TUESDAY }, expectNull: true },
		{ label: "dormantSince as a string", value: { ...TUESDAY, dormantSince: "1000" }, expectNull: true },
		{ label: "dormantSince: NaN", value: { ...TUESDAY, dormantSince: Number.NaN }, expectNull: true },
		{ label: "dormantSince: Infinity", value: { ...TUESDAY, dormantSince: Number.POSITIVE_INFINITY }, expectNull: true },
		{ label: "dormantSince: -1 (negative)", value: { ...TUESDAY, dormantSince: -1 }, expectNull: true },
		{ label: "an otherwise-invalid anchor (bad kind)", value: { kind: "nope", indent: 0, text: "x", siblingIndex: 0, parentChain: [], dormantSince: 1 }, expectNull: true },
		{ label: "null", value: null, expectNull: true },
		{ label: "a string", value: "nope", expectNull: true },
		{ label: "an array", value: [1, 2, 3], expectNull: true },
	];

	for (const { label, value, expectNull } of rows) {
		it(`${label} -> ${expectNull ? "null" : "a DormantAnchor"}, never throws`, () => {
			let result: ReturnType<typeof parseDormantAnchor> | undefined;
			expect(() => (result = parseDormantAnchor(value))).not.toThrow();
			if (expectNull) expect(result).toBeNull();
			else expect(result).not.toBeNull();
		});
	}
});

describe("addDormant (G6: first transition to dormant)", () => {
	it("appends the anchor with dormantSince: now, without mutating the input array", () => {
		const input: Record<string, unknown>[] = [];
		const result = addDormant(input, TUESDAY, 1000);
		expect(input).toEqual([]); // never mutated
		expect(result).toHaveLength(1);
		expect(anchorKey(result[0] as unknown as Anchor)).toBe(anchorKey(TUESDAY));
		expect((result[0] as unknown as { dormantSince: number }).dormantSince).toBe(1000);
	});

	it("a repeat 'no match' for the same anchor is a no-op — the clock does not restart", () => {
		const first = addDormant([], TUESDAY, 1000);
		const second = addDormant(first, TUESDAY, 999_999); // a much later `now`
		expect(second).toHaveLength(1);
		expect((second[0] as unknown as { dormantSince: number }).dormantSince).toBe(1000); // untouched
	});

	it("a different anchor is appended alongside an existing dormant entry", () => {
		const first = addDormant([], TUESDAY, 1000);
		const second = addDormant(first, WEDNESDAY, 2000);
		expect(second).toHaveLength(2);
	});
});

describe("expireDormant (G6/E8)", () => {
	it("an entry younger than MAX_DORMANT_AGE_MS survives", () => {
		const dormant = addDormant([], TUESDAY, 0);
		const result = expireDormant(dormant, MAX_DORMANT_AGE_MS - 1);
		expect(result).toHaveLength(1);
	});

	it("an entry exactly MAX_DORMANT_AGE_MS old is forgotten (the boundary is inclusive)", () => {
		const dormant = addDormant([], TUESDAY, 0);
		const result = expireDormant(dormant, MAX_DORMANT_AGE_MS);
		expect(result).toEqual([]);
	});

	it("an entry older than MAX_DORMANT_AGE_MS is forgotten", () => {
		const dormant = addDormant([], TUESDAY, 0);
		const result = expireDormant(dormant, MAX_DORMANT_AGE_MS + 1);
		expect(result).toEqual([]);
	});

	it("a malformed entry (no dormantSince) is dropped regardless of age", () => {
		const result = expireDormant([{ ...TUESDAY }], 0);
		expect(result).toEqual([]);
	});

	it("never throws on an empty array", () => {
		expect(() => expireDormant([], 0)).not.toThrow();
		expect(expireDormant([], 0)).toEqual([]);
	});
});

describe("retryDormant (G6)", () => {
	it("an empty dormant list resolves with nothing, without calling the matcher", async () => {
		const result = await retryDormant([], [TUESDAY], 0);
		expect(result).toEqual({ matched: [], stillDormant: [] });
	});

	it("a confident match is returned with the candidate index, and is not in stillDormant", async () => {
		const dormant = addDormant([], TUESDAY, 0);
		const result = await retryDormant(dormant, [TUESDAY], 100);
		expect(result.stillDormant).toEqual([]);
		expect(result.matched).toHaveLength(1);
		expect(anchorKey(result.matched[0].anchor)).toBe(anchorKey(TUESDAY));
		expect(result.matched[0].candidateIndex).toBe(0);
	});

	it("no confident match keeps the anchor dormant with its ORIGINAL dormantSince untouched", async () => {
		const dormant = addDormant([], TUESDAY, 0);
		const result = await retryDormant(dormant, [WEDNESDAY], 500_000); // nothing it could match
		expect(result.matched).toEqual([]);
		expect(result.stillDormant).toHaveLength(1);
		expect((result.stillDormant[0] as unknown as { dormantSince: number }).dormantSince).toBe(0);
	});

	it("an already-expired anchor is forgotten outright — never attempted, never returned in either list", async () => {
		const dormant = addDormant([], TUESDAY, 0);
		// Even though candidates contain an exact match, the anchor is already 600,000ms old.
		const result = await retryDormant(dormant, [TUESDAY], MAX_DORMANT_AGE_MS);
		expect(result.matched).toEqual([]);
		expect(result.stillDormant).toEqual([]);
	});

	it("two dormant anchors cannot be consumed by the same candidate (never-break rule 4)", async () => {
		const dormant = addDormant(addDormant([], TUESDAY, 0), WEDNESDAY, 0);
		// Only one candidate exists; both dormant anchors are structurally identical apart from
		// siblingIndex/text, but only one of them may claim it.
		const result = await retryDormant(dormant, [TUESDAY], 100);
		const totalClaims = result.matched.filter((m) => m.candidateIndex === 0).length;
		expect(totalClaims).toBeLessThanOrEqual(1);
	});
});
