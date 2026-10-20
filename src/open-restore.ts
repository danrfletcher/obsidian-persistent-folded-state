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
 * and the short guard window that re-corrects it.
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
import { liveAnchorKeySet } from "./fold-restorer";
import { needsRematchOnOpen, reconcileNativeRestore } from "./vault-lifecycle";
import {
	addDormant,
	dropDormantClaimedByActive,
	freshDormantAnchors,
	splitDormantResults,
	survivorsStillDormant,
} from "./dormant";
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
 * all) once the live state already agrees with `matched` — the ordinary, already-synchronous
 * case this guards against never fires a second dispatch. Bails out (without touching the view
 * or the store) once the pane has gone away or moved on to different text, so a guard scheduled
 * for one open can never act against a later one in the same pane.
 *
 * T8: against a real Obsidian relaunch (not just a same-session reopen), these two fixed delays
 * were observed never correcting anything at all — not because the reconciliation itself is
 * wrong, but because both checks can run, find nothing stale yet (native restore hasn't landed),
 * and nothing ever checks again afterwards. There is no single delay that is "long enough" for
 * every machine and every startup — a deferred leaf's real editor can resolve an unpredictable
 * amount of time into a slow relaunch. Rather than guess a third, longer number, the
 * `onLayoutReady` check added below `scheduleNativeRestoreGuard` ties the backstop check to an
 * actual Obsidian-reported event (the same one `main.ts`'s own orphan-prune already waits on)
 * instead of a guess, and `resolveView` re-resolves the live `EditorView` fresh at every check
 * rather than trusting the one reference captured at file-open time, in case that's what was
 * silently going stale and bailing out the old checks for good. */
const NATIVE_RESTORE_GUARD_DELAYS_MS: readonly number[] = [50, 300];

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

/** T1: schedules `NATIVE_RESTORE_GUARD_DELAYS_MS`'s own re-checks — see that constant's comment
 * for why this exists. `matched` and `candidates` are exactly what the caller already computed
 * for its own (possibly too-early) reconciliation; this just re-applies the same decision later. */
function scheduleNativeRestoreGuard(
	view: EditorView,
	expectedText: string,
	candidates: readonly AnchoredBlock[],
	matched: readonly LineRange[],
	store: FoldStore,
	path: string,
	win: Window,
	resolveView?: (path: string) => EditorView | null,
	onLayoutReady?: (cb: () => void) => void,
	delaysMs: readonly number[] = NATIVE_RESTORE_GUARD_DELAYS_MS,
): void {
	const check = (): void => {
		// T8: re-resolve fresh every time rather than trusting the closed-over `view` — see
		// this function's own file comment (T8) for why.
		const live = resolveView?.(path) ?? view;
		if (!live.dom.isConnected) return; // the pane was destroyed since this open
		if (live.state.doc.toString() !== expectedText) return; // moved on (edit, or a different file)
		const nativeFolded = liveFoldedLineRanges(live.state);
		const { toFold, toUnfold } = reconcileNativeRestore(nativeFolded, matched);
		dispatchFoldAndUnfold(live, toFold, toUnfold);
		cleanupSpuriousNativeFolds(store, path, candidates, toUnfold);
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
	if (!needsRematchOnOpen(record.contentHash, currentHash)) {
		applyStoredFoldsVerbatim(view, record.folds);
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
		// returned — see scheduleNativeRestoreGuard's own comment. Nothing is ever matched
		// here, so every guard check keeps unfolding anything native that shows up late.
		scheduleNativeRestoreGuard(
			view,
			text,
			buildAnchors(text),
			[],
			deps.store,
			path,
			deps.window ?? window,
			deps.resolveView,
			deps.onLayoutReady
		);
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
	// T1: see scheduleNativeRestoreGuard's own comment — the capture above is a single
	// synchronous snapshot, and real Obsidian has been observed applying its own native
	// restore for this exact pane *after* it, clobbering this dispatch. Re-checks the same
	// `matchedRanges` decision a couple more times shortly afterwards.
	scheduleNativeRestoreGuard(view, text, candidates, matchedRanges, deps.store, path, win, deps.resolveView, deps.onLayoutReady);

	// Bookkeeping delta against a fresh store read (E3) — same discipline as restoreSettledChange.
	const latest = deps.store.get(path);
	if (latest) {
		const activeFolds = new Map<string, StoredAnchor>();
		for (const raw of latest.folds) {
			const anchor = parseAnchor(raw);
			if (anchor) activeFolds.set(anchorKey(anchor), raw);
		}

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
			if (actedDormantIdx.has(i)) {
				activeFolds.set(anchorKey(match.anchor), match.anchor as unknown as StoredAnchor);
				continue;
			}
			const candidate = candidates[match.candidateIndex];
			const alreadyLive = candidate !== undefined && nativeFolded.some((r) => sameRange(r, candidate.range));
			if (alreadyLive) {
				activeFolds.set(anchorKey(match.anchor), match.anchor as unknown as StoredAnchor);
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
}
