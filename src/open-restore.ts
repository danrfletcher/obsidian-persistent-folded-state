/**
 * The CM6-level wiring for G8/E4 (PR-7): the second real-world trigger `src/vault-lifecycle.ts`
 * names for a stored entry going stale — the file changed on disk while it wasn't open (a git
 * pull, a sync client, an external editor) rather than a live edit inside Obsidian (PR-5's own
 * `src/fold-restorer.ts`). Called once, synchronously-fired-but-async-resolving, from
 * `src/main.ts`'s `workspace.on("file-open", ...)` listener — deliberately *not*
 * `src/editor-watcher.ts`'s own `ViewPlugin` constructor, which fires on every CM6 pane
 * construction regardless of why (including, concretely, every test harness in this repo that
 * builds a view directly against an already-seeded store). "A file actually became the active
 * one" is the narrower, Obsidian-level signal this feature needs; `file-open` is that signal.
 * Warkworth-46 PR-2: `file-open` does not call this directly any more. A fresh pane's document is
 * still empty when it fires, so `restoreOnOpenWhenLoaded` (src/open-wait.ts) waits until the pane
 * shows this note's real text (src/load-wait.ts) and only then calls this with that text. The
 * decision made here is unchanged, and `scheduleNativeRestoreGuard` below starts from inside it, so the guard
 * now starts only after the wait ends.
 * The pane this runs against may be brand new, or may be the same pane CM6 happens to reuse for
 * a different file — either way, the entry the store already has for `path` (as opposed to no
 * entry at all, which stays `src/editor-watcher.ts`'s E5/G15 job) is what's being reconciled.
 *
 * G8 (content-hash comparison on open): `needsRematchOnOpen` (src/vault-lifecycle.ts) is the
 * whole decision. Hash unchanged — the text as opened is byte-identical (modulo line-ending
 * normalisation — see `hashText`) to what was last stored — and `applyStoredFoldsVerbatim` runs:
 * no matcher call at all, just the stored anchors looked up by exact `anchorKey` against fresh
 * candidates built from this same (unchanged) text, folding (idempotently) whichever aren't
 * already live. Obsidian's own native per-session fold restore is never touched in this branch —
 * nothing is ever unfolded here, only (idempotently) folded, matching E4's "the plugin adds
 * nothing that was not stored" for the common, nothing-changed-while-closed case, and giving a
 * note opened in a second pane right after the first (G11) the same folds the first pane has,
 * even if the first pane's own `restoreOnOpen` call (same path, same content, both unchanged)
 * already finished first.
 *
 * Hash changed — re-match and re-apply through the same pattern PR-5's own
 * `restoreSettledChange` already established (one shared `matchAnchors` call covering the active
 * *and* still-fresh dormant anchors together, R1's "never-break rule 4" candidate-claiming,
 * `planRestore` for the idempotent/G13-cursor decision, bookkeeping applied as a delta against a
 * fresh store read so a fold or unfold made while this ran is never clobbered — E3). This file
 * does not call `restoreSettledChange` itself (PR-5's own signature/behaviour for the
 * live-transaction case is out of scope for this PR and stays untouched) — it duplicates just
 * that pattern, against the CM6 state a freshly-constructed `EditorView` already has rather than
 * a transaction's settled text.
 *
 * E4 (replacing, not just adding to, native restore): the one thing this file's hash-changed
 * branch does that `restoreSettledChange` never needs to is explicitly *unfold* something.
 * `liveFoldedLineRanges` is read once, synchronously, before anything else, to capture whatever
 * Obsidian's own native restore has applied to this fresh pane *so far* (T13 — real Obsidian can
 * reapply a line range as a side effect of reloading an externally-changed file, before this
 * plugin ever runs). Every range the shared match actually decided on (tier !== "none", active
 * or dormant alike, deferred-for-G13 ones included — those are still "matched", simply not
 * dispatched yet) is collected into one `matched` list and handed to `reconcileNativeRestore`
 * (src/vault-lifecycle.ts) alongside the native list: anything native that isn't in `matched` at
 * all is a stale offset (equal line count, changed content is exactly what gives native restore
 * no way to tell it's folding the wrong thing) and is unfolded outright, tagged with the same
 * `OWN_FOLD_ANNOTATION` as every other effect this plugin ever dispatches (so it is never
 * mistaken for a fresh user unfold and fed back into the map). T1: that one synchronous capture
 * is not reliably the end of native restore's own story for this pane — see
 * `scheduleNativeRestoreGuard`'s own comment, further down this file, for the late-arrival case
 * and the short guard window that re-corrects it. R8: that guard does *not* get handed this same
 * `matched` list to decide what to (re)fold on its later checks — only what it must never
 * unfold. What it (re)folds is the narrower `plan.toFold`/`dormantPlan.toFold` set below, the
 * only ranges the initial pass actually decided to fold.
 *
 * G13 on open: `cursorLineOf` is still read and passed through to `planRestore`, so a block the
 * cursor already sits inside (Obsidian restores cursor position too) is deferred rather than
 * force-folded right under it, same as the live-edit path. What this file does *not* do is track
 * that deferral any further — there is no `pendingDeferred` entry added for it the way
 * `src/editor-watcher.ts`'s own settle path does. A deferred-on-open target simply stays however
 * it already was (folded, if native restore happened to leave it that way — `reconcileNativeRestore`
 * never unfolds a matched range regardless of deferral — or unfolded otherwise) until some later
 * live edit retriggers a restore pass through the ordinary PR-5 path. Judgement call: the PR's
 * listed deliverables are the hash comparison, the re-match/re-apply and the native-restore
 * replacement, not wiring a second pane into the live deferred-recheck queue.
 */
import { foldEffect, unfoldEffect } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { anchorKey, buildAnchors, parseAnchor, type Anchor, type AnchoredBlock, type LineRange } from "./anchors";
import { liveFoldedLineRanges } from "./live-folds";
import { matchAnchors, type MatcherOptions, type MatchResult } from "./matcher";
import { planRestore } from "./restore-plan";
import { OWN_FOLD_ANNOTATION } from "./fold-recorder";
import { hashText, type FoldStore } from "./fold-store";
import { liveAnchorKeySet, refreshMatchedFolds } from "./fold-restorer";
import { needsRematchOnOpen, reconcileNativeRestore } from "./vault-lifecycle";
import {
	addDormant,
	dropDormantClaimedByActive,
	freshDormantAnchors,
	splitDormantResults,
	survivorsStillDormant,
} from "./dormant";
import { diagnosticEntry, recordCounts, reportDiagnostic, type DiagnosticSink } from "./diagnostic-log";
import { normaliseLineEndings } from "./load-wait";
import type { StoredAnchor } from "./types";

export interface OpenRestoreDeps {
	store: FoldStore;
	/** Same as `src/fold-restorer.ts`'s own `RestoreRunDeps.matcherOptions` — passed through to
	 * `matchAnchors` verbatim except for `yieldToHost`, which this file always supplies for real
	 * unless a caller overrides it. */
	matcherOptions?: MatcherOptions;
	/** The window whose `setTimeout` backs the default `yieldToHost`. Defaults to the real
	 * `window`. */
	window?: Window;
	/** Clock used for `dormantSince`/age checks. Defaults to `Date.now`. */
	now?: () => number;
	/** T8: re-resolves the live CM6 `EditorView` for `path`, fresh, each time
	 * `scheduleNativeRestoreGuard` checks — not just once, up front, the way the `view` this
	 * function was originally called with is. Real Obsidian relaunch testing found the guard
	 * never correcting a late native restore at all, no matter how long afterwards it was
	 * checked; a `view` captured once at file-open time and never re-resolved is the one part
	 * of the guard that has no way to recover from Obsidian quietly replacing the pane's
	 * editor sometime during a slow startup (deferred-leaf resolution, see T20's own precedent
	 * in src/editor-watcher.ts) — every later check against the stale reference would silently
	 * bail at its very first liveness check (`view.dom.isConnected`) forever after. Called with
	 * `path`; returning `null` falls back to the originally-captured `view` (every existing
	 * caller and test that doesn't pass this). `src/main.ts` supplies a real one, re-reading
	 * `app.workspace.activeEditor` the same way it resolves `cm` at file-open time. */
	resolveView?: (path: string) => EditorView | null;
	/** T8: Obsidian's own "the initial layout, including every deferred leaf's view, has
	 * finished resolving" signal — the same one `main.ts`'s own orphan-prune (R1) already
	 * waits on. `scheduleNativeRestoreGuard`'s own fixed delays are a guess at "long enough";
	 * a real relaunch's native restore has been observed arriving well past them. This adds
	 * one more guard check tied to an actual Obsidian-reported event instead of another guess,
	 * firing immediately if layout is already ready (the common, already-fast case) or once it
	 * becomes ready otherwise. Optional — omitted by every test that has no workspace to ask. */
	onLayoutReady?: (cb: () => void) => void;
	/** T19/T20/T22: overridable only for tests (to keep a "late arrival" scenario fast to run
	 * for real) — the real schedule `scheduleNativeRestoreGuard` checks on, replacing
	 * `NATIVE_RESTORE_GUARD_DELAYS_MS`'s own default when supplied. */
	guardDelaysMs?: readonly number[];
	/** Warkworth-46 PR-1 (GP6): where this pass logs its one diagnostic line. Optional; omitted
	 * by every caller that does not collect the log. Fire and forget: the pass never waits on it
	 * and a failure in it never reaches the pass. */
	diagnosticLog?: DiagnosticSink;
	/** Warkworth-46 PR-2: the length of the note's text on disk when the wait compared it with the
	 * editor (src/load-wait.ts), for the log line only. Omitted by a caller that made no disk read;
	 * the line then says -1. */
	diskLen?: number;
}

function isFoldable(range: LineRange): boolean {
	return range.endLine > range.startLine;
}

function sameRange(a: LineRange, b: LineRange): boolean {
	return a.startLine === b.startLine && a.endLine === b.endLine;
}

function cursorLineOf(view: EditorView): number | null {
	const pos = view.state.selection.main.head;
	if (pos < 0 || pos > view.state.doc.length) return null;
	return view.state.doc.lineAt(pos).number;
}

function defaultYieldToHost(win: Window): () => Promise<void> {
	return () => new Promise((resolve) => win.setTimeout(resolve, 0));
}

function foldEffectFor(view: EditorView, range: LineRange): ReturnType<typeof foldEffect.of> | null {
	if (!isFoldable(range)) return null;
	if (range.endLine > view.state.doc.lines) return null;
	const from = view.state.doc.line(range.startLine).to;
	const to = view.state.doc.line(range.endLine).to;
	if (from >= to) return null;
	return foldEffect.of({ from, to });
}

function unfoldEffectFor(view: EditorView, range: LineRange): ReturnType<typeof unfoldEffect.of> | null {
	if (!isFoldable(range)) return null;
	if (range.endLine > view.state.doc.lines) return null;
	const from = view.state.doc.line(range.startLine).to;
	const to = view.state.doc.line(range.endLine).to;
	if (from >= to) return null;
	return unfoldEffect.of({ from, to });
}

function dispatchFoldAndUnfold(view: EditorView, toFold: readonly LineRange[], toUnfold: readonly LineRange[]): void {
	const effects = [
		...toFold.map((range) => foldEffectFor(view, range)),
		...toUnfold.map((range) => unfoldEffectFor(view, range)),
	].filter((effect): effect is NonNullable<typeof effect> => effect !== null);
	if (effects.length === 0) return;
	view.dispatch({ effects, annotations: OWN_FOLD_ANNOTATION.of(true) });
}

/** T1: real Obsidian has been observed applying its own native per-session fold restore for a
 * freshly (re)opened leaf *after* this file's own `restoreOnOpen` already ran and dispatched its
 * E4 correction below — specifically for the equal-line-count/reordered-heading shape (a stale
 * offset that used to be valid now lands on a different, still-foldable block, rather than on
 * non-foldable text the way GP4's own fixture happens to). `restoreOnOpen`'s one synchronous
 * `liveFoldedLineRanges` capture, and the one `reconcileNativeRestore`/dispatch pair that follows
 * it, both assumed native restore had already finished by then; sometimes it hasn't, and the
 * late arrival (whether it shows up as its own extra transaction or as Obsidian swapping the
 * view's whole state) wins, clobbering the correction. This re-runs the same reconciliation at a
 * couple of short delays afterwards so a late arrival still gets corrected instead of silently
 * standing. Each check is independent and a no-op (dispatches nothing, touches the store not at
 * all) once the live state already agrees with the matched set — the ordinary, already-
 * synchronous case this guards against never fires a second dispatch. Bails out (without
 * touching the view or the store) once the pane has gone away or moved on to different text, so
 * a guard scheduled for one open can never act against a later one in the same pane.
 *
 * T8: against a real Obsidian relaunch (not just a same-session reopen), these two fixed delays
 * were observed never correcting anything at all — not because the reconciliation itself is
 * wrong, but because both checks can run, find nothing stale yet (native restore hasn't landed),
 * and nothing ever checks again afterwards. There is no single delay that is long enough for
 * every machine and every startup — a deferred leaf's real editor can resolve an unpredictable
 * amount of time into a slow relaunch. Rather than guess a third, longer number, the
 * `onLayoutReady` check added below `scheduleNativeRestoreGuard` ties the backstop check to an
 * actual Obsidian-reported event (the same one `main.ts`'s own orphan-prune already waits on)
 * instead of a guess, and `resolveView` re-resolves the live `EditorView` fresh at every check
 * rather than trusting the one reference captured at file-open time, in case that's what was
 * silently going stale and bailing out the old checks for good.
 *
 * R8: the first shape of this guard re-ran `reconcileNativeRestore(nativeFolded, matchedRanges)`
 * on every check and dispatched its `toFold` — but `matchedRanges` is everything the match
 * decided on, deliberately including G13-deferred blocks and dormant matches `planRestore` chose
 * not to act on. Folding those around the cursor (breaking G13/F5) the moment `onLayoutReady`
 * fires synchronously (the normal case for any open after startup) was a straight regression, not
 * a timing edge case. The guard now takes two separate inputs instead of one: `foldTargets` is
 * exactly what the initial pass already decided to fold (`plan.toFold`/`dormantPlan.toFold`,
 * never a deferred or merely-matched range) — the only thing any check ever (re)folds, and only
 * once it re-checks the live cursor line still isn't inside it. `protectedRanges` is the original
 * `matchedRanges` — used only to decide what must never be unfolded, never to decide what to
 * fold.
 *
 * T19/T20/T22 (R9's own issue, now a blocking test finding rather than a deferred one): R8's own
 * guard decided the unfold side at most once per open — the first check that found the pane live
 * — because CM6 gives no way to tell a late, untagged native-restore transaction apart from the
 * user folding some unrelated block the plugin never matched. Against a real relaunch, that one
 * chance is spent far too early: the `onLayoutReady` check fires synchronously, immediately,
 * whenever layout is already ready by the time `restoreOnOpen` runs (the ordinary case for any
 * open well after startup), and the fixed 50/300ms delays are both well inside the multi-second
 * range a real native restore has been observed arriving in. Once that one early check finds
 * nothing stale yet, the guard never looked again — so a native restore racing in seconds later
 * stood uncorrected, and worse, it had also been seen *replacing* the plugin's own already-live
 * target fold outright (unfolding it) while folding some unrelated line instead, which the old
 * per-check "was live, now isn't -> the user undid it" bookkeeping then locked in as a deliberate
 * user unfold, so the target was never refolded either.
 *
 * The fix keeps the simple one-shot decision exactly as before (still the only thing that acts
 * on the *first* check, so an isolated, genuine user fold of something the plugin never matched
 * — nothing else about the live state changing at the same time — is still left alone forever
 * after, same as R8 established) but adds a second, independent correction that can fire on any
 * later check, gated on a narrower, two-part signal a lone user action can't produce: one of
 * `foldTargets` that was live goes missing *in the very same check a brand-new, unprotected fold
 * appears*. A user unfolding their own already-applied target never coincides with some other,
 * previously-dormant line spontaneously folding itself — that combination only happens when
 * something (native restore) replaced the pane's whole fold state out from under this guard.
 * When that correlation fires, the missing target is refolded (never marked "the user undid it")
 * and the newly-appeared unprotected fold is unfolded, however many checks after the first one
 * this takes. `NATIVE_RESTORE_GUARD_DELAYS_MS` is widened well past the two fixed delays so a
 * real, slow relaunch gets enough chances to be caught; `OpenRestoreDeps.guardDelaysMs` lets
 * tests shrink that schedule to run fast without waiting out the real one.
 *
 * Residual, accepted gap (unchanged from R9, still deferred): a native restore that purely
 * *adds* a stale fold without ever disturbing one of this guard's own targets (R9's case (c)) is
 * still only caught by the simple one-shot's first check, same as before T19's fix — there is no
 * available signal to tell that apart from a user folding some new, previously-untouched block in
 * isolation, and guessing wrong there would reintroduce R8's own regression. */
const NATIVE_RESTORE_GUARD_DELAYS_MS: readonly number[] = [50, 300, 1000, 2500, 5000, 8000, 12000, 16000];

/** T1: the one concrete side effect a late, untagged native-restore transaction has been
 * observed causing live — `src/fold-recorder.ts`'s own `recordFoldEffects` runs on every
 * transaction carrying a fold effect, tagged or not, so native restore reapplying a stale offset
 * gets recorded as if the user had just folded that block, planting a brand-new (and wrong)
 * active anchor. Once this guard's own reconciliation has decided a live range is stale (not in
 * the matched set at all — see `reconcileNativeRestore`), this removes whatever anchor the
 * candidate at that same range maps to from the stored `folds` list, if it's there, rather than
 * leaving it to linger as a dangling entry nothing ever folds again correctly. Never touches
 * `dormant`, and never removes an anchor the matched set still wants — only ones a
 * `reconcileNativeRestore` call already decided have no claim on it at all. */
function cleanupSpuriousNativeFolds(
	store: FoldStore,
	path: string,
	candidates: readonly AnchoredBlock[],
	staleRanges: readonly LineRange[],
): void {
	if (staleRanges.length === 0) return;
	const latest = store.get(path);
	if (!latest) return;

	const folds = new Map<string, StoredAnchor>();
	for (const raw of latest.folds) {
		const anchor = parseAnchor(raw);
		if (anchor) folds.set(anchorKey(anchor), raw);
	}

	let changed = false;
	for (const range of staleRanges) {
		const candidate = candidates.find((c) => sameRange(c.range, range));
		if (!candidate) continue;
		if (folds.delete(anchorKey(candidate.anchor))) changed = true;
	}
	if (changed) {
		store.set(path, { contentHash: latest.contentHash, folds: Array.from(folds.values()), dormant: latest.dormant });
	}
}

/** Warkworth-46 PR-3 (T1): puts back the stored anchor of a block this guard has just refolded
 * because native restore had unfolded it. `src/fold-recorder.ts` records every untagged unfold as
 * the user's own, so when native restore unfolds a block whose stored anchor is the block's
 * current one (which a re-match now guarantees), the anchor is removed from `folds`. The guard
 * is the one that knows that unfold was not the user's (a target it refolds is, by its own
 * rules, one the user did not undo), so it restores the entry. A target whose anchor is still
 * stored is left alone and nothing is written for it. */
function restoreRefoldedAnchors(
	store: FoldStore,
	path: string,
	candidates: readonly AnchoredBlock[],
	refolded: readonly LineRange[],
): void {
	if (refolded.length === 0) return;
	const latest = store.get(path);
	if (!latest) return;

	const folds = new Map<string, StoredAnchor>();
	for (const raw of latest.folds) {
		const anchor = parseAnchor(raw);
		if (anchor) folds.set(anchorKey(anchor), raw);
	}
	let changed = false;
	for (const range of refolded) {
		const candidate = candidates.find((c) => sameRange(c.range, range));
		if (!candidate) continue;
		const key = anchorKey(candidate.anchor);
		if (folds.has(key)) continue;
		folds.set(key, candidate.anchor as unknown as StoredAnchor);
		changed = true;
	}
	if (changed) {
		store.set(path, { contentHash: latest.contentHash, folds: Array.from(folds.values()), dormant: latest.dormant });
	}
}

function rangeKey(r: LineRange): string {
	return `${r.startLine}:${r.endLine}`;
}

/** T1: schedules `NATIVE_RESTORE_GUARD_DELAYS_MS`'s own re-checks — see that constant's comment
 * for why this exists, and R8/T19 for why the fold and unfold decisions each take their own
 * input and run on their own schedule.
 *
 * `foldTargets` is exactly what the initial pass decided to fold (never a G13-deferred or
 * merely-matched range) — the only thing any check ever (re)folds, skipping any target whose
 * range currently contains the cursor and never re-folding a target that's gone missing in
 * isolation (treated as the user undoing it — see `nativeChurn` below for the one exception).
 *
 * `protectedRanges` is every range the match actually decided on (active or dormant, deferred
 * included) — used only to decide what must never be unfolded.
 *
 * `knownLiveAtOpen` is every range that was already live right after the initial dispatch this
 * guard follows (native folds that dispatch didn't unfold, plus `foldTargets` itself).
 *
 * The unfold side runs in two parts. The simple part acts once, on the first check that finds
 * the pane live and showing the expected text, correcting exactly the ranges that are live now
 * but were neither protected nor already known live at open — the ordinary, fast-arriving late
 * native restore T1/T8 exist for. T19/T20/T22: that one chance alone isn't enough against a real
 * relaunch, where native restore can race in seconds later, well past every check this guard's
 * fixed schedule used to have — so a second, narrower correction (`nativeChurn`, computed fresh
 * every check regardless of whether the simple part already ran) also fires whenever one of
 * `foldTargets` that was live goes missing *in the same check a brand-new unprotected fold shows
 * up* — the one combination CM6 gives this guard any way to tell apart from an isolated user
 * fold/unfold of something it never matched (see this function's own file comment for why that
 * correlation, and not a wider "keep checking forever" rule, is the signal used).
 *
 * Warkworth-46 PR-3: this is only ever started by `restoreOnOpen`, which the open pass runs after
 * the shared wait (src/load-wait.ts) has ended with the pane holding the note's real text, so
 * `delaysMs` is timed from the end of that wait, not from `file-open`. Every check then skips if the
 * pane it resolves to shows other text (`onTextMismatch` tells the caller, which logs it once). */
function scheduleNativeRestoreGuard(
	view: EditorView,
	expectedText: string,
	candidates: readonly AnchoredBlock[],
	foldTargets: readonly LineRange[],
	protectedRanges: readonly LineRange[],
	knownLiveAtOpen: readonly LineRange[],
	store: FoldStore,
	path: string,
	win: Window,
	resolveView?: (path: string) => EditorView | null,
	onLayoutReady?: (cb: () => void) => void,
	delaysMs: readonly number[] = NATIVE_RESTORE_GUARD_DELAYS_MS,
	onTextMismatch?: (editorLen: number) => void,
): void {
	// Fold side: seeded with every target the preceding dispatch already left live on `view`
	// itself (the usual case) — a target that later drops out of "live" after having been seen
	// live is, in isolation, the user unfolding it, never refolded again once that's noticed
	// (unless `nativeChurn` below says otherwise for that specific check).
	const everLive = new Set<string>(foldTargets.map(rangeKey));
	const reverted = new Set<string>();
	// Simple unfold side: see this function's own doc comment for why this only ever decides once.
	let unfoldDecided = false;
	// T8: the view a later check resolves to can be a wholly different EditorView instance
	// than `view` (Obsidian replaced the pane). That replacement never received this guard's
	// own initial dispatch, so nothing about it is "known live" or "already decided" yet —
	// reset all of the above the first time a check sees a different view than the last one,
	// so it's treated as a fresh pane to correct rather than one whose folds might have been
	// user-undone.
	let lastView: EditorView = view;

	const check = (): void => {
		// T8: re-resolve fresh every time rather than trusting the closed-over `view` — see
		// this function's own file comment (T8) for why.
		const live = resolveView?.(path) ?? view;
		if (!live.dom.isConnected) return; // the pane was destroyed since this open
		// Warkworth-46 PR-3: compared after line-ending normalisation, the one rule every guarded
		// pass uses (src/load-wait.ts). A pane showing other text (an edit, a different file, a
		// half-loaded document) is skipped whole: nothing is folded or unfolded and `store.set`
		// is never reached.
		const liveText = live.state.doc.toString();
		if (normaliseLineEndings(liveText) !== normaliseLineEndings(expectedText)) {
			onTextMismatch?.(liveText.length);
			return;
		}
		if (live !== lastView) {
			lastView = live;
			everLive.clear();
			reverted.clear();
			unfoldDecided = false;
		}
		const nativeFolded = liveFoldedLineRanges(live.state);
		const cursorLine = cursorLineOf(live);

		// T19: every range live now that isn't protected and wasn't already live right after the
		// initial dispatch — the same "stale offset" `reconcileNativeRestore` would have flagged
		// at open time, just discovered on a later check instead.
		const staleNow = nativeFolded.filter(
			(n) => !protectedRanges.some((p) => sameRange(p, n)) && !knownLiveAtOpen.some((k) => sameRange(k, n))
		);

		// T19: a target that was live and has gone missing *at the same moment* a brand-new
		// unprotected fold appears is native restore replacing the whole fold set wholesale, not
		// a deliberate, isolated user unfold — a lone user action never coincides with some other,
		// previously-untouched line spontaneously folding itself in the same check.
		const nativeChurn =
			staleNow.length > 0 &&
			foldTargets.some((target) => {
				const key = rangeKey(target);
				if (reverted.has(key) || !everLive.has(key)) return false;
				const stillLive = nativeFolded.some((n) => sameRange(n, target));
				const cursorInside = cursorLine !== null && target.startLine <= cursorLine && cursorLine <= target.endLine;
				return !stillLive && !cursorInside;
			});

		for (const target of foldTargets) {
			const key = rangeKey(target);
			if (reverted.has(key)) continue;
			const isLive = nativeFolded.some((n) => sameRange(n, target));
			if (isLive) everLive.add(key);
			// R9: never mark a target reverted when the same check also shows a brand-new
			// unprotected fold — that's nativeChurn's own job to refold, not a user undo.
			else if (everLive.has(key) && !nativeChurn) reverted.add(key); // was live, now isn't — the user undid it
		}

		const toFold = foldTargets.filter((target) => {
			const key = rangeKey(target);
			if (reverted.has(key)) return false; // never refold what the user just unfolded
			if (nativeFolded.some((n) => sameRange(n, target))) return false; // already live
			// G13 holds at check time too, not just at open time — re-read the live cursor.
			if (cursorLine !== null && target.startLine <= cursorLine && cursorLine <= target.endLine) return false;
			return true;
		});

		let toUnfold: LineRange[] = [];
		if (!unfoldDecided) {
			// The simple, one-shot decision — still exactly what T1/T8 need (a fast-arriving
			// late native restore shows up at this, the very first live check) without
			// re-litigating every later check's live state against an isolated user action.
			unfoldDecided = true;
			toUnfold = staleNow;
		} else if (nativeChurn) {
			// T19/T20/T22: even once the simple decision above already ran and found nothing
			// (the common case when a real relaunch's native restore hasn't landed by the
			// first check), a later check that catches the correlated "target missing + new
			// stale fold" signal still corrects it, however many checks that takes.
			toUnfold = staleNow;
		}

		dispatchFoldAndUnfold(live, toFold, toUnfold);
		// T1: only on the churn correction, where a target that was live has just been unfolded
		// by native restore and recorded as a user unfold; an ordinary first-time fold of a
		// target already has its anchor stored, so nothing is written for it.
		if (nativeChurn) restoreRefoldedAnchors(store, path, candidates, toFold);
		if (toUnfold.length > 0) cleanupSpuriousNativeFolds(store, path, candidates, toUnfold);
	};
	for (const delay of delaysMs) {
		win.setTimeout(check, delay);
	}
	// T8: one more check tied to Obsidian's own "layout (including every deferred leaf) is
	// actually ready" event, rather than a third guessed delay — see this function's own file
	// comment. Fires immediately if layout is already ready (redundant with, but no more
	// costly than, the 300ms check above in that case).
	onLayoutReady?.(check);
}

/** G8 (hash unchanged): applies `folds` as stored, with no matching at all — content is
 * byte-identical to what was last stored, so every stored anchor's `anchorKey` necessarily maps
 * 1:1 onto a candidate built fresh from this same text. Only ever folds (idempotently); never
 * unfolds anything Obsidian's own native restore already applied (E4's "native restore is left
 * alone" for the unchanged case). */
function applyStoredFoldsVerbatim(view: EditorView, folds: readonly StoredAnchor[]): void {
	const candidates = buildAnchors(view.state.doc.toString());
	const rangeByKey = new Map<string, LineRange>();
	for (const candidate of candidates) {
		if (isFoldable(candidate.range)) rangeByKey.set(anchorKey(candidate.anchor), candidate.range);
	}

	const nativeFolded = liveFoldedLineRanges(view.state);
	const toFold: LineRange[] = [];
	for (const raw of folds) {
		const anchor = parseAnchor(raw);
		if (!anchor) continue;
		const range = rangeByKey.get(anchorKey(anchor));
		if (!range) continue;
		if (nativeFolded.some((native) => sameRange(native, range))) continue; // already live
		toFold.push(range);
	}
	dispatchFoldAndUnfold(view, toFold, []);
}

/**
 * G8/E4: runs once when a Markdown pane for `path` is constructed and the store already has an
 * entry for it (the no-entry case is E5/G15, handled entirely separately by the caller — see
 * src/editor-watcher.ts). Never throws; every failure is caught and logged by the caller, same
 * discipline as every other async restore path in this plugin.
 */
export async function restoreOnOpen(view: EditorView, path: string, text: string, deps: OpenRestoreDeps): Promise<void> {
	const record = deps.store.get(path);
	if (!record) return; // defensive: callers only invoke this when an entry already exists

	const currentHash = hashText(text);
	// Warkworth-46 PR-1: the counts the log reports are read from the store before and after the
	// pass (never the arrays themselves), and the line is written once the pass has finished.
	const before = recordCounts(record);
	const logPass = (outcome: "applied" | "rematched"): void =>
		reportDiagnostic(
			deps.diagnosticLog,
			diagnosticEntry({ path, pass: "open", outcome, editorLen: text.length, diskLen: deps.diskLen, before, after: recordCounts(deps.store.get(path)) }),
		);
	// PR-3: one `native-guard` `waiting` line per open, the first time a check finds the pane
	// showing other text. Counts are read at that moment; nothing is changed by the line.
	let nativeGuardSkipLogged = false;
	const logNativeGuardSkip = (editorLen: number): void => {
		if (nativeGuardSkipLogged) return;
		nativeGuardSkipLogged = true;
		const counts = recordCounts(deps.store.get(path));
		reportDiagnostic(
			deps.diagnosticLog,
			diagnosticEntry({ path, pass: "native-guard", outcome: "waiting", editorLen, diskLen: deps.diskLen, before: counts, after: counts }),
		);
	};
	if (!needsRematchOnOpen(record.contentHash, currentHash)) {
		applyStoredFoldsVerbatim(view, record.folds);
		logPass("applied");
		return;
	}

	// G8 (hash differs): the file changed while it was closed. Captured before anything else
	// touches the view — this reflects whatever Obsidian's own native restore has applied *so
	// far*, not necessarily all of it (T1: scheduleNativeRestoreGuard re-checks this later).
	const nativeFolded = liveFoldedLineRanges(view.state);

	const storedAnchors: Anchor[] = [];
	for (const raw of record.folds) {
		const anchor = parseAnchor(raw);
		if (anchor) storedAnchors.push(anchor);
	}
	if (storedAnchors.length === 0 && record.dormant.length === 0) {
		// Nothing stored at all to re-match — still reconcile against native restore: an empty
		// matched set unfolds every native fold outright (E4).
		dispatchFoldAndUnfold(view, [], nativeFolded);
		deps.store.set(path, { contentHash: currentHash, folds: [], dormant: [] });
		// T1: native restore for this pane can still land after this handler already
		// returned — see scheduleNativeRestoreGuard's own comment. Nothing is matched or
		// folded here, and nothing was left live by the dispatch above (R8: foldTargets,
		// protectedRanges and knownLiveAtOpen are all empty), so the guard's one-shot unfold
		// check corrects anything native that shows up late.
		scheduleNativeRestoreGuard(
			view,
			text,
			buildAnchors(text),
			[],
			[],
			[],
			deps.store,
			path,
			deps.window ?? window,
			deps.resolveView,
			deps.onLayoutReady,
			deps.guardDelaysMs,
			logNativeGuardSkip,
		);
		logPass("rematched");
		return;
	}

	const candidates = buildAnchors(text);
	const candidateAnchors = candidates.map((c) => c.anchor);
	const win = deps.window ?? window;
	const matcherOptions: MatcherOptions = { yieldToHost: defaultYieldToHost(win), ...deps.matcherOptions };

	// Same pattern as src/fold-restorer.ts's restoreSettledChange: active and still-fresh
	// dormant anchors share one matchAnchors call so a dormant retry can never claim a
	// candidate the active pass already took this round.
	const now = deps.now?.() ?? Date.now();
	const dormantSurvivors = freshDormantAnchors(record.dormant, now);
	const combinedStored = [...storedAnchors, ...dormantSurvivors.map((s) => s.anchor)];
	const combinedMatches: MatchResult[] =
		combinedStored.length > 0 ? await matchAnchors(combinedStored, candidateAnchors, matcherOptions) : [];
	const matches = combinedMatches.slice(0, storedAnchors.length);
	const dormantMatchResults = combinedMatches.slice(storedAnchors.length);
	const dormantMatched = splitDormantResults(dormantSurvivors, dormantMatchResults).matched;

	const activeTargets = new Set<number>();
	for (const m of matches) if (m.tier !== "none") activeTargets.add(m.target);
	const losers = survivorsStillDormant(dormantSurvivors, dormantMatchResults);
	let stillDormant = losers.map((s) => s.raw);
	if (losers.length > 0 && activeTargets.size > 0) {
		const soloResults = await matchAnchors(losers.map((s) => s.anchor), candidateAnchors, matcherOptions);
		stillDormant = dropDormantClaimedByActive(losers, soloResults, activeTargets).kept;
	}

	if (!view.dom.isConnected) return; // the pane was destroyed while matching ran

	const cursorLine = cursorLineOf(view);
	const liveAnchorKeys = liveAnchorKeySet(deps.store, path);

	const plan = planRestore({
		stored: storedAnchors,
		matches,
		candidates,
		alreadyFolded: nativeFolded,
		cursorLine,
		liveAnchorKeys,
	});
	const dormantMatchedAnchors = dormantMatched.map((m) => m.anchor);
	const dormantPlan = planRestore({
		stored: dormantMatchedAnchors,
		matches: dormantMatched.map((m): MatchResult => ({ tier: "exact", target: m.candidateIndex })),
		candidates,
		alreadyFolded: nativeFolded,
		cursorLine,
		liveAnchorKeys: null,
	});

	// E4: every range the shared match actually decided on (tier !== "none", foldable, active
	// or dormant, deferred-for-G13 ones included) is "matched" and must never be unfolded.
	// Anything native folded that isn't in this set at all is a stale offset.
	const matchedRanges: LineRange[] = [];
	for (const match of matches) {
		if (match.tier === "none") continue;
		const candidate = candidates[match.target];
		if (candidate && isFoldable(candidate.range)) matchedRanges.push(candidate.range);
	}
	for (const m of dormantMatched) {
		const candidate = candidates[m.candidateIndex];
		if (candidate && isFoldable(candidate.range)) matchedRanges.push(candidate.range);
	}
	const { toUnfold } = reconcileNativeRestore(nativeFolded, matchedRanges);
	const toFold = [...plan.toFold, ...dormantPlan.toFold].map((t) => t.range);
	dispatchFoldAndUnfold(view, toFold, toUnfold);
	// R8: what the guard must still treat as live right after this dispatch — the native
	// folds it didn't unfold (protected or already matching), plus everything just folded.
	// `matchedRanges` (protectedRanges) is passed through separately: the guard must never
	// use it to decide what to *fold* (it includes G13-deferred and dormant-not-acted-on
	// ranges), only what must never be unfolded. See scheduleNativeRestoreGuard's own doc
	// comment and the T1/T8/R8 comments above `NATIVE_RESTORE_GUARD_DELAYS_MS`.
	const knownLiveAtOpen: LineRange[] = [...nativeFolded.filter((n) => !toUnfold.some((u) => sameRange(u, n))), ...toFold];
	scheduleNativeRestoreGuard(
		view,
		text,
		candidates,
		toFold,
		matchedRanges,
		knownLiveAtOpen,
		deps.store,
		path,
		win,
		deps.resolveView,
		deps.onLayoutReady,
		deps.guardDelaysMs,
		logNativeGuardSkip,
	);

	// Bookkeeping delta against a fresh store read (E3) — same discipline as restoreSettledChange.
	const latest = deps.store.get(path);
	if (latest) {
		// Warkworth-46 PR-3 (T1): matched folds are stored under their block's current anchor, so
		// the next open (hash now unchanged, exact-key lookup) finds them again.
		const activeFolds = refreshMatchedFolds(latest.folds, storedAnchors, matches, candidates);

		let dormantList = stillDormant;
		for (let i = 0; i < storedAnchors.length; i++) {
			if (matches[i]?.tier !== "none") continue;
			const key = anchorKey(storedAnchors[i]);
			if (!activeFolds.has(key)) continue; // E3: already removed meanwhile
			activeFolds.delete(key);
			dormantList = addDormant(dormantList, storedAnchors[i], now);
		}

		const actedDormantIdx = new Set<number>([...dormantPlan.toFold, ...dormantPlan.deferred].map((t) => t.anchorIndex));
		for (let i = 0; i < dormantMatched.length; i++) {
			const match = dormantMatched[i];
			const fresh = candidates[match.candidateIndex]?.anchor ?? match.anchor;
			if (actedDormantIdx.has(i)) {
				activeFolds.set(anchorKey(fresh), fresh as unknown as StoredAnchor);
				continue;
			}
			const candidate = candidates[match.candidateIndex];
			const alreadyLive = candidate !== undefined && nativeFolded.some((r) => sameRange(r, candidate.range));
			if (alreadyLive) {
				activeFolds.set(anchorKey(fresh), fresh as unknown as StoredAnchor);
			} else {
				dormantList = [...dormantList, match.anchor as unknown as StoredAnchor];
			}
		}

		deps.store.set(path, {
			contentHash: currentHash,
			folds: Array.from(activeFolds.values()),
			dormant: dormantList,
		});
	}
	logPass("rematched");
}
