/**
 * The "Added" acceptance item: attach, detach, late-opened editor, non-Markdown view, error
 * isolation — for the CM6 extension itself (src/editor-watcher.ts). Obsidian's workspace isn't
 * involved here: CM6's own `ViewPlugin` lifecycle (one instance per `EditorView`, created when
 * the view is built and destroyed when `view.destroy()` runs) *is* the attach/detach mechanism
 * `registerEditorExtension` relies on — see the file comment in src/editor-watcher.ts — so this
 * file proves that mechanism directly against real `EditorState`/`EditorView` instances rather
 * than against a mocked Obsidian workspace, which doesn't actually implement any of this.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldEffect } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";

function makeStore(): FoldStore {
	let stored: unknown = null;
	return new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data;
		},
	});
}

function stateFor(file: { path: string; extension: string } | null, extraExtensions: unknown[] = []) {
	return EditorState.create({
		doc: "# Heading\nbody text",
		extensions: [editorInfoField.init(() => ({ file })), ...(extraExtensions as never[])],
	});
}

describe("editor watcher lifecycle (CM6 ViewPlugin attach/detach)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("attaches to an editor already open when the extension is created (no separate wiring needed)", () => {
		const store = makeStore();
		const watcher = createEditorWatcher({ store });
		const state = EditorState.create({
			doc: "# Heading\nbody",
			extensions: [watcher, editorInfoField.init(() => ({ file: { path: "Open.md", extension: "md" } }))],
		});
		const view = new EditorView({ state, parent: document.body });

		const from = view.state.doc.line(1).from;
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		expect(store.get("Open.md")?.folds).toHaveLength(1);
		view.destroy();
	});

	it("attaches to an editor opened later: a second, independent view with the same extension works the same way", () => {
		const store = makeStore();
		const watcher = createEditorWatcher({ store });

		const firstView = new EditorView({
			state: EditorState.create({
				doc: "# A\nbody",
				extensions: [watcher, editorInfoField.init(() => ({ file: { path: "First.md", extension: "md" } }))],
			}),
			parent: document.body,
		});
		// "Opened later": built from the same watcher extension, after the first view exists.
		const secondView = new EditorView({
			state: EditorState.create({
				doc: "# B\nbody",
				extensions: [watcher, editorInfoField.init(() => ({ file: { path: "Second.md", extension: "md" } }))],
			}),
			parent: document.body,
		});

		const firstFrom = firstView.state.doc.line(1).from;
		firstView.dispatch({ effects: [foldEffect.of({ from: firstFrom, to: firstFrom + 1 })] });
		const secondFrom = secondView.state.doc.line(1).from;
		secondView.dispatch({ effects: [foldEffect.of({ from: secondFrom, to: secondFrom + 1 })] });

		expect(store.get("First.md")?.folds).toHaveLength(1);
		expect(store.get("Second.md")?.folds).toHaveLength(1);
		firstView.destroy();
		secondView.destroy();
	});

	it("ignores a non-Markdown view (no file at all): no settle timer, no fold recorded", async () => {
		vi.useFakeTimers();
		const store = makeStore();
		const onSettledNonUserChange = vi.fn();
		const watcher = createEditorWatcher({ store, onSettledNonUserChange });
		const view = new EditorView({
			state: EditorState.create({
				doc: "whatever this editor is (canvas text node, etc.)",
				extensions: [watcher, editorInfoField.init(() => ({ file: null }))],
			}),
			parent: document.body,
		});

		view.dispatch({ changes: { from: 0, to: 0, insert: "x" } }); // would-be non-user change
		const from = view.state.doc.line(1).from;
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] }); // would-be user fold

		await vi.advanceTimersByTimeAsync(200);
		expect(onSettledNonUserChange).not.toHaveBeenCalled();
		expect(store.size).toBe(0);
		view.destroy();
		vi.useRealTimers();
	});

	it("ignores a non-Markdown view (a file whose extension isn't .md)", () => {
		const store = makeStore();
		const watcher = createEditorWatcher({ store });
		const view = new EditorView({
			state: EditorState.create({
				doc: "binary-ish preview text",
				extensions: [watcher, editorInfoField.init(() => ({ file: { path: "image.png", extension: "png" } }))],
			}),
			parent: document.body,
		});

		const from = view.state.doc.line(1).from;
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		expect(store.size).toBe(0);
		view.destroy();
	});

	it("detaches cleanly on unload (view destroy): a pending settle timer never fires afterwards", async () => {
		vi.useFakeTimers();
		const store = makeStore();
		const onSettledNonUserChange = vi.fn();
		const watcher = createEditorWatcher({ store, onSettledNonUserChange });
		const view = new EditorView({
			state: stateFor({ path: "Tasks.md", extension: "md" }, [watcher]),
			parent: document.body,
		});

		view.dispatch({ changes: { from: 0, to: 0, insert: "x" } }); // starts the 150ms settle timer
		view.destroy(); // "unload": CM6 calls ViewPlugin.destroy() here

		await vi.advanceTimersByTimeAsync(1000);
		expect(onSettledNonUserChange).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it("a thrown error inside the recorder is caught and logged; later transactions still work", () => {
		const store = makeStore();
		vi.spyOn(store, "get").mockImplementationOnce(() => {
			throw new Error("boom");
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const watcher = createEditorWatcher({ store });
		const view = new EditorView({
			state: stateFor({ path: "Tasks.md", extension: "md" }, [watcher]),
			parent: document.body,
		});

		const from = view.state.doc.line(1).from;
		// First fold effect: store.get() throws once (mockImplementationOnce) — must not escape
		// `update()` or stop the editor from working.
		expect(() => view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] })).not.toThrow();
		expect(consoleError).toHaveBeenCalledWith("persistent-folded-state: editor watcher failed", expect.any(Error));

		// Typing and folding keep working afterwards (store.get() no longer throws).
		expect(() => view.dispatch({ changes: { from: 0, to: 0, insert: "more text " } })).not.toThrow();
		const from2 = view.state.doc.line(1).from;
		view.dispatch({ effects: [foldEffect.of({ from: from2, to: from2 + 1 })] });
		expect(store.get("Tasks.md")?.folds.length).toBeGreaterThan(0);

		consoleError.mockRestore();
		view.destroy();
	});
});
