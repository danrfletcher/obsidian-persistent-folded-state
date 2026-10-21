/**
 * G11: the same note open in two panes reaches the same folded set after one external change,
 * and destroying one view mid-settle doesn't break the other. Two real `EditorView`s, each
 * built from its own call to `createEditorWatcher` (mirroring how Obsidian gives every pane its
 * own CM6 instance) but sharing one `FoldStore` — exactly as two leaves showing the same vault
 * file would. No pane-to-pane wiring exists in this plugin at all (see the file comment in
 * src/fold-restorer.ts); this test is what proves that's sufficient.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import type { FileFoldRecord } from "../../src/types";

const NOTE_PATH = "Projects/Quarry/Tasks.md";
const BEFORE = ["## Tuesday", "Some text under the heading.", "", "- [ ] Draft proposal", "\t- [ ] Outline", "\t- [ ] Draft"].join("\n");
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

function makePaneView(store: FoldStore, doc: string): EditorView {
	// A fresh `createEditorWatcher` call per pane, exactly as `registerEditorExtension`
	// reconfigures every open editor independently — see the file comment in
	// src/editor-watcher.ts ("a fresh call per registerEditorExtension is fine — and
	// necessary, since each ViewPlugin instance carries its own per-view state").
	const watcher = createEditorWatcher({ store, window });
	const state = EditorState.create({
		doc,
		selection: { anchor: doc.length }, // outside Tuesday's own range in every fixture below
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

function externalRewrite(view: EditorView, text: string): void {
	view.dispatch({
		changes: { from: 0, to: view.state.doc.length, insert: text },
		annotations: Transaction.userEvent.of("set"),
		selection: { anchor: text.length },
	});
}

describe("restore-panes (G11): one state per note, every pane restores to it", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		document.body.replaceChildren();
	});

	it("two independent panes on the same path both fold the same block after one external write", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const paneA = makePaneView(store, BEFORE);
		const paneB = makePaneView(store, BEFORE);

		const after = ["intro 1", "intro 2", "intro 3", "intro 4", ...BEFORE.split("\n"), "## Another"].join("\n");
		externalRewrite(paneA, after);
		externalRewrite(paneB, after);

		await settle();

		const foldedA = liveFoldedLineRanges(paneA);
		const foldedB = liveFoldedLineRanges(paneB);
		expect(foldedA).toEqual([{ startLine: 5, endLine: 10 }]);
		expect(foldedB).toEqual(foldedA);
	});

	it("destroying one pane mid-settle doesn't break the other pane's restore", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const paneA = makePaneView(store, BEFORE);
		const paneB = makePaneView(store, BEFORE);

		const after = ["intro 1", "intro 2", "intro 3", "intro 4", ...BEFORE.split("\n"), "## Another"].join("\n");
		externalRewrite(paneA, after);
		externalRewrite(paneB, after);

		paneA.destroy(); // mid-settle: before the 150ms window elapses for either pane

		await settle();

		// Pane B's own independent settle/match/restore must still complete normally.
		expect(liveFoldedLineRanges(paneB)).toEqual([{ startLine: 5, endLine: 10 }]);
		// Destroying pane A must not have thrown or left anything half-applied for it to break
		// on (nothing further to assert on a destroyed view beyond "this didn't throw").
	});

	it("a split pane and a popout-window pane (a genuinely different `Window`) both restore the same way", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const splitPane = makePaneView(store, BEFORE);

		// R6 (PR-5)/R8 (PR-2): a popout is a different `Window` with its own document. An iframe's
		// content window is the jsdom equivalent. No `window` dep is passed, so the watcher must
		// find the pane's own window from its DOM (`view.dom.ownerDocument.defaultView`).
		const frame = document.createElement("iframe");
		document.body.appendChild(frame);
		const popoutWindow = frame.contentWindow as Window;
		expect(popoutWindow).not.toBe(window);
		const popoutSetTimeout = vi.spyOn(popoutWindow, "setTimeout");

		const popoutWatcher = createEditorWatcher({ store });
		const popoutState = EditorState.create({
			doc: BEFORE,
			selection: { anchor: BEFORE.length },
			extensions: [codeFolding(), popoutWatcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
		});
		const popoutPane = new EditorView({ state: popoutState, parent: popoutWindow.document.body });
		expect(popoutPane.dom.ownerDocument.defaultView).toBe(popoutWindow);

		const after = ["intro 1", "intro 2", "intro 3", "intro 4", ...BEFORE.split("\n"), "## Another"].join("\n");
		popoutSetTimeout.mockClear();
		externalRewrite(splitPane, after);
		externalRewrite(popoutPane, after);

		// The popout pane's 150ms settle timer is set on the popout's own window. (Only that
		// side is asserted: jsdom's iframe timers delegate to the main window's setTimeout
		// internally, so a main-window count would include the popout's own timer.)
		const settleDelays = (spy: typeof popoutSetTimeout): number[] => spy.mock.calls.map((c) => c[1] as number).filter((ms) => ms === 150);
		expect(settleDelays(popoutSetTimeout)).toHaveLength(1);

		await settle();

		expect(liveFoldedLineRanges(splitPane)).toEqual([{ startLine: 5, endLine: 10 }]);
		expect(liveFoldedLineRanges(popoutPane)).toEqual(liveFoldedLineRanges(splitPane));
		popoutPane.destroy();
		vi.restoreAllMocks();
	});
});
