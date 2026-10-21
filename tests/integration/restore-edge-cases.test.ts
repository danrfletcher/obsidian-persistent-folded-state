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
import { codeFolding, foldEffect, foldedRanges } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore } from "../../src/fold-store";
import { buildAnchors } from "../../src/anchors";
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

		// The mock editorInfoField's value is fixed when the state is created, so the pane
		// "switching file" is modelled the way real Obsidian does it: the info object the field
		// holds is mutated in place (its `file` is replaced) — see `info.file = ...` below.
		const info: { file: { path: string; extension: string } | null } = { file: { path: NOTE_PATH, extension: "md" } };
		const watcher = createEditorWatcher({ store, window });
		const state = EditorState.create({
			doc: BEFORE,
			selection: { anchor: 0 },
			extensions: [codeFolding(), watcher, editorInfoField.init(() => info)],
		});
		const view = new EditorView({ state, parent: document.body });

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
		});

		info.file = { path: OTHER_PATH, extension: "md" }; // the pane now shows a different file, before the 150ms settle fires

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

describe("restore edge cases: R3 (PR-5) — a natively-ranged live fold is already folded", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("a fold that stops a blank line short of buildAnchors' range survives a non-user edit untouched: no second fold is dispatched", async () => {
		const text = ["- [ ] Draft proposal", "\t- [ ] sub task", "", "- [ ] Send invoices"].join("\n");
		const anchor = { kind: "task", indent: 0, text: "draft proposal", siblingIndex: 0, parentChain: [] };
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [anchor], dormant: [] } });
		const cursorAt = text.length; // on the last line, clear of the folded block
		const view = makeView(store, text, NOTE_PATH, cursorAt);

		// The fold as Obsidian's own fold service makes it: from the end of the task's first
		// line to the end of its last content line — NOT including the blank separator that
		// buildAnchors' range for the same block swallows.
		const firstLineEnd = text.indexOf("\n");
		const lastContentEnd = text.indexOf("\n\n");
		view.dispatch({ effects: foldEffect.of({ from: firstLineEnd, to: lastContentEnd }) });
		const before = liveFoldedRanges(view);
		expect(before).toEqual([{ from: firstLineEnd, to: lastContentEnd }]);

		const dispatchSpy = vi.spyOn(view, "dispatch");
		// A non-user edit (no userEvent annotation) that keeps the existing fold in place.
		view.dispatch({ changes: { from: view.state.doc.length, insert: "\n- [ ] More" } });
		dispatchSpy.mockClear();
		await settle();

		expect(dispatchSpy).not.toHaveBeenCalled(); // the restore dispatched nothing at all
		expect(liveFoldedRanges(view)).toEqual(before); // still the one native fold, not widened or doubled
	});
});

describe("restore edge cases: T132 (PR-5 R4) — a restored fold does not hide the trailing blank separator", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it.each([
		{ kind: "task", first: "- [ ] Draft proposal", anchor: { kind: "task", text: "draft proposal" } },
		{ kind: "list", first: "- Draft proposal", anchor: { kind: "list", text: "draft proposal" } },
	])("a restored $kind fold ends at its last content line; the blank line after it stays visible", async ({ first, anchor }) => {
		const stored = { ...anchor, indent: 0, siblingIndex: 0, parentChain: [] };
		const text = [first, "	- sub item", "", "- Send invoices"].join("\n");
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [stored], dormant: [] } });
		const view = makeView(store, text, NOTE_PATH, text.length); // cursor on the last line, clear of the block

		// An external rewrite: the whole buffer replaced with the same text plus a line at the end.
		const rewritten = `${text}\n- Send receipts`;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: rewritten }, annotations: Transaction.userEvent.of("set") });
		await settle();

		const doc = view.state.doc;
		// buildAnchors' range for the block runs through the blank line 3 ...
		expect(buildAnchors(rewritten).find((b) => b.range.startLine === 1)?.range).toEqual({ startLine: 1, endLine: 3 });
		// ... but the fold the restore dispatched stops at line 2, the block's last content line.
		expect(liveFoldedRanges(view)).toEqual([{ from: doc.line(1).to, to: doc.line(2).to }]);
	});
});
