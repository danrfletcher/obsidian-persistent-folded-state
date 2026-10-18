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
 */
import { foldEffect, foldedRanges } from "@codemirror/language";
import { Text, type ChangeDesc, type ChangeSet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { anchorKey, buildAnchors, parseAnchor, type Anchor, type AnchoredBlock, type LineRange } from "./anchors";
import { matchAnchors, type MatcherOptions, type MatchResult } from "./matcher";
import { planRestore } from "./restore-plan";
import { OWN_FOLD_ANNOTATION } from "./fold-recorder";
import { hashText, type FoldStore } from "./fold-store";

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
 * gets mapped forward through later changes until the cursor leaves it. */
function toDeferredFoldTarget(view: EditorView, anchor: Anchor | undefined, range: LineRange): DeferredFoldTarget | null {
	if (!anchor) return null; // defensive: `target.anchorIndex` should always index a real stored anchor
	const { from, to } = blockSpan(view.state.doc, range);
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
	if (deps.isSuperseded?.() ?? false) return []; // a newer non-user settle has already started (E9)

	// R1: the live doc may have diverged from `text` because the user typed during the 150ms
	// settle window or the match itself — not a newer settle (already ruled out above), so
	// instead of dropping the whole restore, every candidate's range is mapped forward onto
	// the live document before planning. When nothing has changed this is the identity.
	const changes = deps.getChangesSinceSnapshot?.();
	const liveCandidates = changes ? mapCandidatesForward(candidates, text, changes, view.state.doc) : candidates;

	const plan = planRestore({
		stored: storedAnchors,
		matches,
		candidates: liveCandidates,
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

	return plan.deferred
		.map((target) => toDeferredFoldTarget(view, storedAnchors[target.anchorIndex], target.range))
		.filter((target): target is DeferredFoldTarget => target !== null);
}

/** R2: maps every still-deferred target's character span forward through one update's own
 * `ChangeDesc` — called unconditionally by src/editor-watcher.ts on every update that carries a
 * document change, so a line added or removed inside (or around) a deferred block keeps its
 * span over the same content rather than the stale line numbers it was captured with. A block
 * whose span collapses to nothing (its content was deleted outright) is dropped, same as
 * `foldEffectFor`'s own "nothing left to hide" guard. */
export function mapDeferredTargets(targets: readonly DeferredFoldTarget[], changes: ChangeDesc): DeferredFoldTarget[] {
	const mapped: DeferredFoldTarget[] = [];
	for (const target of targets) {
		const from = changes.mapPos(target.from, -1);
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

		const inside = cursorPos >= target.from && cursorPos <= target.to;
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
