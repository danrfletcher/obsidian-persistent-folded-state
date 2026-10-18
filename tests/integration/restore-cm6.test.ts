/**
 * The restore pass wired into a real `EditorState`/`EditorView`, through the plugin's own
 * `createEditorWatcher` extension — not the pure `planRestore`/`restoreSettledChange` units in
 * isolation. The matcher is real (no mocking `src/matcher.ts` or `src/similarity.ts`); only the
 * Obsidian `App`/`Plugin` shell is a mock (tests/mocks/obsidian.ts). Covers G2, G3, E11 (undo,
 * paste, own-tag), E2, and the F5 selection/scroll check.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import { OWN_FOLD_ANNOTATION } from "../../src/fold-recorder";
import type { FileFoldRecord } from "../../src/types";

const NOTE_PATH = "Projects/Quarry/Tasks.md";

async function makeStore(seed?: Record<string, FileFoldRecord>): Promise<{ store: FoldStore; readSaved: () => unknown }> {
	let stored: unknown = seed ? { version: 1, files: seed } : null;
	const store = new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data;
		},
	});
	await store.load();
	return { store, readSaved: () => stored };
}

function makeView(store: FoldStore, doc: string, selection?: { anchor: number }): EditorView {
	const watcher = createEditorWatcher({ store, window });
	const state = EditorState.create({
		doc,
		selection,
		extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
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

function liveFoldedLineRanges(view: EditorView): { startLine: number; endLine: number }[] {
	return liveFoldedRanges(view).map(({ from, to }) => ({
		startLine: view.state.doc.lineAt(from).number,
		endLine: view.state.doc.lineAt(to).number,
	}));
}

async function settle(): Promise<void> {
	// No fake timers in this file (vi.advanceTimersByTimeAsync and a real EditorView's own
	// internal scheduling don't always mix cleanly); the 150ms settle window and the matcher's
	// chunk yields are both real-timer waits here instead.
	await new Promise((resolve) => setTimeout(resolve, 300));
}

const BEFORE = ["## Tuesday", "Some text under the heading.", "", "- [ ] Draft proposal", "\t- [ ] Outline", "\t- [ ] Draft"].join("\n");

const TUESDAY_ANCHOR = { kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] };
const DRAFT_PROPOSAL_ANCHOR = { kind: "task", indent: 0, text: "draft proposal", siblingIndex: 0, parentChain: [] };

describe("restore-cm6: G2 — external edit above the fold, anchor text untouched", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("4 lines inserted above: the heading stays folded on the shifted range", async () => {
		const { store } = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const view = makeView(store, BEFORE);

		const after = ["intro 1", "intro 2", "intro 3", "intro 4", ...BEFORE.split("\n")].join("\n");
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: after },
			annotations: Transaction.userEvent.of("set"),
		});

		await settle();

		const folded = liveFoldedLineRanges(view);
		expect(folded).toHaveLength(1);
		expect(folded[0].startLine).toBe(5); // "## Tuesday" is now on line 5
	});
});

describe("restore-cm6: G3 — external edit inside the folded body (children added/removed/edited)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("the task stays folded, and the renamed task + edited child are both hidden under it", async () => {
		const { store } = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [DRAFT_PROPOSAL_ANCHOR], dormant: [] } });
		const view = makeView(store, BEFORE);

		const after = ["## Tuesday", "Some text under the heading.", "", "- [ ] Draft proposal v2", "\t- [x] Outline", "\t- [ ] Draft", "\t- [ ] Review"].join(
			"\n",
		);
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: after },
			annotations: Transaction.userEvent.of("set"),
		});

		await settle();

		const folded = liveFoldedLineRanges(view);
		expect(folded).toHaveLength(1);
		// "- [ ] Draft proposal v2" is line 4; its subtree runs to line 7 ("Review").
		expect(folded[0]).toEqual({ startLine: 4, endLine: 7 });
	});
});

describe("restore-cm6: E2 — a non-exact tie folds neither candidate", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("two equally-plausible renamed headings: neither is folded", async () => {
		const before = ["## Alpha", "a body", "## Beta", "b body"].join("\n");
		const anchor = { kind: "heading", indent: 0, text: "alpha", siblingIndex: 0, parentChain: [] };
		const { store } = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [anchor], dormant: [] } });
		const view = makeView(store, before);

		// Both headings are renamed to the exact same new text — "alpha" has nothing left to
		// exact/positionally prefer one over the other on text alone, and a top-level anchor's
		// positional tier only ever has itself to compare against at its own (unique) sibling
		// index, so this is engineered to land as an ambiguous *fuzzy* tie instead: give both
		// candidates equally similar (but not identical) text to "alpha".
		const after = ["## Alphx", "a body", "## Alphy", "b body"].join("\n");
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: after },
			annotations: Transaction.userEvent.of("set"),
		});

		await settle();
		expect(liveFoldedRanges(view)).toHaveLength(0);
	});
});

describe("restore-cm6: E11 — undo, paste and the plugin's own tag", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("a paste (annotated input.paste) is a user change and never triggers a restore", async () => {
		const { store } = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const view = makeView(store, BEFORE);
		const dispatchSpy = vi.spyOn(view, "dispatch");

		view.dispatch({
			changes: { from: 0, to: 0, insert: "pasted text\n" },
			annotations: Transaction.userEvent.of("input.paste"),
		});

		await settle();
		// Only the explicit paste dispatch above — no restore-triggered dispatch followed it.
		expect(dispatchSpy).toHaveBeenCalledTimes(1);
		expect(liveFoldedRanges(view)).toHaveLength(0);
	});

	it("undo (annotated undo) is a user change and never triggers a restore", async () => {
		const { store } = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const view = makeView(store, BEFORE);
		const dispatchSpy = vi.spyOn(view, "dispatch");

		view.dispatch({
			changes: { from: 0, to: 4, insert: "####" },
			annotations: Transaction.userEvent.of("undo"),
		});

		await settle();
		expect(dispatchSpy).toHaveBeenCalledTimes(1);
	});

	it("the restore's own dispatched fold effects carry OWN_FOLD_ANNOTATION", async () => {
		const { store } = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const view = makeView(store, BEFORE);

		const seenAnnotations: unknown[] = [];
		const originalDispatch = view.dispatch.bind(view);
		vi.spyOn(view, "dispatch").mockImplementation((...args: Parameters<typeof view.dispatch>) => {
			const [spec] = args;
			if (spec && typeof spec === "object" && "effects" in spec) {
				const tr = view.state.update(spec as never);
				seenAnnotations.push(tr.annotation(OWN_FOLD_ANNOTATION));
			}
			return originalDispatch(...args);
		});

		// A trailing "## Another" heading closes off Tuesday's own section, so the cursor
		// (parked at the very end of the document, inside "## Another") sits clearly outside
		// the block the restore is about to re-fold — otherwise G13 would defer it instead.
		const after = BEFORE + "\n## Another";
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: after },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: after.length },
		});

		await settle();
		expect(seenAnnotations.some((a) => a === true)).toBe(true);
	});
});

describe("restore-cm6: F5 — the restore never moves the cursor, selection or scroll position beyond G13", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("selection is unchanged across a restore when the cursor sits outside every matched block", async () => {
		const { store } = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const view = makeView(store, BEFORE);

		// A trailing "## Another" heading closes off Tuesday's own section, so the cursor
		// (parked at the very end of the document) sits clearly outside the block the restore
		// is about to re-fold.
		const after = ["intro 1", "intro 2", "intro 3", "intro 4", ...BEFORE.split("\n"), "## Another"].join("\n");
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: after },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: after.length },
		});

		const selectionBeforeSettle = view.state.selection.main.head;
		await settle();
		expect(liveFoldedRanges(view)).toHaveLength(1); // sanity: the restore actually ran, not just skipped
		expect(view.state.selection.main.head).toBe(selectionBeforeSettle);
	});
});
