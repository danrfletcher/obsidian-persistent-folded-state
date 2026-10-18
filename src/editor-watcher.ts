/**
 * The CM6 extension this PR registers through `registerEditorExtension` (main.ts). One
 * `ViewPlugin` instance exists per open editor — CM6's own lifecycle creates one when a pane
 * opens and destroys it when the pane closes — so "attaches to editors already open at plugin
 * load and to editors opened later" and "detaches cleanly on unload with no leaked listeners"
 * both fall out of CM6's own plumbing rather than needing bespoke attach/detach bookkeeping
 * here: `registerEditorExtension` is a `Component`-scoped registration that Obsidian
 * reconfigures every open editor's extensions with (existing panes immediately, new panes as
 * they're created), and tears back out again on plugin unload, destroying every live
 * `ViewPlugin` instance (and, with it, this file's per-view settle timer and pending deferred
 * folds) in the process.
 *
 * Per update, every transaction the view sees is:
 * - checked for fold/unfold effects (src/fold-recorder.ts) and recorded against the open file's
 *   path, read once per update from Obsidian's own `editorInfoField` — not tracked separately.
 * - classified (src/transaction-classifier.ts); a "non-user" classification (a document change
 *   with no user-event annotation) (re)triggers the 150ms settle timer (E9/E10).
 *
 * PR-5: once that settle timer actually elapses, this file no longer just forwards the event —
 * it also runs the real restore pass for *this* view (src/fold-restorer.ts's
 * `restoreSettledChange`): snapshot the stored anchors, match them against the settled text,
 * and dispatch tagged fold effects for whatever matched (G2/G3/G11/G14/G15, E2/E3/E6/E9/E11).
 * Because one `ViewPlugin` instance (and one settle timer) exists per pane, two panes on the
 * same file each run this independently against the one shared `FoldStore` and land on the same
 * result without any pane-to-pane coordination here (G11) — see the file comment in
 * fold-restorer.ts. Whatever G13 defers (the cursor sits inside a block that would be re-folded)
 * is kept in `pendingDeferred` and re-checked on every later update via
 * `applyReadyDeferredFolds`, regardless of what kind of transaction that update carries, so a
 * plain cursor move (no document change at all) is enough to apply it.
 *
 * Non-Markdown views (editorInfoField resolving to no file, or a file whose extension isn't
 * "md") are ignored entirely: neither the settle timer, the fold recorder nor the restore ever
 * runs for them (F3: no fold is ever applied outside a Markdown editor).
 *
 * "Added": a thrown error inside the classifier, recorder or deferred-fold recheck is caught and
 * logged per-update, so one bad transaction can never block the rest of the batch, and a bug
 * here can never stop typing or folding in the editor itself. The restore pass itself is async
 * and runs detached from `update()` (dispatching happens once the match resolves, not
 * synchronously) — a rejection there is caught and logged the same way, never left as an
 * unhandled promise rejection.
 */
import { ViewPlugin, type EditorView, type ViewUpdate, type PluginValue } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { classifyTransaction } from "./transaction-classifier";
import { recordFoldEffects } from "./fold-recorder";
import { SettleDebouncer } from "./settle-debounce";
import { restoreSettledChange, applyReadyDeferredFolds } from "./fold-restorer";
import type { FoldTarget } from "./restore-plan";
import type { MatcherOptions } from "./matcher";
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
	/** Passed through to the matcher for the restore pass (PR-5); overridable only for tests
	 * (e.g. to shrink the caps/thresholds, or to spy on `yieldToHost`). */
	matcherOptions?: MatcherOptions;
}

function activeMarkdownPath(view: EditorView): string | null {
	const info = view.state.field(editorInfoField, false);
	const file = info?.file;
	if (!file || file.extension !== "md") return null;
	return file.path;
}

/** Builds the extension. A fresh call per `registerEditorExtension` is fine — and necessary,
 * since each `ViewPlugin` instance below carries its own per-view settle timer and deferred-fold
 * queue. */
export function createEditorWatcher(deps: EditorWatcherDeps) {
	class EditorWatcherPlugin implements PluginValue {
		private readonly debouncer: SettleDebouncer<{ path: string; text: string }>;
		private readonly view: EditorView;
		/** G13: targets a restore pass deferred because the cursor sat inside them, re-checked
		 * on every later update (see `runRestore`/`update` below). */
		private pendingDeferred: FoldTarget[] = [];

		constructor(view: EditorView) {
			this.view = view;
			this.debouncer = new SettleDebouncer(
				({ path, text }) => {
					deps.onSettledNonUserChange?.(path, text);
					this.runRestore(path, text);
				},
				deps.flushDelayMs ?? 150,
				deps.window ?? window
			);
		}

		private runRestore(path: string, text: string): void {
			restoreSettledChange(this.view, path, text, {
				store: deps.store,
				matcherOptions: deps.matcherOptions,
				window: deps.window ?? window,
				getActivePath: activeMarkdownPath,
			})
				.then((deferred) => {
					this.pendingDeferred = deferred;
				})
				.catch((err: unknown) => {
					console.error("persistent-folded-state: restore failed", err);
				});
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

			if (this.pendingDeferred.length > 0) {
				try {
					this.pendingDeferred = applyReadyDeferredFolds(update.view, this.pendingDeferred);
				} catch (err) {
					console.error("persistent-folded-state: deferred restore failed", err);
				}
			}
		}

		destroy(): void {
			this.debouncer.cancel();
			this.pendingDeferred = [];
		}
	}

	return ViewPlugin.fromClass(EditorWatcherPlugin);
}
