/**
 * The CM6-level restore wiring (PR-5): turns a settled non-user change (src/editor-watcher.ts)
 * into tagged fold effects dispatched to the one `EditorView` that saw it, and tracks whatever
 * G13 defers so a later update can finish the job once the cursor leaves. The actual decision
 * of what to fold is `src/restore-plan.ts`'s job (pure); this file only gathers the live CM6/
 * `FoldStore` inputs that function needs and dispatches its output.
 *
 * G11 (multi-pane) falls out of this file doing nothing pane-aware at all: `createEditorWatcher`
 * builds one `ViewPlugin` instance per open `EditorView` (CM6's own lifecycle — see the file
 * comment in editor-watcher.ts), so two panes on the same path each run their own independent
 * `restoreSettledChange` call against the one shared `FoldStore`. Since the matcher is a pure
 * function of (stored anchors, new-text candidates), both panes computing the same inputs land
 * on the same matched set without this file ever having to find or coordinate with the other
 * pane's view.
 *
 * E6 (yielding): the matcher's own `yieldToHost` is a no-op by default (src/matcher.ts is kept
 * pure and timer-free) — this is the one place that injects a real one, a plain
 * `window.setTimeout(resolve, 0)`, so a large note's chunked matching run actually yields back
 * to the browser between chunks instead of running in one uninterrupted synchronous burst.
 *
 * E3/E11 ("a user fold or unfold during the window wins"): the anchors matched against are a
 * snapshot — `store.get(path)` read once, synchronously, before the (possibly slow, chunked)
 * match ever starts — but what's actually dispatched is checked against a *fresh* read of the
 * store, taken right before dispatch. An anchor the user has since unfolded (removed from the
 * map) is dropped from the plan rather than re-folded; see `src/restore-plan.ts`'s own
 * `liveAnchorKeys` for where that's enforced. Every dispatched effect carries
 * `OWN_FOLD_ANNOTATION` (src/fold-recorder.ts), so it is never mistaken for a fresh user fold
 * and fed back into the map (no feedback loop).
 *
 * Dropped, not thrown: a view destroyed, a pane switched to a different file, or the document
 * having moved on again while the match was still running (another settle will already be
 * queued for that newer text — E9's "the last settled text wins") all end the same way, with
 * `restoreSettledChange` resolving to an empty deferred list and dispatching nothing.
 */
import { foldEffect, foldedRanges } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { buildAnchors, parseAnchor, anchorKey, type Anchor, type LineRange } from "./anchors";
import { matchAnchors, type MatcherOptions, type MatchResult } from "./matcher";
import { planRestore, type FoldTarget } from "./restore-plan";
import { OWN_FOLD_ANNOTATION } from "./fold-recorder";
import { hashText, type FoldStore } from "./fold-store";

export interface RestoreRunDeps {
	store: FoldStore;
	/** Passed through to `matchAnchors` verbatim except for `yieldToHost`, which this file
	 * always supplies for real (see the file comment) — a caller-supplied `yieldToHost` here
	 * still wins, so a test can override it (e.g. to count yields, or avoid needing fake-timer
	 * ticks for a small fixture that never actually hits a chunk boundary). */
	matcherOptions?: MatcherOptions;
	/** The window whose `setTimeout` backs the default `yieldToHost` — defaults to the real
	 * `window`, overridable the same way `FoldStore`/`SettleDebouncer` already are (popout
	 * windows, tests). */
	window?: Window;
	/** Resolves the markdown path `view` is showing right now, or `null` if it no longer shows
	 * one at all — used to detect "pane switched to another file" between the settle firing and
	 * the match finishing. */
	getActivePath: (view: EditorView) => string | null;
}

function currentFoldedLineRanges(view: EditorView): LineRange[] {
	const ranges: LineRange[] = [];
	foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
		ranges.push({ startLine: view.state.doc.lineAt(from).number, endLine: view.state.doc.lineAt(to).number });
	});
	return ranges;
}

function cursorLineOf(view: EditorView): number | null {
	const pos = view.state.selection.main.head;
	if (pos < 0 || pos > view.state.doc.length) return null;
	return view.state.doc.lineAt(pos).number;
}

/** Anchor keys (`anchorKey`) for every entry *currently* stored for `path` — read fresh, not
 * from whatever snapshot drove the match, so a since-removed anchor is correctly absent (E3). A
 * PR-2-era raw-text record (no `siblingIndex`/`parentChain`) fails `parseAnchor` and is simply
 * excluded, same as everywhere else this PR reads stored folds. */
function liveAnchorKeySet(store: FoldStore, path: string): ReadonlySet<string> {
	const record = store.get(path);
	const keys = new Set<string>();
	for (const raw of record?.folds ?? []) {
		const anchor = parseAnchor(raw);
		if (anchor) keys.add(anchorKey(anchor));
	}
	return keys;
}

/** Converts a line-range target into a CM6 character-offset fold effect: from the end of the
 * block's own first line to the end of its last line, leaving the first line itself visible
 * (the usual heading/task/list fold shape). Returns `null` rather than throwing when the doc no
 * longer has that many lines (it shrank between planning and dispatch). */
function foldEffectFor(view: EditorView, range: LineRange): ReturnType<typeof foldEffect.of> | null {
	if (range.endLine > view.state.doc.lines) return null;
	const from = view.state.doc.line(range.startLine).to;
	const to = view.state.doc.line(range.endLine).to;
	if (from >= to) return null; // nothing left to hide
	return foldEffect.of({ from, to });
}

function dispatchFoldTargets(view: EditorView, targets: readonly FoldTarget[]): void {
	if (targets.length === 0) return;
	const effects = targets
		.map((target) => foldEffectFor(view, target.range))
		.filter((effect): effect is NonNullable<typeof effect> => effect !== null);
	if (effects.length === 0) return;
	view.dispatch({ effects, annotations: OWN_FOLD_ANNOTATION.of(true) });
}

function defaultYieldToHost(win: Window): () => Promise<void> {
	return () => new Promise((resolve) => win.setTimeout(resolve, 0));
}

/**
 * Runs one settled-non-user-change restore pass for `view` (the scope goal: "on a settled
 * non-user change it snapshots the stored anchors, asks the matcher for matches, and applies
 * them as tagged CM6 fold effects"). Returns whatever G13 deferred because the cursor sat
 * inside it — the caller (editor-watcher.ts) re-checks these on every later update via
 * `applyReadyDeferredFolds`. Never throws.
 */
export async function restoreSettledChange(
	view: EditorView,
	path: string,
	text: string,
	deps: RestoreRunDeps,
): Promise<FoldTarget[]> {
	const snapshot = deps.store.get(path);
	if (!snapshot || snapshot.folds.length === 0) return [];

	// The snapshot (E11/E9): taken once, now, before the possibly-slow matching below starts.
	const storedAnchors: Anchor[] = [];
	for (const raw of snapshot.folds) {
		const anchor = parseAnchor(raw);
		if (anchor) storedAnchors.push(anchor);
	}
	if (storedAnchors.length === 0) return [];

	const candidates = buildAnchors(text);
	const win = deps.window ?? window;
	const matches: MatchResult[] = await matchAnchors(storedAnchors, candidates.map((c) => c.anchor), {
		yieldToHost: defaultYieldToHost(win),
		...deps.matcherOptions,
	});

	if (!view.dom.isConnected) return []; // the pane/view was destroyed while matching ran
	if (deps.getActivePath(view) !== path) return []; // switched to a different file meanwhile
	if (view.state.doc.toString() !== text) return []; // the doc moved on again (E9: a newer settle already queued)

	const plan = planRestore({
		stored: storedAnchors,
		matches,
		candidates,
		alreadyFolded: currentFoldedLineRanges(view),
		cursorLine: cursorLineOf(view),
		liveAnchorKeys: liveAnchorKeySet(deps.store, path),
	});

	dispatchFoldTargets(view, plan.toFold);

	// "After each settled restore the note's stored content hash is refreshed with hashText of
	// the settled text" — refresh only the hash. `folds`/`dormant` are read fresh (not from
	// `snapshot`) so a fold or unfold the user made during the match isn't clobbered (E3).
	const latest = deps.store.get(path);
	if (latest) deps.store.set(path, { ...latest, contentHash: hashText(text) });

	return plan.deferred;
}

/** G13's other half: re-checks every still-deferred target against the *current* cursor
 * position and applies (dispatches) each one whose block the cursor has since left. Cheap and
 * safe to call on every update, including ones unrelated to the cursor at all — a no-op once
 * `pending` is empty. Never throws on a doc that's since shrunk below a deferred range's line
 * numbers (`foldEffectFor` already guards that). */
export function applyReadyDeferredFolds(view: EditorView, pending: readonly FoldTarget[]): FoldTarget[] {
	if (pending.length === 0) return [];

	const cursorLine = cursorLineOf(view);
	const ready: FoldTarget[] = [];
	const stillPending: FoldTarget[] = [];
	for (const target of pending) {
		const inside = cursorLine !== null && cursorLine >= target.range.startLine && cursorLine <= target.range.endLine;
		if (inside) stillPending.push(target);
		else ready.push(target);
	}

	dispatchFoldTargets(view, ready);
	return stillPending;
}
