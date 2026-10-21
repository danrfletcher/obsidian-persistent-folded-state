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
 * R1: a user keystroke during the 150ms settle window or the (possibly slow, chunked) match no
 * longer drops the whole restore. The only thing that genuinely invalidates a run is a *newer*
 * non-user change superseding it (E9's "the last settled text wins") — `deps.isSuperseded()`,
 * driven by a generation counter in src/editor-watcher.ts that only advances on another
 * non-user change, answers exactly that question. A live doc that has merely diverged from the
 * snapshot `text` because the user typed is not superseded: every matched candidate's line
 * range is instead mapped forward through `deps.getChangesSinceSnapshot()` (every document
 * change the view has seen since `text` was captured, composed by the same caller) onto the
 * *current* document before `planRestore` ever sees it, so G13's cursor check, the idempotent
 * "already folded" check and the actual dispatch all operate on live, not stale, line numbers.
 * When nothing has changed since the snapshot this mapping is the identity (same line numbers
 * in, same line numbers out), so the common/fast path is unaffected.
 *
 * Dropped, not thrown: a view destroyed, a pane switched to a different file, or a *newer*
 * non-user settle having already started for the same view (E9) all end the same way, with
 * `restoreSettledChange` resolving to an empty deferred list and dispatching nothing — those are
 * the only cases left that make a run itself obsolete, as opposed to merely needing its
 * candidates re-anchored (R1, above).
 *
 * PR-6 adds two more branches to this same pass, both driven off the one `store.get(path)` read
 * at the top:
 *  - No entry at all (E5/G15): there is nothing to match against, so this run adopts a baseline
 *    instead (src/baseline.ts) — read the folds already live in `view.state`, store them with
 *    the content hash, dispatch nothing. The active-fold/dormant machinery below never runs for
 *    this call.
 *  - An entry exists: the stored anchors are matched exactly as before, *and* the file's
 *    `dormant` list (still-fresh survivors only — src/dormant.ts's `freshDormantAnchors`) is
 *    folded into the *same* `matchAnchors` call as the active anchors (R1) — not a second,
 *    independent call, which is what let a dormant retry claim a candidate the active pass had
 *    already matched this round, folding one block twice and storing two anchors for it.
 *    Sharing one call's `consumed` tracking means a dormant anchor can only ever win a
 *    candidate the active pass didn't already take (never-break rule 4, enforced the same way
 *    it already is between two active anchors). A dormant anchor that matches folds through the
 *    same `planRestore`/`dispatchFoldTargets` path as an active one (a second `planRestore`
 *    call, with `liveAnchorKeys: null` since dormant membership was already decided by the
 *    shared match above, not by `src/restore-plan.ts`'s own E3 check) and is promoted back into
 *    `folds` — whether `planRestore` actually dispatched it this round (folded it now, or
 *    deferred it for G13) or it was already folded live for some other reason (T13: real
 *    Obsidian's own native per-session fold memory can re-apply a line range as a side effect of
 *    reloading an externally-changed file, before this pass ever runs; `alreadyFolded` can't
 *    tell that apart from the user folding the exact same block, but it doesn't need to — the
 *    true G6 "one fold only" duplicate, an active anchor and a dormant anchor both confidently
 *    targeting the same candidate, is already resolved earlier in this function by the shared
 *    `matchAnchors` call's own candidate-claiming plus `dropDormantClaimedByActive`, so nothing
 *    that reaches this matched list can actually be that duplicate). A previously-active anchor the matcher now reports "no match" for is demoted
 *    into `dormant` via `addDormant` instead of just being dropped. Both bookkeeping steps are
 *    applied as a delta against a *fresh* read of the store (R4-style, not the stale
 *    top-of-function snapshot), so a fold or unfold the user made during the match is never
 *    clobbered (E3).
 */
import { foldEffect } from "@codemirror/language";
import { Text, type ChangeDesc, type ChangeSet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { anchorKey, buildAnchors, parseAnchor, type Anchor, type AnchoredBlock, type LineRange } from "./anchors";
import { liveFoldedLineRanges } from "./live-folds";
import { matchAnchors, type MatcherOptions, type MatchResult } from "./matcher";
import { isAlreadyFolded, planRestore, type FoldTarget } from "./restore-plan";
import { OWN_FOLD_ANNOTATION } from "./fold-recorder";
import { hashText, type FoldStore } from "./fold-store";
import {
	addDormant,
	dropDormantClaimedByActive,
	freshDormantAnchors,
	splitDormantResults,
	survivorsStillDormant,
} from "./dormant";
import { buildBaseline } from "./baseline";
import type { StoredAnchor } from "./types";

/** G13's deferred queue, kept across updates by src/editor-watcher.ts. Positions, not line
 * numbers (R2): `from`/`to` are character offsets covering the whole block (the start of its
 * own first line to the end of its last), mapped forward through every subsequent update's own
 * `ChangeDesc` (`mapDeferredTargets`) so an edit inside or around a still-deferred block never
 * leaves it pointing at stale lines. `anchorKey` lets the caller re-check the target is still
 * live (`liveAnchorKeySet`) right before applying it — a target whose anchor the user has since
 * unfolded, or that "Forget stored folds for this note" removed, is dropped rather than applied
 * (R2). */
export interface DeferredFoldTarget {
	anchorKey: string;
	from: number;
	to: number;
}

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
	/** R1: true once a *newer* non-user change has already started a fresher run for this same
	 * view (E9 — "the last settled text wins"), at which point this run must drop everything
	 * rather than map its now-doubly-stale candidates forward. Defaults to `() => false` when
	 * omitted (a direct unit-test caller that only ever calls this once per view has no newer
	 * run to be superseded by). */
	isSuperseded?: () => boolean;
	/** R1: every document change the view has seen since `text` (the settled snapshot this run
	 * was given) was captured, composed into one `ChangeSet` by the caller (src/editor-watcher.ts
	 * tracks this per view, reset exactly when a new non-user change starts a new snapshot).
	 * Omitted entirely by a direct unit-test caller that never lets its view diverge from `text`
	 * — candidates are then used exactly as `buildAnchors(text)` produced them. */
	getChangesSinceSnapshot?: () => ChangeSet;
	/** PR-6 (G6): clock used for `dormantSince`/age checks. Defaults to `Date.now`; overridable
	 * so a test can drive dormancy and expiry with a fake clock instead of real wall time. */
	now?: () => number;
}

/** T1: delegates to `src/live-folds.ts` so this agrees with `src/baseline.ts` on the same
 * EOF-boundary convention `buildAnchors` uses — see that module's file comment. */
function currentFoldedLineRanges(view: EditorView): LineRange[] {
	return liveFoldedLineRanges(view.state);
}

function cursorLineOf(view: EditorView): number | null {
	const pos = view.state.selection.main.head;
	if (pos < 0 || pos > view.state.doc.length) return null;
	return view.state.doc.lineAt(pos).number;
}

/** Anchor keys (`anchorKey`) for every entry *currently* stored for `path` — read fresh, not
 * from whatever snapshot drove the match, so a since-removed anchor is correctly absent (E3). A
 * PR-2-era raw-text record (no `siblingIndex`/`parentChain`) fails `parseAnchor` and is simply
 * excluded, same as everywhere else this PR reads stored folds. Exported for R2:
 * src/editor-watcher.ts's deferred-fold recheck needs the same fresh-live-anchor check this
 * module already does for its own (immediate) restore pass. */
export function liveAnchorKeySet(store: FoldStore, path: string): ReadonlySet<string> {
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
 * longer has that many lines (it shrank between planning and dispatch), or when there's nothing
 * left to hide. */
function foldEffectFor(view: EditorView, range: LineRange): ReturnType<typeof foldEffect.of> | null {
	if (range.endLine <= range.startLine) return null; // nothing to collapse
	if (range.endLine > view.state.doc.lines) return null;
	const from = view.state.doc.line(range.startLine).to;
	const to = view.state.doc.line(range.endLine).to;
	if (from >= to) return null; // nothing left to hide
	return foldEffect.of({ from, to });
}

function dispatchFoldTargets(view: EditorView, targets: readonly { range: LineRange }[]): void {
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

/** The whole-block character span (start of its own first line to the end of its last) for
 * `range` within `doc` — the stable anchor points R1/R2 both map forward through subsequent
 * changes, as opposed to `foldEffectFor`'s own (separately recomputed, always-fresh) fold
 * boundaries. Clamped to `doc`'s current line count so a range computed against a
 * since-shrunk/grown document never throws. */
function blockSpan(doc: Text, range: LineRange): { from: number; to: number } {
	const startLine = Math.min(Math.max(range.startLine, 1), doc.lines);
	const endLine = Math.min(Math.max(range.endLine, 1), doc.lines);
	return { from: doc.line(startLine).from, to: doc.line(endLine).to };
}

/** R1: maps `range` (a candidate's line range in `snapshotDoc`'s coordinates — the settled text
 * a restore run matched against) forward through `changes` (every edit the view has seen since)
 * onto `liveDoc`, returning the equivalent line range there. The identity when `changes` carries
 * no edits: same offsets map to themselves, `liveDoc.lineAt` of them is the same line numbers
 * `range` already had. `-1`/`1` bias on from/to keeps an insertion exactly at either boundary
 * outside the block (an inserted sibling before it, or one after it, isn't swallowed in) while
 * still letting an edit *inside* the block grow or shrink it normally. */
function mapLineRangeForward(range: LineRange, snapshotDoc: Text, changes: ChangeDesc, liveDoc: Text): LineRange {
	const { from, to } = blockSpan(snapshotDoc, range);
	const mappedFrom = changes.mapPos(from, -1);
	const mappedTo = Math.max(changes.mapPos(to, 1), mappedFrom);
	const clampedFrom = Math.min(mappedFrom, liveDoc.length);
	const clampedTo = Math.min(mappedTo, liveDoc.length);
	return { startLine: liveDoc.lineAt(clampedFrom).number, endLine: liveDoc.lineAt(clampedTo).number };
}

/** Rebuilds `candidates`' ranges in `liveDoc`'s coordinate space (R1). `text` is the settled
 * snapshot `candidates` (from `buildAnchors(text)`) was computed against; `changes` is every
 * edit since. Only `.range` changes — `.anchor` (the structural identity) is untouched, since
 * nothing about *what* a block is was invalidated by a user edit elsewhere in the document. */
function mapCandidatesForward(candidates: AnchoredBlock[], text: string, changes: ChangeDesc, liveDoc: Text): AnchoredBlock[] {
	const snapshotDoc = Text.of(text.length === 0 ? [""] : text.split("\n"));
	return candidates.map((candidate) => ({
		anchor: candidate.anchor,
		range: mapLineRangeForward(candidate.range, snapshotDoc, changes, liveDoc),
	}));
}

/** Builds a `DeferredFoldTarget` (R2) from a plan's own `FoldTarget` (anchor index + line range,
 * already in live-doc coordinates — see `restoreSettledChange`) — the character-offset span that
 * gets mapped forward through later changes until the cursor leaves it. R5 (PR-5): the span is
 * the part the fold would hide, so `from` is the end of the block's first line (where the fold
 * starts), not the start of that line: a cursor resting on the heading/task line itself is
 * outside the span, matching `planRestore`'s own "inside" rule. */
function toDeferredFoldTarget(view: EditorView, anchor: Anchor | undefined, range: LineRange): DeferredFoldTarget | null {
	if (!anchor) return null; // defensive: `target.anchorIndex` should always index a real stored anchor
	const { from: blockFrom, to } = blockSpan(view.state.doc, range);
	const from = view.state.doc.lineAt(blockFrom).to;
	return { anchorKey: anchorKey(anchor), from, to };
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
): Promise<DeferredFoldTarget[]> {
	// R2 (PR-7): a settle timer captures `path` when it's first triggered (src/editor-watcher.ts),
	// but by the time it actually fires, a rename may have already landed (real Obsidian mutates
	// a renamed file's own TFile.path in place, so the pane's own active path reflects the rename
	// immediately — src/fold-store.ts's `handleRename` has already re-keyed the store entry away
	// from `path` too). Checked here, before the E5/G15 "no entry" branch below, so a stale
	// `path` can never fall into that branch and have `buildBaseline` create a brand-new store
	// entry under a key nothing on disk answers to any more. The later, narrower check further
	// down (after the possibly-slow match) still applies for the case where the rename arrives
	// *during* that match.
	if (deps.getActivePath(view) !== path) return [];

	const snapshot = deps.store.get(path);
	if (!snapshot) {
		// E5/G15: a never-before-seen file — there is nothing to match against, so adopt
		// Obsidian's current folds as the baseline instead. Dispatches nothing at all (no fold
		// or unfold effect, no transaction): the editor looks exactly as it was opened.
		const baseline = buildBaseline(view.state, text);
		deps.store.set(path, {
			contentHash: baseline.contentHash,
			folds: baseline.anchors as unknown as StoredAnchor[],
			dormant: [],
		});
		return [];
	}
	if (snapshot.folds.length === 0 && snapshot.dormant.length === 0) return [];

	// The snapshot (E11/E9): taken once, now, before the possibly-slow matching below starts.
	const storedAnchors: Anchor[] = [];
	for (const raw of snapshot.folds) {
		const anchor = parseAnchor(raw);
		if (anchor) storedAnchors.push(anchor);
	}

	const candidates = buildAnchors(text);
	const candidateAnchors = candidates.map((c) => c.anchor);
	const win = deps.window ?? window;
	const matcherOptions: MatcherOptions = { yieldToHost: defaultYieldToHost(win), ...deps.matcherOptions };

	// G6/R1: the same reload that re-matches the active folds also retries whatever's dormant
	// for this file — against the very same candidates, and in the very same `matchAnchors`
	// call as the active anchors (not a second, independent call), so a dormant retry can never
	// be handed a candidate the active pass already claimed this round (never-break rule 4).
	// Two independent calls — the original bug — each ran their own `consumed` tracking and
	// could both confidently claim the same block, folding it twice and promoting two anchors
	// for one block.
	const now = deps.now?.() ?? Date.now();
	const dormantSurvivors = freshDormantAnchors(snapshot.dormant, now);
	const combinedStored = [...storedAnchors, ...dormantSurvivors.map((s) => s.anchor)];
	const combinedMatches: MatchResult[] =
		combinedStored.length > 0 ? await matchAnchors(combinedStored, candidateAnchors, matcherOptions) : [];
	const matches = combinedMatches.slice(0, storedAnchors.length);
	const dormantMatchResults = combinedMatches.slice(storedAnchors.length);
	const dormantMatched = splitDormantResults(dormantSurvivors, dormantMatchResults).matched;

	// T3/R6 (G6): a dormant anchor the shared match just reported "no match" for might
	// genuinely have no matching candidate at all (keep it dormant — the ordinary case), or it
	// might have lost its only confident candidate to one of the active anchors matched in the
	// very same round (the user has meanwhile folded that same block: G6's "one fold only, the
	// dormant entry is dropped"). A plain "none" tier can't tell those apart on its own, so any
	// loser is re-matched alone (no active anchors competing) against the same candidates; one
	// that lands on a candidate the active pass already claimed is dropped outright instead of
	// being carried forward.
	const activeTargets = new Set<number>();
	for (const m of matches) if (m.tier !== "none") activeTargets.add(m.target);
	const losers = survivorsStillDormant(dormantSurvivors, dormantMatchResults);
	let stillDormant = losers.map((s) => s.raw);
	if (losers.length > 0 && activeTargets.size > 0) {
		const soloResults = await matchAnchors(losers.map((s) => s.anchor), candidateAnchors, matcherOptions);
		stillDormant = dropDormantClaimedByActive(losers, soloResults, activeTargets).kept;
	}
	const dormantResult = { matched: dormantMatched, stillDormant };

	if (!view.dom.isConnected) return []; // the pane/view was destroyed while matching ran
	if (deps.getActivePath(view) !== path) return []; // switched to a different file meanwhile
	if (deps.isSuperseded?.() ?? false) return []; // a newer non-user settle has already started (E9)

	// R1: the live doc may have diverged from `text` because the user typed during the 150ms
	// settle window or the match itself — not a newer settle (already ruled out above), so
	// instead of dropping the whole restore, every candidate's range is mapped forward onto
	// the live document before planning. When nothing has changed this is the identity.
	const changes = deps.getChangesSinceSnapshot?.();
	const liveCandidates = changes ? mapCandidatesForward(candidates, text, changes, view.state.doc) : candidates;
	const alreadyFolded = currentFoldedLineRanges(view);
	const cursorLine = cursorLineOf(view);

	const plan = planRestore({
		stored: storedAnchors,
		matches,
		candidates: liveCandidates,
		alreadyFolded,
		cursorLine,
		liveAnchorKeys: liveAnchorKeySet(deps.store, path),
	});

	// G6: a dormant anchor that matched this retry folds through the same tagged-effect path as
	// an active match, re-using `planRestore` for its idempotent/G13-cursor handling — but with
	// `liveAnchorKeys: null`, since "is this dormant match still live" was already decided by
	// the shared `matchAnchors` call above (dormant membership, and never-break rule 4 against
	// the active anchors, not by `restore-plan.ts`'s own E3 check).
	const dormantMatchedAnchors = dormantResult.matched.map((m) => m.anchor);
	const dormantPlan = planRestore({
		stored: dormantMatchedAnchors,
		matches: dormantResult.matched.map((m): MatchResult => ({ tier: "exact", target: m.candidateIndex })),
		candidates: liveCandidates,
		alreadyFolded,
		cursorLine,
		liveAnchorKeys: null,
	});

	dispatchFoldTargets(view, [...plan.toFold, ...dormantPlan.toFold]);

	// Folds/dormant bookkeeping (G6) is applied as a *delta*, against a fresh read of the store
	// taken right now — not the stale top-of-function `snapshot` — so a fold or unfold the user
	// made while the match above was running is never clobbered (E3), same discipline as the
	// contentHash-only update this replaces.
	const latest = deps.store.get(path);
	if (latest) {
		const activeFolds = new Map<string, StoredAnchor>();
		for (const raw of latest.folds) {
			const anchor = parseAnchor(raw);
			if (anchor) activeFolds.set(anchorKey(anchor), raw);
		}

		let dormantList = dormantResult.stillDormant;
		for (let i = 0; i < storedAnchors.length; i++) {
			const match = matches[i];
			if (match?.tier !== "none") {
				// R8 (PR-5): re-key the stored entry to the block it matched, as that block reads
				// now. A fuzzy or sibling-shifted match otherwise leaves the old anchor stored, so
				// the user's later unfold of this block (whose anchor `describeFold` builds from the
				// current text) misses it and the next external write folds the block again.
				const matchedBlock = match ? liveCandidates[match.target] : undefined;
				if (!matchedBlock) continue;
				const oldKey = anchorKey(storedAnchors[i]);
				const newKey = anchorKey(matchedBlock.anchor);
				if (oldKey === newKey || !activeFolds.has(oldKey)) continue; // E3: removed meanwhile
				activeFolds.delete(oldKey);
				if (!activeFolds.has(newKey)) activeFolds.set(newKey, matchedBlock.anchor as unknown as StoredAnchor);
				continue;
			}
			const key = anchorKey(storedAnchors[i]);
			if (!activeFolds.has(key)) continue; // E3: the user already removed it meanwhile
			activeFolds.delete(key);
			dormantList = addDormant(dormantList, storedAnchors[i], now);
		}

		// R1/G6: a dormant match the plan actually acted on (folding it now, or deferring it
		// for G13) is promoted to the active list — the "successful retry" the matcher found.
		// T13: a match the plan left out because its target is already folded live right now
		// is promoted too, not dropped — `alreadyFolded` is read before this pass's own
		// dispatch, so "already live" here can mean the plan's own idempotent skip, another
		// anchor's dispatch in this same pass, or (in real Obsidian) its own native
		// per-session fold memory re-applying the range as a side effect of reloading,
		// independent of this plugin entirely. None of those is the true G6 "one fold only"
		// duplicate (an active anchor and this dormant anchor both confidently wanting the
		// same candidate) — that case is already resolved earlier in this function, before
		// `dormantResult.matched` is ever built (the shared `matchAnchors` call's own
		// candidate-claiming, plus `dropDormantClaimedByActive`'s loser recheck) — so there is
		// nothing here left to distinguish "the user independently folded this" from "it's
		// already live for some unrelated reason", and dropping it anyway only threw away the
		// plugin's own tracking of a fold that is genuinely still there. A match left out for
		// any other reason (e.g. its matched block collapsed to a single line and is no
		// longer foldable) stays dormant with its original `dormantSince` instead of being
		// silently lost.
		const actedDormantIdx = new Set<number>([...dormantPlan.toFold, ...dormantPlan.deferred].map((t) => t.anchorIndex));
		for (let i = 0; i < dormantResult.matched.length; i++) {
			const match = dormantResult.matched[i];
			if (actedDormantIdx.has(i)) {
				activeFolds.set(anchorKey(match.anchor), match.anchor as unknown as StoredAnchor);
				continue;
			}
			const candidate = liveCandidates[match.candidateIndex];
			// R15 (PR-6)/R3 (PR-5): the same start-line test the planner uses, so a native fold
			// that ends a blank line short of (or past) the candidate still counts as live.
			const alreadyLive = candidate !== undefined && isAlreadyFolded(alreadyFolded, candidate.range);
			if (alreadyLive) {
				activeFolds.set(anchorKey(match.anchor), match.anchor as unknown as StoredAnchor);
			} else {
				dormantList = [...dormantList, match.anchor as unknown as StoredAnchor];
			}
		}

		deps.store.set(path, {
			contentHash: hashText(text),
			folds: Array.from(activeFolds.values()),
			dormant: dormantList,
		});
	}

	// R8: a deferred target is keyed by the anchor now stored for its block (the re-keyed one),
	// so the later `liveAnchorKeys` recheck (applyReadyDeferredFolds) still finds it.
	const activeDeferred = plan.deferred
		.map((target) => {
			const matched = matches[target.anchorIndex];
			const block = matched && matched.tier !== "none" ? liveCandidates[matched.target] : undefined;
			return toDeferredFoldTarget(view, block?.anchor ?? storedAnchors[target.anchorIndex], target.range);
		})
		.filter((target): target is DeferredFoldTarget => target !== null);
	const dormantDeferred = dormantPlan.deferred
		.map((target: FoldTarget) => toDeferredFoldTarget(view, dormantMatchedAnchors[target.anchorIndex], target.range))
		.filter((target): target is DeferredFoldTarget => target !== null);
	return [...activeDeferred, ...dormantDeferred];
}

/** R2: maps every still-deferred target's character span (from the end of its first line to the end of its last, R5) forward through one update's own
 * `ChangeDesc` — called unconditionally by src/editor-watcher.ts on every update that carries a
 * document change, so a line added or removed inside (or around) a deferred block keeps its
 * span over the same content rather than the stale line numbers it was captured with. A block
 * whose span collapses to nothing (its content was deleted outright) is dropped, same as
 * `foldEffectFor`'s own "nothing left to hide" guard. */
export function mapDeferredTargets(targets: readonly DeferredFoldTarget[], changes: ChangeDesc): DeferredFoldTarget[] {
	const mapped: DeferredFoldTarget[] = [];
	for (const target of targets) {
		// `from` is the end of the block's first line (R5): bias +1 keeps text typed at the end of
		// that line (before the fold) outside the span, while `to` keeps its +1 bias.
		const from = changes.mapPos(target.from, 1);
		const to = changes.mapPos(target.to, 1);
		if (to <= from) continue; // the block this would have folded no longer exists
		mapped.push({ anchorKey: target.anchorKey, from, to });
	}
	return mapped;
}

/** G13's other half: re-checks every still-deferred target against the *current* cursor
 * position and `liveAnchorKeys` (R2), applying (dispatching) each one whose block the cursor
 * has since left — and silently dropping (neither applying nor keeping) any whose anchor is no
 * longer live, because the user unfolded it, or "Forget stored folds for this note" ran, while
 * it was still deferred (R2). Cheap and safe to call on every update, including ones unrelated
 * to the cursor at all — a no-op once `pending` is empty. Never throws on a doc that's since
 * shrunk below a deferred target's span (`foldEffectFor` already guards that). */
export function applyReadyDeferredFolds(
	view: EditorView,
	pending: readonly DeferredFoldTarget[],
	liveAnchorKeys: ReadonlySet<string>,
): DeferredFoldTarget[] {
	if (pending.length === 0) return [];

	const cursorPos = view.state.selection.main.head;
	const ready: { range: LineRange }[] = [];
	const stillPending: DeferredFoldTarget[] = [];
	for (const target of pending) {
		if (!liveAnchorKeys.has(target.anchorKey)) continue; // R2: forgotten/unfolded while deferred

		const inside = cursorPos > target.from && cursorPos <= target.to; // R5: not on the first line
		if (inside) {
			stillPending.push(target);
			continue;
		}

		const doc = view.state.doc;
		const startLine = doc.lineAt(Math.min(target.from, doc.length)).number;
		const endLine = doc.lineAt(Math.min(target.to, doc.length)).number;
		ready.push({ range: { startLine, endLine } });
	}

	dispatchFoldTargets(view, ready);
	return stillPending;
}
