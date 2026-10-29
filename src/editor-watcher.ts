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
 * T20: that synchronous read is not the end of the story. Real Obsidian has been observed, when
 * reconfiguring an *already-open* pane's CM6 extensions (the re-enable-over-an-open-pane path
 * src/main.ts's own `updateOptions()` call exists to exercise), to leave a live fold that was
 * genuinely already on screen missing from this first read, with nothing afterwards dispatching
 * a transaction that would let `src/fold-recorder.ts`'s own recording pick it up either.
 * `scheduleFirstOpenGraceRecheck` guards against that: a short grace period after adopting a
 * baseline, it re-reads the view's *live* fold state directly (not via any transaction) and
 * merges in — never removes — anything the first read missed. Because `EditorView.setState`
 * (unlike `dispatch`) recreates every `ViewPlugin` instance fresh rather than calling `update()`
 * on it, that recheck deliberately keys its liveness check off `view.dom.isConnected`, not
 * `this.destroyed`: this specific instance may already have been quietly replaced by the time
 * the timer fires, even though the pane itself, and the one long-lived `EditorView` it wraps,
 * never closed.
 *
 * "Added": a thrown error inside the classifier, recorder or deferred-fold recheck is caught and
 * logged per-update, so one bad transaction can never block the rest of the batch, and a bug
 * here can never stop typing or folding in the editor itself. The restore pass itself is async
 * and runs detached from `update()` (dispatching happens once the match resolves, not
 * synchronously) — a rejection there is caught and logged the same way, never left as an
 * unhandled promise rejection.
 *
 * R14: the grace-recheck timer `scheduleFirstOpenGraceRecheck` schedules checks a shared
 * `disposed` flag (`EditorWatcherDeps.disposed`) first, before anything else, and bails out if
 * set. main.ts sets `disposed.current = true` once, from its own `onunload()`, when the whole
 * plugin unloads. Without that check, disabling the plugin within the ~150ms grace window would
 * leave the timer armed against the old `FoldStore` — if the plugin were re-enabled in that same
 * short window, the stale timer firing later could call `store.set` on a `FoldStore` instance
 * nothing else still uses, clobbering whatever the new instance already wrote on its next
 * debounced save. This is deliberately a flag shared across every `ViewPlugin` instance one
 * `createEditorWatcher` call creates, not any one instance's own `this.destroyed` — that already
 * goes true on an ordinary single-pane CM6 reconfigure (T20, directly above), which must NOT
 * suppress this recheck. The recheck also re-checks `activeMarkdownPath(this.view) === path`
 * right before merging (not just the doc-text check already there), so a pane that has since
 * switched to a *different* file whose text happens to match `textAtAdoption` exactly is never
 * merged into the wrong store entry.
 *
 * T22: the grace recheck's own candidate lookup (and the constructor's synchronous `buildBaseline`
 * call above it) used to require an *exact* `{startLine,endLine}` match between a live fold and
 * a `buildAnchors` candidate. That missed a live fold made by directly clicking its own fold
 * indicator (never closed/reopened since) whenever the block is followed by a blank separator
 * line before its next sibling: `buildAnchors`' own `closeFramesAbove` swallows that blank run
 * into the block's own candidate range (anchors.ts), but a click-to-fold action only ever covers
 * the block's own content, with no notion of what follows it. `resolveCandidateForLiveRange`
 * (src/live-folds.ts) now falls back, once the exact match fails, to widening the live range
 * forward over nothing but blank lines to reach such a candidate — used by both this recheck and
 * `src/baseline.ts`'s own lookup, so the constructor's first synchronous read and this grace
 * recheck agree on the same candidate for the same live fold either way.
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
import { checkPass, runSerialised, type LoadWaitIo, type PassGate } from "./load-wait";
import { groupCandidatesByStartLine, liveFoldedLineRanges, resolveCandidateForLiveRange } from "./live-folds";
import { anchorKey, buildAnchors, parseAnchor } from "./anchors";
import { MAX_FOLDS, type MatcherOptions } from "./matcher";
import type { FoldStore } from "./fold-store";
import { diagnosticEntry, recordCounts, reportDiagnostic, type DiagnosticOutcome, type DiagnosticSink } from "./diagnostic-log";
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
	/** T20: how long after a first-open baseline adoption the constructor's grace re-check
	 * (`scheduleFirstOpenGraceRecheck`) waits before merging in any live fold that wasn't
	 * captured by the synchronous read. Overridable only for tests; defaults to the same
	 * 150ms E9 already treats as "settled" elsewhere in this file. */
	firstOpenGraceMs?: number;
	/** R14: a flag shared across every `ViewPlugin` instance this `createEditorWatcher` call
	 * creates (one `deps` object per call — see the file comment). main.ts sets
	 * `.current = true` from its own `onunload()`, once, when the whole plugin unloads, so a
	 * grace-recheck timer still pending at that moment (see
	 * `scheduleFirstOpenGraceRecheck`) becomes a no-op rather than writing to a `FoldStore`
	 * instance a freshly re-enabled plugin has already replaced. Deliberately not derived
	 * from any one `ViewPlugin` instance's own `destroyed` flag, which also goes true on an
	 * ordinary single-pane CM6 reconfigure (T20) that must NOT suppress this recheck. */
	disposed?: { current: boolean };
	/** Warkworth-46 PR-1 (GP6): passed through to `restoreSettledChange`, which logs a `settled`
	 * line whenever its pass changes stored data. Optional. */
	diagnosticLog?: DiagnosticSink;
	/** Warkworth-46 PR-3: the shared wait/guard (src/load-wait.ts) for the settled-change pass and
	 * the first-open baseline. `gate` holds the passes that had to wait, keyed by the pane's
	 * `EditorView`; `makeIo` builds a wait's view of the outside world for a pane (the pane's
	 * file path is always read from the pane's own `editorInfoField`, whatever `makeIo` says).
	 * Omitted by a caller with no vault to read (a unit test): both passes then run on the
	 * pane's text at once, as they did before. */
	loadGuard?: { gate: PassGate<EditorView>; makeIo: (view: EditorView, path: string) => LoadWaitIo };
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
	/** PR-3 (E2): the live `ViewPlugin` instance of each pane. `EditorView.setState` replaces the
	 * instance without a transaction; a wait left by the old one hands its result to the new one. */
	const instances = new WeakMap<EditorView, EditorWatcherPlugin>();
	/** PR-3: the text a settled pass that a wait released has just been run for, per pane. The
	 * settle timer of the very change that ended the wait would otherwise run the same pass a
	 * second time; it finds its text here and stands down once. */
	const releasedFor = new WeakMap<EditorView, string>();

	/** The wait's view of the outside world for `view`: whatever `makeIo` builds, except the pane's
	 * file path, which this file reads from the pane's own state like every other check here. */
	function ioFor(view: EditorView, path: string): LoadWaitIo {
		const io = deps.loadGuard!.makeIo(view, path);
		return { ...io, paneFilePath: () => activeMarkdownPath(view) };
	}

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
			instances.set(view, this);
			this.debouncer = new SettleDebouncer(
				({ path, text }) => {
					deps.onSettledNonUserChange?.(path, text);
					if (releasedFor.get(this.view) === text) {
						releasedFor.delete(this.view); // the wait's release already ran this pass for this text
						return;
					}
					this.runRestore(path, text);
				},
				deps.flushDelayMs ?? 150,
				deps.window ?? window
			);

			// PR-3 (E2): text that arrives through `EditorView.setState` gives no transaction, so
			// a wait this pane already has (left by the instance this one replaced) is looked at
			// again now instead of at its next slow recheck.
			deps.loadGuard?.gate.recheck(view);

			// E5/G15: a brand-new pane for a Markdown file the store has never seen — adopt
			// Obsidian's current fold state as the baseline before any transaction runs. See the
			// file comment for why this is only one of the two places this same "no entry" case
			// is handled. PR-3 (E18): with the load guard on, the baseline is adopted only once
			// the pane holds the note's real text (it is adopted at once only when the pane
			// already does, after one disk read), never from an empty or half-loaded document.
			try {
				const path = activeMarkdownPath(view);
				if (path && !deps.store.get(path)) {
					if (deps.loadGuard) void this.adoptBaselineWhenLoaded(path);
					else this.adoptBaseline(path);
				}
			} catch (err) {
				console.error("persistent-folded-state: first-open baseline failed", err);
			}
		}

		/** Stores `path`'s first-open baseline from the pane as it is now, unless the store has
		 * an entry for it by now or the pane has moved to another file. Dispatches nothing. */
		private adoptBaseline(path: string): void {
			const view = this.view;
			if (deps.disposed?.current || deps.store.get(path) || activeMarkdownPath(view) !== path) return;
			const text = view.state.doc.toString();
			const baseline = buildBaseline(view.state, text);
			deps.store.set(path, {
				contentHash: baseline.contentHash,
				folds: baseline.anchors as unknown as StoredAnchor[],
				dormant: [],
			});
			// T20: when this ViewPlugin instance is created by Obsidian reconfiguring
			// an *already-open* pane's CM6 extensions (the re-enable-over-an-open-pane
			// path src/main.ts's T2 fix exists to exercise) rather than by a brand-new
			// EditorView's own initial construction, a live fold that was genuinely
			// already on screen at the moment of enabling has been observed missing
			// from this synchronous read against real Obsidian (not reproducible
			// against jsdom/CM6 directly, where a reconfigure's own fold state is
			// already consistent by the time this constructor runs — see the T20
			// issue). A short grace-period re-check, reading the view's live state
			// again shortly afterwards and merging in (never removing) any live fold
			// this first read didn't capture, guards against that without changing
			// anything about the ordinary, already-reliable brand-new-pane path (there
			// is nothing left to merge there). PR-3: only scheduled for a baseline taken from
			// real text; an empty document has nothing to merge against.
			if (text !== "") this.scheduleFirstOpenGraceRecheck(path, text);
		}

		/** PR-3 (E18): the guarded first-open baseline. Asks the shared guard whether the pane
		 * holds `path`'s real text; adopts the baseline if so, otherwise leaves a wait that adopts
		 * it when the text lands. Logs `pass: "baseline"` for a wait, a refusal, a give-up and a
		 * failed read, and `applied` for a baseline adopted after a wait. Never throws. */
		private async adoptBaselineWhenLoaded(path: string): Promise<void> {
			const view = this.view;
			const guard = deps.loadGuard;
			if (!guard) return;
			const log = (outcome: DiagnosticOutcome, editorLen: number, diskLen: number): void => {
				const counts = recordCounts(deps.store.get(path));
				reportDiagnostic(deps.diagnosticLog, diagnosticEntry({ path, pass: "baseline", outcome, editorLen, diskLen, before: counts, after: counts }));
			};
			try {
				const io = ioFor(view, path);
				const textAtCheck = view.state.doc.toString();
				const check = await checkPass("baseline", path, textAtCheck, io);
				const live = instances.get(view);
				if (!live || deps.disposed?.current || deps.store.get(path) || activeMarkdownPath(view) !== path) return; // someone else won
				// The text can change while the disk is read. A pane that changed under the check is
				// not adopted from a verdict about text it no longer has: it waits like any other.
				if (check.verdict.decision === "proceed" && view.state.doc.toString() === textAtCheck) {
					live.adoptBaseline(path);
					return;
				}
				if (check.verdict.decision === "read-failed") {
					log("read-failed", check.editorLen, -1);
					return;
				}
				const started = guard.gate.hold("baseline", view, path, io, {
					ready: ({ diskLen }) => {
						// The pane as it is now, not as the wait saw it: the user may have kept typing since.
						const liveText = view.state.doc.toString();
						if (liveText === "" && diskLen !== 0) {
							log("refused-empty", 0, diskLen); // never a baseline from a pane the user emptied before it loaded
							return;
						}
						const before = deps.store.get(path);
						instances.get(view)?.adoptBaseline(path);
						if (!before && deps.store.get(path)) {
							const counts = recordCounts(deps.store.get(path));
							reportDiagnostic(
								deps.diagnosticLog,
								diagnosticEntry({ path, pass: "baseline", outcome: "applied", editorLen: liveText.length, diskLen, before: recordCounts(undefined), after: counts }),
							);
						}
					},
					ended: ({ state, editorLen, diskLen }) => log(state, editorLen, diskLen),
				});
				if (started) log(check.verdict.outcome ?? "waiting", check.editorLen, check.diskLen);
			} catch (err) {
				console.error("persistent-folded-state: first-open baseline failed", err);
			}
		}

		/** T20: scheduled once, from the constructor, right after a first-open baseline was
		 * just adopted for `path`. Re-reads the view's *live* fold state after a short grace
		 * period and merges in (never removes) any live fold the synchronous constructor-time
		 * read didn't capture — see the constructor's own comment for why this exists. A no-op
		 * once the document itself has changed (no longer "the text as opened"), once the
		 * store entry for `path` has been removed entirely (e.g. "Forget stored folds for this
		 * note"), or once there is nothing left to merge (the common case). */
		private scheduleFirstOpenGraceRecheck(path: string, textAtAdoption: string): void {
			const win = deps.window ?? window;
			const view = this.view;
			// PR-3 (E18): never against an empty `textAtAdoption`. A baseline taken from an unloaded
			// pane is not adopted at all (see `adoptBaselineWhenLoaded`); this is the second line.
			if (textAtAdoption === "") return;
			win.setTimeout(() => {
				// R14: the whole Obsidian plugin may have unloaded since this timer was
				// scheduled — checked first, ahead of any other liveness check. This is
				// deliberately a flag shared (via `deps`) across every `ViewPlugin` instance
				// this one `createEditorWatcher` call ever creates, not `this.destroyed`:
				// `this.destroyed` (and CM6 itself, via `EditorView.setState`/reconfigure —
				// see below) already goes true whenever just *this one pane* is reconfigured
				// while the plugin stays loaded, which must NOT cancel this recheck (that's
				// the whole point of T20, directly below). Only main.ts's own `onunload` sets
				// `deps.disposed.current`, so this is the one check that's actually scoped to
				// "the plugin itself went away", guarding against a late `store.set` landing on
				// a `FoldStore` instance a freshly re-enabled plugin has already replaced.
				if (deps.disposed?.current) return;
				// Deliberately not `this.destroyed`: real Obsidian (and `EditorView.setState`,
				// which CM6 treats as "recreate every ViewPlugin fresh" rather than as an
				// incremental update — see T20) can tear down and replace *this* ViewPlugin
				// instance for the same, still-open pane before this timer fires, without the
				// underlying `EditorView`/pane itself ever closing. `view` is still the one,
				// long-lived object either way, so its `.dom.isConnected` is the right liveness
				// check — unlike `this.destroyed`, it still reflects reality once a
				// reconfigure/setState has quietly replaced this specific instance.
				if (!view.dom.isConnected) return;
				try {
					if (this.view.state.doc.toString() !== textAtAdoption) return;
					// R14: the pane may since have navigated to a *different* file whose text
					// happens to match `textAtAdoption` exactly (e.g. two notes seeded from the
					// same template) — only merge if it's still showing the file this baseline
					// was adopted for.
					if (activeMarkdownPath(this.view) !== path) return;
					const latest = deps.store.get(path);
					if (!latest) return;

					const liveFolds = liveFoldedLineRanges(this.view.state);
					if (liveFolds.length === 0) return;

					const candidates = buildAnchors(textAtAdoption);
					const candidatesByStart = groupCandidatesByStartLine(candidates);

					const existingKeys = new Set<string>();
					for (const raw of latest.folds) {
						const anchor = parseAnchor(raw);
						if (anchor) existingKeys.add(anchorKey(anchor));
					}

					const merged = [...latest.folds];
					let changed = false;
					for (const range of liveFolds) {
						if (merged.length >= MAX_FOLDS) break; // E6: respects the PR-4 cap here too
						const candidate = resolveCandidateForLiveRange(this.view.state, range, candidatesByStart);
						if (!candidate) continue; // E5: a range the PR-3 builder can't produce stays skipped
						const key = anchorKey(candidate.anchor);
						if (existingKeys.has(key)) continue;
						existingKeys.add(key);
						merged.push(candidate.anchor as unknown as StoredAnchor);
						changed = true;
					}
					if (changed) {
						deps.store.set(path, { contentHash: latest.contentHash, folds: merged, dormant: latest.dormant });
					}
				} catch (err) {
					console.error("persistent-folded-state: first-open baseline grace recheck failed", err);
				}
			}, deps.firstOpenGraceMs ?? 150);
		}

		private runRestore(path: string, text: string, guardCleared = false): void {
			const startGeneration = this.generation;
			const view = this.view;
			const guard = deps.loadGuard;
			// PR-3: one restore pass at a time per pane (with the open pass too), so a settled pass
			// released by the same text landing never writes the store while the open pass does.
			runSerialised(view, () =>
				restoreSettledChange(view, path, text, {
					store: deps.store,
					matcherOptions: deps.matcherOptions,
					window: deps.window ?? window,
					getActivePath: activeMarkdownPath,
					isSuperseded: () => this.generation !== startGeneration,
					getChangesSinceSnapshot: () => this.changesSinceSnapshot ?? ChangeSet.empty(this.view.state.doc.length),
					now: deps.now,
					diagnosticLog: deps.diagnosticLog,
					guardCleared,
					loadGuard: guard && {
						gate: guard.gate,
						makeIo: (p) => ioFor(view, p),
						// E2: the instance that waited may have been replaced by `setState`; the live
						// one runs the released pass, with the pane's text as it is when the wait ends.
						rerun: (p, t) => {
							releasedFor.set(view, t);
							instances.get(view)?.runRestore(p, t, true);
						},
					},
				}),
			)
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
						const settledText = tr.state.doc.toString();
						// A different text from the one a wait's release ran for: that marker is stale.
						if (releasedFor.get(update.view) !== settledText) releasedFor.delete(update.view);
						this.debouncer.trigger({ path, text: settledText });
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
