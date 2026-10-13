/**
 * The CM6 extension this PR registers through `registerEditorExtension` (main.ts). One
 * `ViewPlugin` instance exists per open editor — CM6's own lifecycle creates one when a pane
 * opens and destroys it when the pane closes — so "attaches to editors already open at plugin
 * load and to editors opened later" and "detaches cleanly on unload with no leaked listeners"
 * both fall out of CM6's own plumbing rather than needing bespoke attach/detach bookkeeping
 * here: `registerEditorExtension` is a `Component`-scoped registration that Obsidian
 * reconfigures every open editor's extensions with (existing panes immediately, new panes as
 * they're created), and tears back out again on plugin unload, destroying every live
 * `ViewPlugin` instance (and, with it, this file's per-view settle timer) in the process.
 *
 * Per update, every transaction the view sees is:
 * - checked for fold/unfold effects (src/fold-recorder.ts) and recorded against the open file's
 *   path, read once per update from Obsidian's own `editorInfoField` — not tracked separately.
 * - classified (src/transaction-classifier.ts); a "non-user" classification (a document change
 *   with no user-event annotation) (re)triggers the 150ms settle timer (E9/E10). A bare
 *   fold/unfold or a selection-only change classifies as "no-change" and never touches the timer.
 *
 * Non-Markdown views (editorInfoField resolving to no file, or a file whose extension isn't
 * "md") are ignored entirely: neither the settle timer nor the fold recorder ever runs for them.
 * G1's "in both Live Preview and Source mode" isn't handled with separate code paths here on
 * purpose — the transaction and fold-effect shapes this file reads are identical in both modes
 * (CM6 runs the one editor engine either way); which mode is active is proven to make no
 * difference by the container run, not by a branch in this file.
 *
 * "Added": a thrown error inside the classifier or recorder is caught and logged per-transaction,
 * so one bad transaction can never block the rest of the batch, and a bug here can never stop
 * typing or folding in the editor itself.
 */
import { ViewPlugin, type EditorView, type ViewUpdate, type PluginValue } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { classifyTransaction } from "./transaction-classifier";
import { recordFoldEffects } from "./fold-recorder";
import { SettleDebouncer } from "./settle-debounce";
import type { FoldStore } from "./fold-store";

export interface EditorWatcherDeps {
	store: FoldStore;
	/** Called once 150ms after the last non-user change in a burst settles (E9/E10). `text` is
	 * the document text from the transaction that actually settled — "the last settled text
	 * wins" (E9). */
	onSettledNonUserChange?: (path: string, text: string) => void;
	/** Overridable only for tests; defaults to the 150ms the spec fixes for E9. */
	flushDelayMs?: number;
	/** Overridable only for tests (fake timers); defaults to the real `window`. */
	window?: Window;
}

function activeMarkdownPath(view: EditorView): string | null {
	const info = view.state.field(editorInfoField, false);
	const file = info?.file;
	if (!file || file.extension !== "md") return null;
	return file.path;
}

/** Builds the extension. A fresh call per `registerEditorExtension` is fine — and necessary,
 * since each `ViewPlugin` instance below carries its own per-view settle timer. */
export function createEditorWatcher(deps: EditorWatcherDeps) {
	class EditorWatcherPlugin implements PluginValue {
		private readonly debouncer: SettleDebouncer<{ path: string; text: string }>;

		constructor(_view: EditorView) {
			this.debouncer = new SettleDebouncer(
				({ path, text }) => deps.onSettledNonUserChange?.(path, text),
				deps.flushDelayMs ?? 150,
				deps.window ?? window
			);
		}

		update(update: ViewUpdate): void {
			if (update.transactions.length === 0) return;
			const path = activeMarkdownPath(update.view);
			if (!path) return;

			for (const tr of update.transactions) {
				try {
					recordFoldEffects(deps.store, path, tr);
					if (classifyTransaction(tr) === "non-user") {
						this.debouncer.trigger({ path, text: tr.state.doc.toString() });
					}
				} catch (err) {
					console.error("persistent-folded-state: editor watcher failed", err);
				}
			}
		}

		destroy(): void {
			this.debouncer.cancel();
		}
	}

	return ViewPlugin.fromClass(EditorWatcherPlugin);
}
