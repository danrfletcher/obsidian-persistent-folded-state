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
 *   with no user-event annotation) (re)triggers the 150ms settle timer (E9/E10) and starts a
 *   fresh snapshot (R1, below).
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
 * R1 ("a user keystroke during the settle window or the match window silently drops the whole
 * restore"): `generation` counts every non-user change this view has seen; a restore run
 * captures it at the moment its settle fires and compares it again right before dispatching
 * (`isSuperseded`), so it only ever gives up when a *newer* non-user change has genuinely
 * superseded it (E9), not merely because the user typed in between. `changesSinceSnapshot`
 * accumulates every change (of any kind — user or not) the view sees from the moment a
 * non-user change starts a fresh snapshot onward, reset exactly then and composed into on every
 * later transaction, so `restoreSettledChange` can map its candidates forward onto whatever the
 * live document has become by the time matching finishes (src/fold-restorer.ts's own file
 * comment has the detail).
 *
 * R2 (G13 deferred targets going stale): `pendingDeferred` now holds character-offset spans
 * (`DeferredFoldTarget`), not line numbers, mapped forward through every update's own changes
 * (`mapDeferredTargets`) before the cursor check runs — so a line added or removed inside or
 * around a deferred block never leaves it pointing at the wrong lines. The recheck also reads
 * the store's *live* anchor keys right before applying (`liveAnchorKeySet`), the same E3 guard
 * `restoreSettledChange`'s own immediate path already had — a target whose anchor the user has
 * since unfolded, or "Forget stored folds for this note" removed, is dropped instead of applied.
 *
 * Non-Markdown views (editorInfoField resolving to no file, or a file whose extension isn't
 * "md") are ignored entirely: neither the settle timer, the fold recorder nor the restore ever
 * runs for them (F3: no fold is ever applied outside a Markdown editor).
 *
 * PR-6 (E5/G15, first-open baseline): a brand-new pane's `EditorView` already has its full
 * initial `EditorState` — including whatever CM6 fold state that state was constructed with —
 * before this plugin's `update()` ever runs for it (CM6 builds a `ViewPlugin`'s initial value in
 * the view's constructor, with no transaction involved). So the constructor below checks once,
 * synchronously, for "a Markdown file with no store entry at all" and adopts a baseline
 * (`src/baseline.ts`) right there if so — dispatching nothing, same as the settled-change path's
 * own no-entry branch (`src/fold-restorer.ts`) handles the other real-world trigger for the same
 * case: navigating to a never-before-opened file in a pane Obsidian reuses (no new `ViewPlugin`,
 * but a "set"-annotated transaction the settle path already treats as a reload). Both paths
 * share the same "store has no entry" guard, so whichever runs first wins and the other is a
 * no-op.
 *
 * "Added": a thrown error inside the classifier, recorder or deferred-fold recheck is caught and
 * logged per-update, so one bad transaction can never block the rest of the batch, and a bug
 * here can never stop typing or folding in the editor itself. The restore pass itself is async
 * and runs detached from `update()` (dispatching happens once the match resolves, not
 * synchronously) — a rejection there is caught and logged the same way, never left as an
 * unhandled promise rejection.
 */
import { ChangeSet } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate, type PluginValue } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { classifyTransaction } from "./transaction-classifier";
import { recordFoldEffects } from "./fold-recorder";
import { SettleDebouncer } from "./settle-debounce";
import {
	restoreSettledChange,
	applyReadyDeferredFolds,
	liveAnchorKeySet,
	mapDeferredTargets,
	type DeferredFoldTarget,
} from "./fold-restorer";
import { buildBaseline } from "./baseline";
import type { MatcherOptions } from "./matcher";
import type { FoldStore } from "./fold-store";
import type { StoredAnchor } from "./types";

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
	/** PR-6 (G6): clock passed through to `restoreSettledChange`'s dormant handling. Defaults to
	 * `Date.now`; overridable so a test can drive dormancy/expiry with a fake clock. */
	now?: () => number;
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
		 * on every later update (see `runRestore`/`update` below). Character-offset spans, not
		 * line numbers (R2) — mapped forward through every update's changes before use. */
		private pendingDeferred: DeferredFoldTarget[] = [];
		/** R1: bumped on every non-user change; a restore run captures this at settle time and
		 * compares it again right before dispatching, so it can tell "a newer non-user change
		 * has superseded me" (bail) apart from "the user typed in between" (re-anchor, don't
		 * bail) — see src/fold-restorer.ts's file comment. */
		private generation = 0;
		/** R1: every change (of any kind) the view has seen since the most recent non-user
		 * change started a fresh snapshot — `null` until the first non-user change ever happens,
		 * since nothing can be in flight before then. Reset (not composed) exactly when a new
		 * non-user change starts a newer snapshot; composed into on every other change so it
		 * always represents "the current snapshot's text -> the live document". */
		private changesSinceSnapshot: ChangeSet | null = null;
		private destroyed = false;

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

			// E5/G15: a brand-new pane for a Markdown file the store has never seen — adopt
			// Obsidian's current fold state as the baseline, synchronously, before any
			// transaction runs. See the file comment for why this is only one of the two
			// places this same "no entry" case is handled.
			try {
				const path = activeMarkdownPath(view);
				if (path && !deps.store.get(path)) {
					const baseline = buildBaseline(view.state, view.state.doc.toString());
					deps.store.set(path, {
						contentHash: baseline.contentHash,
						folds: baseline.anchors as unknown as StoredAnchor[],
						dormant: [],
					});
				}
			} catch (err) {
				console.error("persistent-folded-state: first-open baseline failed", err);
			}
		}

		private runRestore(path: string, text: string): void {
			const startGeneration = this.generation;
			restoreSettledChange(this.view, path, text, {
				store: deps.store,
				matcherOptions: deps.matcherOptions,
				window: deps.window ?? window,
				getActivePath: activeMarkdownPath,
				isSuperseded: () => this.generation !== startGeneration,
				getChangesSinceSnapshot: () => this.changesSinceSnapshot ?? ChangeSet.empty(this.view.state.doc.length),
				now: deps.now,
			})
				.then((deferred) => {
					if (this.destroyed) return;
					this.pendingDeferred = deferred;
				})
				.catch((err: unknown) => {
					console.error("persistent-folded-state: restore failed", err);
				});
		}

		/** CM6 forbids calling `view.dispatch` (and so `view.update`) from inside an
		 * in-progress `update()` call (`applyReadyDeferredFolds` dispatches when it has
		 * anything ready) — so the recheck itself is deferred to a microtask, run just after
		 * the current update cycle finishes rather than synchronously inline. A microtask
		 * (not the 150ms settle timer) keeps G13 feeling immediate: the fold still applies the
		 * moment the cursor leaves, not up to 150ms later. */
		private scheduleDeferredRecheck(): void {
			queueMicrotask(() => {
				if (this.destroyed || this.pendingDeferred.length === 0) return;
				try {
					const path = activeMarkdownPath(this.view);
					if (!path) {
						this.pendingDeferred = []; // the pane switched to a different file entirely
						return;
					}
					const liveAnchorKeys = liveAnchorKeySet(deps.store, path);
					this.pendingDeferred = applyReadyDeferredFolds(this.view, this.pendingDeferred, liveAnchorKeys);
				} catch (err) {
					console.error("persistent-folded-state: deferred restore failed", err);
				}
			});
		}

		update(update: ViewUpdate): void {
			if (update.transactions.length === 0) return;
			const path = activeMarkdownPath(update.view);
			if (!path) return;

			for (const tr of update.transactions) {
				try {
					recordFoldEffects(deps.store, path, tr);
					const cls = classifyTransaction(tr);
					if (cls === "non-user") {
						// R1: a fresh snapshot starts here — reset (not compose) so changes
						// from *before* this settle don't leak into the next run's mapping.
						this.generation++;
						this.changesSinceSnapshot = ChangeSet.empty(tr.state.doc.length);
						this.debouncer.trigger({ path, text: tr.state.doc.toString() });
					} else if (tr.docChanged && this.changesSinceSnapshot) {
						this.changesSinceSnapshot = this.changesSinceSnapshot.compose(tr.changes);
					}
				} catch (err) {
					console.error("persistent-folded-state: editor watcher failed", err);
				}
			}

			// R2: keep every still-deferred target's span over the same content as this
			// update's own changes (if any) — before the cursor-containment check next runs,
			// whether that's this update (no, dispatch is forbidden inside `update()`) or the
			// microtask recheck below.
			if (this.pendingDeferred.length > 0 && update.docChanged) {
				this.pendingDeferred = mapDeferredTargets(this.pendingDeferred, update.changes);
			}

			if (this.pendingDeferred.length > 0) {
				this.scheduleDeferredRecheck();
			}
		}

		destroy(): void {
			this.destroyed = true;
			this.debouncer.cancel();
			this.pendingDeferred = [];
		}
	}

	return ViewPlugin.fromClass(EditorWatcherPlugin);
}
