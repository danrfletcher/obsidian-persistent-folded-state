/**
 * The remaining named edge cases that aren't already covered by restore-cm6/-panes/-cursor/
 * -large/-golden-path: a pane that's switched to a different file between the change and the
 * settle, an empty file / a map entry the matcher can't place, and idempotent re-apply (a
 * fold that's already live isn't re-dispatched) proven against the real CM6 pipeline, not just
 * src/restore-plan.ts's own unit tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import type { FileFoldRecord } from "../../src/types";

const NOTE_PATH = "Tasks.md";
const OTHER_PATH = "Other.md";
const BEFORE = ["## Tuesday", "body line", "## Another"].join("\n");
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

function makeView(store: FoldStore, doc: string, filePath: string | null, cursorAt = 0): EditorView {
	const watcher = createEditorWatcher({ store, window });
	const state = EditorState.create({
		doc,
		selection: { anchor: cursorAt },
		extensions: [
			codeFolding(),
			watcher,
			editorInfoField.init(() => ({ file: filePath ? { path: filePath, extension: "md" } : null })),
		],
	});
	return new EditorView({ state, parent: document.body });
}

function liveFoldedRanges(view: EditorView): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];
	foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
		ranges.push({ from, to });
	});
	return ranges;
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 300));
}

describe("restore edge cases: pane switched to a different file between the change and the settle", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("is dropped without throwing: the view's active path no longer matches the settled path", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });

		// A single mutable "current file" the mock editorInfoField reads, standing in for the
		// pane being switched to a different open file after the change but before the settle.
		let currentPath: string | null = NOTE_PATH;
		const watcher = createEditorWatcher({ store, window });
		const state = EditorState.create({
			doc: BEFORE,
			selection: { anchor: 0 },
			extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: currentPath ? { path: currentPath, extension: "md" } : null }))],
		});
		const view = new EditorView({ state, parent: document.body });

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
		});

		currentPath = OTHER_PATH; // the pane now shows a different file, before the 150ms settle fires

		await expect(settle()).resolves.toBeUndefined();
		expect(liveFoldedRanges(view)).toEqual([]); // nothing was dispatched for the old path
	});

	it("is dropped without throwing: the view was destroyed before the settle fired", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const view = makeView(store, BEFORE, NOTE_PATH);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
		});
		view.destroy();

		await expect(settle()).resolves.toBeUndefined();
	});
});

describe("restore edge cases: empty file, no folds in the map, and a 'no match' map entry", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("an empty file with an empty map: no effect dispatched, nothing throws", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [], dormant: [] } });
		const view = makeView(store, "", NOTE_PATH);
		const dispatchSpy = vi.spyOn(view, "dispatch");

		view.dispatch({
			changes: { from: 0, to: 0, insert: "" },
			annotations: Transaction.userEvent.of("set"),
		});

		await expect(settle()).resolves.toBeUndefined();
		expect(dispatchSpy).toHaveBeenCalledTimes(1); // only the explicit dispatch above
		expect(liveFoldedRanges(view)).toEqual([]);
	});

	it("a map entry the matcher can't place (no-candidate): no effect dispatched, nothing throws", async () => {
		// A stored anchor that nothing in the new text could plausibly be: different kind,
		// different text entirely, with no same-kind candidate anywhere in the document at all.
		const unplaceable = { kind: "callout", indent: 0, text: "something that will never appear", siblingIndex: 0, parentChain: [] };
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [unplaceable], dormant: [] } });
		const view = makeView(store, BEFORE, NOTE_PATH);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
		});

		await expect(settle()).resolves.toBeUndefined();
		expect(liveFoldedRanges(view)).toEqual([]);
	});
});

describe("restore edge cases: idempotent re-apply against the real CM6 pipeline", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("a block already folded live is not re-dispatched by a second settled restore for unrelated text elsewhere", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const cursorAt = BEFORE.indexOf("## Another");
		// Cursor parked inside "## Another" (line 3), clearly outside Tuesday's own range
		// (lines 1-2), so G13 doesn't defer the fold this test is about. Set explicitly on each
		// dispatch too: a whole-buffer replace otherwise maps the old selection to the start of
		// the new content by default, not to the same text at the same offset.
		const view = makeView(store, BEFORE, NOTE_PATH, cursorAt);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: cursorAt },
		});
		await settle();
		const foldedAfterFirst = liveFoldedRanges(view);
		expect(foldedAfterFirst).toHaveLength(1);

		// A second, unrelated external rewrite (appends a line at the very end, well outside
		// Tuesday's own already-closed range) — the live Tuesday fold must survive unchanged,
		// not be re-added as a duplicate or disturbed.
		const secondText = view.state.doc.toString() + "\nmore content at the end";
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: secondText },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: cursorAt },
		});
		await settle();

		expect(liveFoldedRanges(view)).toEqual(foldedAfterFirst);
	});
});
