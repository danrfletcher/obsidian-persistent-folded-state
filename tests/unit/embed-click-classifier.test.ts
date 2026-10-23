/**
 * The click-only classifier (PR-4, E3). Table-driven over the input signal combinations the
 * real-Obsidian probe names (docs/embed-probe.md): a pointer click on the arrow, keyboard
 * activation, a scripted toggle and Obsidian's render-time toggle. Pure: no DOM.
 */
import { describe, expect, it } from "vitest";
import { classifyFoldToggle } from "../../src/embed-click-classifier";
import type { FoldToggleOrigin, FoldToggleSignals } from "../../src/embed-click-classifier";

const NONE: FoldToggleSignals = { click: false, pointerSequence: false, keyActivation: false, trusted: false, renderWindow: false };

interface Row {
	name: string;
	signals: Partial<FoldToggleSignals>;
	expected: FoldToggleOrigin;
}

const TABLE: Row[] = [
	{ name: "a real pointer click on the arrow (pointer sequence, then a trusted click)", signals: { click: true, pointerSequence: true, trusted: true }, expected: "user" },
	{ name: "keyboard activation: a trusted Enter or Space press on the arrow", signals: { keyActivation: true, trusted: true }, expected: "user" },
	{ name: "keyboard activation followed by the click it produces", signals: { click: true, keyActivation: true, trusted: true }, expected: "user" },
	{ name: "a scripted click: untrusted, no pointer sequence", signals: { click: true }, expected: "not-user" },
	{ name: "a scripted click that also imitates a pointer sequence (still untrusted)", signals: { click: true, pointerSequence: true }, expected: "not-user" },
	{ name: "a scripted key event (untrusted)", signals: { keyActivation: true }, expected: "not-user" },
	{ name: "a trusted click with no pointer sequence and no key before it (fallback signal)", signals: { click: true, trusted: true }, expected: "not-user" },
	{ name: "Obsidian's render-time toggle: the class changes with no click and no key", signals: {}, expected: "not-user" },
	{ name: "a pointer sequence with no click (a drag that left the arrow)", signals: { pointerSequence: true, trusted: true }, expected: "not-user" },
	{ name: "E3: a real click while an embed render is settling is still the user", signals: { click: true, pointerSequence: true, trusted: true, renderWindow: true }, expected: "user" },
	{ name: "E3: a key activation while an embed render is settling is still the user", signals: { keyActivation: true, trusted: true, renderWindow: true }, expected: "user" },
	{ name: "a render-time toggle inside a render window is not the user", signals: { renderWindow: true }, expected: "not-user" },
	{ name: "a scripted click inside a render window is not the user", signals: { click: true, renderWindow: true }, expected: "not-user" },
];

describe("classifyFoldToggle (E3: only the user's own input is a user fold)", () => {
	it.each(TABLE)("$name -> $expected", ({ signals, expected }) => {
		expect(classifyFoldToggle({ ...NONE, ...signals })).toBe(expected);
	});

	it("every one of the 32 signal combinations: user exactly when trusted and (a pointer click or a key press)", () => {
		for (let bits = 0; bits < 32; bits++) {
			const signals: FoldToggleSignals = {
				click: (bits & 1) !== 0,
				pointerSequence: (bits & 2) !== 0,
				keyActivation: (bits & 4) !== 0,
				trusted: (bits & 8) !== 0,
				renderWindow: (bits & 16) !== 0,
			};
			const expected = signals.trusted && ((signals.click && signals.pointerSequence) || signals.keyActivation) ? "user" : "not-user";
			expect(classifyFoldToggle(signals), JSON.stringify(signals)).toBe(expected);
		}
	});

	it("E3 ordering: the render window never changes the verdict", () => {
		for (let bits = 0; bits < 16; bits++) {
			const base: FoldToggleSignals = {
				click: (bits & 1) !== 0,
				pointerSequence: (bits & 2) !== 0,
				keyActivation: (bits & 4) !== 0,
				trusted: (bits & 8) !== 0,
				renderWindow: false,
			};
			expect(classifyFoldToggle({ ...base, renderWindow: true })).toBe(classifyFoldToggle(base));
		}
	});

	it("does not mutate its input", () => {
		const signals: FoldToggleSignals = { click: true, pointerSequence: true, keyActivation: false, trusted: true, renderWindow: false };
		const copy = { ...signals };
		classifyFoldToggle(signals);
		expect(signals).toEqual(copy);
	});
});
