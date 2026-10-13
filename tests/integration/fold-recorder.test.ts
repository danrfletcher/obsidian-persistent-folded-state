/**
 * G1, G15, E3 and own-effect tagging (E11), against a real `EditorState`/`EditorView` built over
 * the fixture note (tests/fixtures/fixture-note.md) — not a fake. The store is faked in memory
 * (an in-memory `loadData`/`saveData` pair); `tests/integration/data-json.test.ts` already covers
 * the real-file round trip for `FoldStore` itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { editorInfoField } from "../../tests/mocks/obsidian";
import { FoldStore } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import { OWN_FOLD_ANNOTATION } from "../../src/fold-recorder";
import type { FileFoldRecord } from "../../src/types";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fixture-note.md");
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");
const NOTE_PATH = "Fixtures/fixture-note.md";

/** An in-memory stand-in for Obsidian's `loadData`/`saveData`; `readSaved()` lets a test look at
 * what was actually flushed to "disk", distinct from the in-memory map `store.get()` reads. */
function makeStore(): { store: FoldStore; readSaved: () => { files: Record<string, FileFoldRecord> } | null } {
	let stored: { files: Record<string, FileFoldRecord> } | null = null;
	const store = new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data as { files: Record<string, FileFoldRecord> };
		},
	});
	return { store, readSaved: () => stored };
}

function makeView(store: FoldStore, onSettledNonUserChange?: (path: string, text: string) => void): EditorView {
	const watcher = createEditorWatcher({ store, onSettledNonUserChange, window });
	const state = EditorState.create({
		doc: FIXTURE_TEXT,
		extensions: [watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
	});
	return new EditorView({ state, parent: document.body });
}

/** Line numbers (1-indexed) of one example of each foldable kind in the fixture note. */
const LINES = {
	frontmatter: 1, // "---"
	heading: 10, // "## Tuesday"
	list: 14, // "- Plain list item"
	task: 17, // "- [ ] Draft proposal"
	blockquote: 23, // "> A blockquote"
	callout: 26, // "> [!note] A callout"
	codeBlock: 29, // "```js"
} as const;

function lineStart(view: EditorView, lineNumber: number): number {
	return view.state.doc.line(lineNumber).from;
}

describe("fold recorder integration (real EditorState/EditorView over the fixture note)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it.each(Object.entries(LINES))("G1: folding the %s line adds one entry of that kind to the store", (kind, lineNumber) => {
		const { store } = makeStore();
		const view = makeView(store);
		const from = lineStart(view, lineNumber);

		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		const record = store.get(NOTE_PATH);
		expect(record?.folds).toHaveLength(1);
		expect((record?.folds[0] as { kind: string }).kind).toBe(kind === "codeBlock" ? "code-block" : kind);
	});

	it("G1: unfolding removes the matching entry; the store flushes it (debounced)", async () => {
		vi.useFakeTimers();
		const { store, readSaved } = makeStore();
		const view = makeView(store);
		const from = lineStart(view, LINES.heading);

		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);

		view.dispatch({ effects: [unfoldEffect.of({ from, to: from + 1 })] });
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(200);
		expect(readSaved()?.files[NOTE_PATH]).toEqual({ contentHash: expect.any(String), folds: [], dormant: [] });
		vi.useRealTimers();
	});

	it("G1: each recorded fold stores the note's current content hash", () => {
		const { store } = makeStore();
		const view = makeView(store);
		const from = lineStart(view, LINES.heading);

		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		const record = store.get(NOTE_PATH);
		expect(record?.contentHash).toBeTypeOf("string");
		expect(record?.contentHash.length).toBeGreaterThan(0);
	});

	it("G15: an external write with an empty map dispatches zero fold/unfold effects and leaves folded ranges unchanged", () => {
		const { store } = makeStore();
		const view = makeView(store);
		const dispatchSpy = vi.spyOn(view, "dispatch");
		const before = foldedRanges(view.state).size;

		// Simulate "the reload shape": a document-changing transaction with no user-event
		// annotation, exactly as an external rewrite would look at the CM6 level.
		view.dispatch({ changes: { from: 0, to: 0, insert: "injected above\n" } });

		// Our own code never calls dispatch — the one call recorded is the external write above.
		expect(dispatchSpy).toHaveBeenCalledTimes(1);
		expect(foldedRanges(view.state).size).toBe(before);
		expect(store.get(NOTE_PATH)).toBeUndefined();
	});

	it("E3: a fold made while the settle timer is pending is recorded immediately and survives settling", async () => {
		vi.useFakeTimers();
		const onSettledNonUserChange = vi.fn();
		const { store } = makeStore();
		const view = makeView(store, onSettledNonUserChange);

		// Starts the 150ms settle timer (non-user change).
		view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });

		// A user fold mid-burst, before the timer elapses.
		const from = lineStart(view, LINES.heading);
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(150);
		expect(onSettledNonUserChange).toHaveBeenCalledTimes(1);
		// Nothing in the settle handling touches the folds map.
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);
		vi.useRealTimers();
	});

	it("E3: an unfold made mid-burst removes the entry and it does not come back at settle", async () => {
		vi.useFakeTimers();
		const { store } = makeStore();
		const view = makeView(store);
		const from = lineStart(view, LINES.heading);
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		view.dispatch({ changes: { from: 0, to: 0, insert: "x" } }); // starts the settle timer
		// The insert shifted every later offset by one character; CM6's own fold state remaps
		// through this via each effect's `map` function (StateEffect.define({ map: mapRange })),
		// so the *live* folded position — not the stale one captured before the insert — is what
		// a real unfold (gutter click, fold command) would target.
		const liveFrom = lineStart(view, LINES.heading);
		view.dispatch({ effects: [unfoldEffect.of({ from: liveFrom, to: liveFrom + 1 })] });
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(150);
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(0);
		vi.useRealTimers();
	});

	describe("own-effect tagging (E11)", () => {
		it("a fold effect tagged with OWN_FOLD_ANNOTATION is ignored, not recorded as a user fold", () => {
			const { store } = makeStore();
			const view = makeView(store);
			const from = lineStart(view, LINES.heading);

			view.dispatch({
				effects: [foldEffect.of({ from, to: from + 1 })],
				annotations: OWN_FOLD_ANNOTATION.of(true),
			});

			expect(store.get(NOTE_PATH)).toBeUndefined();
		});

		it("the same effect, untagged, is recorded as a user fold", () => {
			const { store } = makeStore();
			const view = makeView(store);
			const from = lineStart(view, LINES.heading);

			view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

			expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);
		});
	});
});
