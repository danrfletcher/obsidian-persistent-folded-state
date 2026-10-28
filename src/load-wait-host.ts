/**
 * The real-app side of the wait/guard in `src/load-wait.ts` (ticket warkworth-46, PR-2): builds the
 * `LoadWaitIo` a wait needs from a live Obsidian `App` and the pane's CM6 `EditorView`.
 *
 * - The disk text is `app.vault.adapter.read(path)`, never `cachedRead` (which can itself serve
 *   the empty text the editor shows). It is read only to compare with the editor, never matched.
 * - The vault `modify`, `delete` and `rename` events are listened to only while a wait is open and
 *   are removed with `offref` when it ends. `modify` makes the wait read the disk again; the other
 *   two end it as read-failed. Nothing here writes to a note.
 * - The pane's file path is found by looking for the leaf whose editor is this very view, so two
 *   panes on one note never answer for each other.
 * - Editor text changes reach a wait through one `EditorView.updateListener` per pane, held in a
 *   `Compartment` that is switched on while some wait listens and off again when none does.
 */
import { Compartment, StateEffect } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App, EventRef, TAbstractFile, TFile } from "obsidian";
import type { LoadWaitIo, Unsubscribe } from "./load-wait";
import { classifyTransaction } from "./transaction-classifier";

type EditorChange = { userEdit: boolean };

interface PaneWatch {
	compartment: Compartment;
	listener: Extension;
	callbacks: Set<(change: EditorChange) => void>;
}

const paneWatches = new WeakMap<EditorView, PaneWatch>();

function watchFor(view: EditorView): PaneWatch {
	let watch = paneWatches.get(view);
	if (watch) return watch;
	const callbacks = new Set<(change: EditorChange) => void>();
	watch = {
		compartment: new Compartment(),
		callbacks,
		listener: EditorView.updateListener.of((update) => {
			if (!update.docChanged) return;
			const userEdit = update.transactions.some((tr) => classifyTransaction(tr) === "user");
			for (const cb of [...callbacks]) cb({ userEdit });
		}),
	};
	paneWatches.set(view, watch);
	return watch;
}

/** Calls `cb` after every change to `view`'s document. Returns the function that stops it. */
export function watchEditorChanges(view: EditorView, cb: (change: EditorChange) => void): Unsubscribe {
	const watch = watchFor(view);
	watch.callbacks.add(cb);
	try {
		const current = watch.compartment.get(view.state);
		if (current === undefined) {
			view.dispatch({ effects: StateEffect.appendConfig.of(watch.compartment.of(watch.listener)) });
		} else if (current !== watch.listener) {
			view.dispatch({ effects: watch.compartment.reconfigure(watch.listener) });
		}
	} catch {
		// Not installable right now (an update is in progress, or the view is gone). The wait's
		// slow recheck still sees the text arrive.
	}
	return () => {
		watch.callbacks.delete(cb);
		// Taken out of the editor a microtask later, and only if nobody listens by then: this can
		// be called from inside the very update that ended the wait, where a dispatch is refused.
		queueMicrotask(() => {
			if (watch.callbacks.size > 0 || !view.dom.isConnected) return;
			try {
				if (watch.compartment.get(view.state) === watch.listener) {
					view.dispatch({ effects: watch.compartment.reconfigure([]) });
				}
			} catch {
				// The view went away in between.
			}
		});
	};
}

/** The CM6 view behind an Obsidian editor object, by the same undocumented route `main.ts` uses. */
function cmOf(editor: unknown): EditorView | null {
	return (editor as { cm?: EditorView } | undefined)?.cm ?? null;
}

/** The file the leaf showing `view` has open, or null when no leaf shows it. */
export function paneFilePathOf(app: App, view: EditorView): string | null {
	const active = app.workspace.activeEditor;
	if (active && cmOf(active.editor) === view) return active.file?.path ?? null;
	let found: string | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		const pane = leaf.view as unknown as { file?: TFile | null; editor?: unknown };
		if (found === null && pane.editor !== undefined && cmOf(pane.editor) === view) found = pane.file?.path ?? null;
	});
	return found;
}

export interface LoadWaitHostDeps {
	app: App;
	view: EditorView;
	/** The window whose timers back the wait. Defaults to the real `window`. */
	window?: Window;
}

export function createLoadWaitIo(deps: LoadWaitHostDeps): LoadWaitIo {
	const { app, view } = deps;
	const win = deps.window ?? window;
	return {
		paneFilePath: () => paneFilePathOf(app, view),
		editorText: () => view.state.doc.toString(),
		isAlive: () => view.dom.isConnected,
		readDisk: (path) => app.vault.adapter.read(path),
		onEditorChange: (cb) => watchEditorChanges(view, cb),
		onFileEvent: (path, cb) => {
			const refs: EventRef[] = [
				app.vault.on("modify", (file: TAbstractFile) => {
					if (file.path === path) cb("modify");
				}),
				app.vault.on("delete", (file: TAbstractFile) => {
					if (file.path === path) cb("gone");
				}),
				app.vault.on("rename", (_file: TAbstractFile, oldPath: string) => {
					if (oldPath === path) cb("gone");
				}),
			];
			return () => {
				for (const ref of refs) app.vault.offref(ref);
			};
		},
		setTimer: (fn, ms) => win.setTimeout(fn, ms),
		clearTimer: (handle) => win.clearTimeout(handle as number),
	};
}
