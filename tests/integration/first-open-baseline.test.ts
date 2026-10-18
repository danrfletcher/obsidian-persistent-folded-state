/**
 * E5/G15 (first-open baseline), run against the real CM6 pipeline: a brand-new `EditorView`
 * constructed with folds already baked into its initial `EditorState` (via `state.update()`,
 * never `view.dispatch`), so the `ViewPlugin`'s own constructor-time check
 * (src/editor-watcher.ts) sees them before any transaction happens at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore, hashText } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import { buildAnchors, anchorKey, type Anchor } from "../../src/anchors";

const NOTE_PATH = "Projects/Quarry/Tasks.md";
const TEXT = "## Tuesday\n- [ ] Draft proposal\n  - [ ] Sub task\n- [ ] Send invoices\n";

async function makeStore(): Promise<FoldStore> {
	let stored: unknown = { version: 1, files: {} };
	const store = new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data;
		},
	});
	await store.load();
	return store;
}

/** End of line `n` to end of line `n` in `text` (1-indexed), i.e. a single-line span — used to
 * build the "end of first line -> end of last line" fold range src/fold-restorer.ts's own
 * `foldEffectFor` convention uses, from PR-3 anchor line numbers. */
function lineEnd(text: string, n: number): number {
	const lines = text.split("\n");
	let offset = 0;
	for (let i = 0; i < n - 1; i++) offset += lines[i].length + 1;
	return offset + lines[n - 1].length;
}

/** Builds an `EditorView` whose *initial* state already has `foldedRanges` applied via
 * `state.update()` — a pure state transform, no view, no transaction ever dispatched to a view
 * — then attaches the real editor watcher. A `dispatch` spy on the resulting view proves the
 * watcher's own first-open baseline path never calls `view.dispatch` itself. */
function makeViewWithLiveFolds(
	store: FoldStore,
	foldRanges: { from: number; to: number }[],
): { view: EditorView; dispatchSpy: ReturnType<typeof vi.fn> } {
	const watcher = createEditorWatcher({ store, window });
	let state = EditorState.create({
		doc: TEXT,
		extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
	});
	if (foldRanges.length > 0) {
		const tr = state.update({ effects: foldRanges.map((r) => foldEffect.of(r)) });
		state = tr.state;
	}
	const view = new EditorView({ state, parent: document.body });
	const dispatchSpy = vi.spyOn(view, "dispatch");
	return { view, dispatchSpy };
}

describe("first-open baseline (E5/G15)", () => {
	afterEach(() => {
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it("adopts two already-folded blocks as the baseline, dispatches nothing, and a second open does not re-baseline", async () => {
		const blocks = buildAnchors(TEXT);
		const tuesday = blocks.find((b) => b.anchor.kind === "heading" && b.anchor.text === "tuesday");
		const draftProposal = blocks.find((b) => b.anchor.kind === "task" && b.anchor.text === "draft proposal");
		expect(tuesday).toBeDefined();
		expect(draftProposal).toBeDefined();

		const tuesdayRange = { from: lineEnd(TEXT, tuesday!.range.startLine), to: lineEnd(TEXT, tuesday!.range.endLine) };
		const draftRange = { from: lineEnd(TEXT, draftProposal!.range.startLine), to: lineEnd(TEXT, draftProposal!.range.endLine) };

		const store = await makeStore();
		expect(store.get(NOTE_PATH)).toBeUndefined();

		const { view, dispatchSpy } = makeViewWithLiveFolds(store, [tuesdayRange, draftRange]);

		// G15/E5: baseline adoption happens synchronously in the ViewPlugin constructor — no
		// microtask/timer wait needed, and it never dispatches.
		expect(dispatchSpy).not.toHaveBeenCalled();

		const record = store.get(NOTE_PATH);
		expect(record).toBeDefined();
		expect(record?.contentHash).toBe(hashText(TEXT));
		const storedKeys = (record?.folds ?? []).map((raw) => anchorKey(raw as unknown as Anchor)).sort();
		expect(storedKeys).toEqual([anchorKey(tuesday!.anchor), anchorKey(draftProposal!.anchor)].sort());
		expect(record?.dormant).toEqual([]);

		// A second "open" (a second ViewPlugin instance for the same path, e.g. a second pane)
		// must not re-baseline: the store already has an entry.
		const beforeSecondOpen = store.get(NOTE_PATH);
		const second = makeViewWithLiveFolds(store, []); // no live folds this time
		expect(store.get(NOTE_PATH)).toEqual(beforeSecondOpen);

		view.destroy();
		second.view.destroy();
	});

	it("a file opened with zero live folds is stored as an empty baseline entry (G15), not left with no entry at all", async () => {
		const store = await makeStore();
		const { view, dispatchSpy } = makeViewWithLiveFolds(store, []);

		expect(dispatchSpy).not.toHaveBeenCalled();
		expect(store.get(NOTE_PATH)).toEqual({ contentHash: hashText(TEXT), folds: [], dormant: [] });

		view.destroy();
	});
});
