/**
 * E5/E6/G15 — `src/baseline.ts`'s pure(ish) baseline builder. Uses a real CM6 `EditorState` (via
 * `state.update()`, never a view) to seed live fold state, exactly like
 * tests/integration/first-open-baseline.test.ts does at the CM6-glue level — this file focuses
 * on `buildBaseline` itself across every anchor kind, nesting, "no folds" and an unbuildable
 * range.
 */
import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { codeFolding, foldEffect } from "@codemirror/language";
import { buildBaseline } from "../../src/baseline";
import { buildAnchors, anchorKey, type AnchorKind } from "../../src/anchors";
import { hashText } from "../../src/fold-store";
import { MAX_FOLDS } from "../../src/matcher";

/** End of line `n` (1-indexed) in `text` — the same "end of first line -> end of last line" CM6
 * fold-range convention src/fold-restorer.ts's `foldEffectFor` uses. */
function lineEnd(text: string, n: number): number {
	const lines = text.split("\n");
	let offset = 0;
	for (let i = 0; i < n - 1; i++) offset += lines[i].length + 1;
	return offset + lines[n - 1].length;
}

function stateWithFolds(text: string, foldRanges: { from: number; to: number }[]): EditorState {
	let state = EditorState.create({ doc: text, extensions: [codeFolding()] });
	if (foldRanges.length > 0) state = state.update({ effects: foldRanges.map((r) => foldEffect.of(r)) }).state;
	return state;
}

describe("buildBaseline: no live folds (G15)", () => {
	it("returns an empty anchors array (still a valid baseline, never half-stored)", () => {
		const text = "## Tuesday\n- [ ] Draft proposal\n";
		const state = stateWithFolds(text, []);
		const baseline = buildBaseline(state, text);
		expect(baseline).toEqual({ contentHash: hashText(text), anchors: [] });
	});
});

describe("buildBaseline: one fold of every anchor kind (E13)", () => {
	const rows: { label: string; kind: AnchorKind; text: string }[] = [
		{ label: "heading", kind: "heading", text: "## Tuesday\n- [ ] Draft proposal\n" },
		{ label: "task", kind: "task", text: "## Tuesday\n- [ ] Draft proposal\n  - [ ] Sub task\n" },
		{ label: "callout", kind: "callout", text: "> [!note] Callout\n> Content line\n- [ ] Other\n" },
		{ label: "frontmatter", kind: "frontmatter", text: "---\ntags: [test]\n---\n## Tuesday\n" },
		{ label: "code block", kind: "code", text: "## Tuesday\n```ts\ncode line\n```\n- [ ] Other\n" },
	];

	for (const { label, kind, text } of rows) {
		it(`${label}: adopts the live fold as the matching anchor`, () => {
			const blocks = buildAnchors(text);
			const target = blocks.find((b) => b.anchor.kind === kind);
			expect(target).toBeDefined();

			const range = { from: lineEnd(text, target!.range.startLine), to: lineEnd(text, target!.range.endLine) };
			const state = stateWithFolds(text, [range]);
			const baseline = buildBaseline(state, text);

			expect(baseline.contentHash).toBe(hashText(text));
			expect(baseline.anchors).toHaveLength(1);
			expect(anchorKey(baseline.anchors[0])).toBe(anchorKey(target!.anchor));
		});
	}
});

describe("buildBaseline: nesting", () => {
	it("a nested anchor (indent > 0, non-empty parentChain) and an independent top-level anchor are both adopted", () => {
		const text = "- [ ] Draft proposal\n  - [ ] Sub task\n    - [ ] Grandchild\n- [ ] Another task\n  - [ ] Another sub\n";
		const blocks = buildAnchors(text);
		const nested = blocks.find((b) => b.anchor.text === "sub task")!;
		const topLevel = blocks.find((b) => b.anchor.text === "another task")!;
		expect(nested.anchor.indent).toBeGreaterThan(0);
		expect(nested.anchor.parentChain.length).toBeGreaterThan(0);

		// These two ranges don't overlap (the nested block's parent, "Draft proposal", is left
		// unfolded, so its body — including "Sub task" — is still visible on its own line).
		const nestedRange = { from: lineEnd(text, nested.range.startLine), to: lineEnd(text, nested.range.endLine) };
		const topRange = { from: lineEnd(text, topLevel.range.startLine), to: lineEnd(text, topLevel.range.endLine) };
		const state = stateWithFolds(text, [nestedRange, topRange]);
		const baseline = buildBaseline(state, text);

		const keys = baseline.anchors.map(anchorKey).sort();
		expect(keys).toEqual([anchorKey(nested.anchor), anchorKey(topLevel.anchor)].sort());
	});
});

describe("buildBaseline: an unbuildable range is skipped, not half-stored (E5)", () => {
	it("a live-folded span that doesn't land on any candidate's exact range is ignored", () => {
		const text = "## Tuesday\n- [ ] Draft proposal\n- [ ] Send invoices\n";
		// Folds half of the heading's own line range only (from < its line end) — not a span
		// `buildAnchors` would ever produce for any candidate.
		const oddRange = { from: 2, to: lineEnd(text, 2) - 1 };
		const state = stateWithFolds(text, [oddRange]);
		const baseline = buildBaseline(state, text);
		expect(baseline.anchors).toEqual([]);
	});
});

describe("buildBaseline: E6 cap", () => {
	it("never adopts more than MAX_FOLDS anchors even if more blocks are live-folded", () => {
		const lines: string[] = [];
		for (let i = 0; i < MAX_FOLDS + 20; i++) {
			lines.push(`- [ ] Task ${i}`);
			lines.push(`  - [ ] Sub ${i}`); // gives each top-level task a real (non-zero) fold span
		}
		const text = lines.join("\n") + "\n";
		const blocks = buildAnchors(text);
		const topTasks = blocks.filter((b) => b.anchor.kind === "task" && b.anchor.indent === 0);
		expect(topTasks.length).toBe(MAX_FOLDS + 20);

		const ranges = topTasks
			.map((block) => ({ from: lineEnd(text, block.range.startLine), to: lineEnd(text, block.range.endLine) }))
			.sort((a, b) => a.from - b.from);
		const state = stateWithFolds(text, ranges);
		const baseline = buildBaseline(state, text);
		expect(baseline.anchors.length).toBeLessThanOrEqual(MAX_FOLDS);
	});
});
