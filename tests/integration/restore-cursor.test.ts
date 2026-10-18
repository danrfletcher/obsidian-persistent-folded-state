/**
 * G13: the cursor inside a block that would be re-folded defers that fold; moving the cursor
 * out applies it exactly once. Real `EditorState`/`EditorView` through the plugin's own
 * `createEditorWatcher` extension, same shape as tests/integration/restore-cm6.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import type { FileFoldRecord } from "../../src/types";

const NOTE_PATH = "Tasks.md";
const BEFORE = ["## Tuesday", "Some text under the heading.", "", "- [ ] Draft proposal", "\t- [ ] Outline", "\t- [ ] Draft", "## Another"].join("\n");
const TUESDAY_ANCHOR = { kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] };

async function makeStore(seed: Record<string, FileFoldRecord>): Promise<FoldStore> {
	let stored: unknown = { version: 1, files: seed };
	const store = new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data;
		},
	});
	await store.load();
	return store;
}

function makeView(store: FoldStore, doc: string, cursorAt: number): EditorView {
	const watcher = createEditorWatcher({ store, window });
	const state = EditorState.create({
		doc,
		selection: { anchor: cursorAt },
		extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
	});
	return new EditorView({ state, parent: document.body });
}

function liveFoldedLineRanges(view: EditorView): { startLine: number; endLine: number }[] {
	const ranges: { startLine: number; endLine: number }[] = [];
	foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
		ranges.push({ startLine: view.state.doc.lineAt(from).number, endLine: view.state.doc.lineAt(to).number });
	});
	return ranges;
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 300));
}

describe("restore-cursor (G13)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("the cursor inside the matched block defers the fold; it stays unfolded immediately after settling", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		// Cursor at the start of line 2 ("Some text under the heading."), squarely inside
		// Tuesday's own range (lines 1-6).
		const cursorAt = BEFORE.indexOf("Some text");
		const view = makeView(store, BEFORE, cursorAt);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: cursorAt },
		});

		await settle();
		expect(liveFoldedLineRanges(view)).toEqual([]);
	});

	it("moving the cursor out afterwards applies the deferred fold exactly once", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const cursorAt = BEFORE.indexOf("Some text");
		const view = makeView(store, BEFORE, cursorAt);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: cursorAt },
		});
		await settle();
		expect(liveFoldedLineRanges(view)).toEqual([]); // still deferred

		// Move the cursor into "## Another", well outside Tuesday's range — a plain
		// selection-only transaction, no document change at all.
		const outsidePos = view.state.doc.toString().indexOf("## Another");
		view.dispatch({ selection: { anchor: outsidePos } });
		await Promise.resolve(); // the deferred recheck runs on a microtask, not synchronously

		expect(liveFoldedLineRanges(view)).toHaveLength(1);
		expect(liveFoldedLineRanges(view)[0]).toEqual({ startLine: 1, endLine: 6 });

		// Applied exactly once: moving the cursor again (still outside) doesn't re-dispatch or
		// duplicate the fold.
		view.dispatch({ selection: { anchor: outsidePos + 1 } });
		await Promise.resolve();
		expect(liveFoldedLineRanges(view)).toHaveLength(1);
	});

	it("the cursor already outside the matched block at settle time folds immediately (no deferral needed)", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const outsidePos = BEFORE.indexOf("## Another");
		const view = makeView(store, BEFORE, outsidePos);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: outsidePos },
		});

		await settle();
		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 1, endLine: 6 }]);
	});

	it("R2: deleting a line inside the deferred block keeps the fold off the next heading when the cursor leaves", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const cursorAt = BEFORE.indexOf("Some text");
		const view = makeView(store, BEFORE, cursorAt);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: cursorAt },
		});
		await settle();
		expect(liveFoldedLineRanges(view)).toEqual([]); // still deferred, cursor inside

		// Delete "Some text under the heading." entirely — the line the cursor sits on, inside
		// Tuesday's deferred range — so everything after it shifts up by one line.
		const lineToDelete = view.state.doc.line(2);
		view.dispatch({
			changes: { from: lineToDelete.from, to: view.state.doc.line(3).from, insert: "" },
			selection: { anchor: lineToDelete.from },
		});

		// Still inside Tuesday's own (now-shifted) range, so still deferred.
		expect(liveFoldedLineRanges(view)).toEqual([]);

		// Move the cursor out, into the (now-shifted) "## Another".
		const outsidePos = view.state.doc.toString().indexOf("## Another");
		view.dispatch({ selection: { anchor: outsidePos } });
		await Promise.resolve();

		const folded = liveFoldedLineRanges(view);
		expect(folded).toHaveLength(1);
		// Without R2's fix the deferred target would still carry its pre-deletion line numbers
		// (1-6), which — now that one line has shifted out of the document — would swallow
		// "## Another" too. Mapping the target's span forward through the deletion (R2) lands
		// it on the correct, shifted range instead.
		expect(folded[0]).toEqual({ startLine: 1, endLine: 5 });
	});

	it("R2: forgetting the note's stored folds while a fold is deferred drops it instead of applying it later", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const cursorAt = BEFORE.indexOf("Some text");
		const view = makeView(store, BEFORE, cursorAt);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: cursorAt },
		});
		await settle();
		expect(liveFoldedLineRanges(view)).toEqual([]); // still deferred, cursor inside

		// "Forget stored folds for this note" (G12's command) while the fold is still
		// deferred — the anchor it was going to apply is no longer live at all.
		store.forget(NOTE_PATH);

		// Move the cursor out — without R2's fix this would still apply the now-forgotten
		// fold, since `applyReadyDeferredFolds` never used to re-check the live store.
		const outsidePos = view.state.doc.toString().indexOf("## Another");
		view.dispatch({ selection: { anchor: outsidePos } });
		await Promise.resolve();

		expect(liveFoldedLineRanges(view)).toEqual([]);
	});
});
