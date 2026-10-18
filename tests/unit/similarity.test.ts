/**
 * src/similarity.ts: range, symmetry, identity, empty, unicode, long input (C1, C26).
 */
import { describe, expect, it } from "vitest";
import { similarity } from "../../src/similarity";

describe("similarity: range and never NaN", () => {
	it("is always within 0..1 for a table of varied pairs", () => {
		const pairs: [string, string][] = [
			["", ""],
			["", "a"],
			["a", ""],
			["draft proposal", "draft proposal v2"],
			["hello world", "world hello"],
			["same", "same"],
			["completely different text here", "nothing at all alike"],
		];
		for (const [a, b] of pairs) {
			const score = similarity(a, b);
			expect(score).not.toBeNaN();
			expect(score).toBeGreaterThanOrEqual(0);
			expect(score).toBeLessThanOrEqual(1);
		}
	});
});

describe("similarity: symmetry", () => {
	it("similarity(a, b) === similarity(b, a) for every pair in a table", () => {
		const pairs: [string, string][] = [
			["draft proposal", "draft proposal v2"],
			["", "x"],
			["abc", "xyz"],
			["unicode café", "unicode cafe"],
			["", ""],
		];
		for (const [a, b] of pairs) {
			expect(similarity(a, b)).toBe(similarity(b, a));
		}
	});
});

describe("similarity: identity", () => {
	it("returns exactly 1 for identical non-empty text", () => {
		expect(similarity("draft proposal", "draft proposal")).toBe(1);
	});

	it("returns exactly 1 for identical empty text (both sides empty)", () => {
		expect(similarity("", "")).toBe(1);
	});

	it("returns exactly 1 for identical unicode/CJK/emoji text", () => {
		expect(similarity("会議の議事録 🎉", "会議の議事録 🎉")).toBe(1);
	});
});

describe("similarity: empty vs non-empty never NaN, always 0", () => {
	it("returns 0 when exactly one side is empty and they differ", () => {
		expect(similarity("", "draft proposal")).toBe(0);
		expect(similarity("draft proposal", "")).toBe(0);
	});

	it("returns 0 for empty vs a single character", () => {
		expect(similarity("", "x")).toBe(0);
		expect(similarity("x", "")).toBe(0);
	});

	it("returns 0, never NaN, for two different whitespace-only strings (both tokenize to nothing)", () => {
		// Neither side is the empty string (so the length===0 short-circuit doesn't fire), but
		// both tokenize to zero tokens, which would otherwise divide 0/0 in the token-overlap
		// half of the blend.
		expect(similarity("   ", "  ")).toBe(0);
	});
});

describe("similarity: unicode, CJK, emoji", () => {
	it("stays in range for CJK text with a small edit", () => {
		const score = similarity("会議の議事録", "会議の議事録です");
		expect(score).toBeGreaterThan(0);
		expect(score).toBeLessThan(1);
	});

	it("stays in range for emoji-heavy text", () => {
		const score = similarity("ship it 🚀🚀🚀", "ship it 🚀🚀");
		expect(score).toBeGreaterThan(0);
		expect(score).toBeLessThanOrEqual(1);
	});

	it("a combining-mark variant still scores high against its plain form", () => {
		// normalizeText NFC-normalizes upstream; similarity itself just compares whatever
		// strings it's handed, so two already-equal-after-NFC strings score 1.
		const combining = "cafe\u0301"; // "café" as e + combining acute
		const precomposed = "café";
		expect(similarity(combining.normalize("NFC"), precomposed)).toBe(1);
	});
});

describe("similarity: long input", () => {
	it("stays in range and finishes promptly for a 10,000-character line", () => {
		const long = "a".repeat(10000);
		const longEdited = `${"a".repeat(9998)}bb`;
		const start = Date.now();
		const score = similarity(long, longEdited);
		const elapsedMs = Date.now() - start;
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
		// Single whitespace-free strings tokenize as one token each, so the token-overlap half
		// of the blend sees them as wholly different tokens (0) even though only the last two
		// characters differ — the edit-similarity half (~0.9998) still pulls the blend above 0.4.
		expect(score).toBeGreaterThan(0.4);
		expect(elapsedMs).toBeLessThan(2000);
	});

	it("two unrelated 10,000-character lines still finish promptly and stay in range", () => {
		const a = "lorem ipsum dolor sit amet ".repeat(400);
		const b = "the quick brown fox jumps over ".repeat(330);
		const start = Date.now();
		const score = similarity(a, b);
		const elapsedMs = Date.now() - start;
		expect(score).toBeGreaterThanOrEqual(0);
		expect(score).toBeLessThanOrEqual(1);
		expect(elapsedMs).toBeLessThan(2000);
	});
});
