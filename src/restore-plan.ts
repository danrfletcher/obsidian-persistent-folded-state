/**
 * The pure restore planner (PR-5). Given the matcher's own per-anchor decision (PR-4), the
 * candidates it matched against (PR-3's `buildAnchors` output for the new text), what's already
 * folded live in the editor, and where the cursor sits, decides which blocks to fold now and
 * which to defer (G13). No Obsidian, CodeMirror, DOM, file or network imports — plain data in,
 * plain data out, same fence discipline as `src/matcher.ts`/`src/anchors.ts` (F1/F8/F9).
 *
 * This module never re-orders or re-filters the matcher's own decision (G14's wiring guard): it
 * walks `matches` in input order and, for each one, only ever decides "apply it, defer it, or
 * leave it out" — it never substitutes a different candidate or reconsiders which tier won.
 * Every reason an anchor is left out is one the matcher or the caller already decided, not a new
 * one invented here:
 *  - `match.tier === "none"` (no candidate, below threshold, ambiguous or capped — the matcher's
 *    own G4/E2/E6 decision) — F4/G15: a block absent from the map, or one the matcher couldn't
 *    confidently place, is never folded.
 *  - the matched candidate's current line range collapsed to a single line (G2/G3's "no longer
 *    foldable" edge case — e.g. a heading whose body disappeared, or one that became plain text
 *    and so was never eligible to match as "heading" at all and reads as "no-candidate" instead;
 *    either way there is nothing left to fold).
 *  - the matched range is already folded live in the editor (idempotent re-apply — redispatching
 *    an identical fold effect would be harmless but pointless, so it's left out here instead).
 *  - `liveAnchorKeys` is supplied and the stored anchor's key isn't in it (E3: the user unfolded
 *    — or otherwise removed — this exact anchor from the map after the settle snapshot was
 *    taken but before the match finished; the restore pass must not re-fold something the user
 *    has since undone). Passing `null` skips this check entirely for a caller that has already
 *    verified membership itself, or that has no live map to compare against (e.g. a pure test).
 * A left-out anchor is simply absent from both `toFold` and `deferred` — never specially marked.
 *
 * The one case this module *does* actively redirect, rather than leave out: G13. A match whose
 * block the cursor currently sits inside is moved to `deferred` instead of `toFold` — the caller
 * (src/fold-restorer.ts) re-checks every deferred target on each later update and applies it
 * once the cursor leaves, so it still ends up folded (G13: "applied once the cursor leaves the
 * block"), just not in this pass.
 */
import { anchorKey, type Anchor, type AnchoredBlock, type LineRange } from "./anchors";
import type { MatchResult } from "./matcher";

/** One stored anchor's resolved restore action: which candidate block (by index into `stored`,
 * for traceability back to the anchor that produced it) and which line range to fold. */
export interface FoldTarget {
	/** Index into the `stored`/`matches` arrays this target was derived from. */
	anchorIndex: number;
	range: LineRange;
}

export interface RestorePlanInput {
	/** The stored anchors `matches` was computed against, in the same order. Only read for the
	 * E3 `liveAnchorKeys` check (via `anchorKey`) — never used to re-decide what matched. */
	stored: Anchor[];
	/** One result per `stored` anchor, in the same order (the matcher's own output, unmodified). */
	matches: MatchResult[];
	/** Every candidate extracted from the new text; `matches[i].target` indexes into this. */
	candidates: AnchoredBlock[];
	/** Line ranges already folded live in the editor right now — a target identical to one of
	 * these is left out of both `toFold` and `deferred` (idempotent re-apply). */
	alreadyFolded: readonly LineRange[];
	/** 1-indexed line the cursor (or selection head) currently sits on, or `null` when there is
	 * no meaningful cursor context (e.g. a headless unit test with no live selection). */
	cursorLine: number | null;
	/** Anchor keys (`anchorKey`) present in the fold store right now, read *after* the match
	 * finished — not the snapshot `stored` was taken from (E3/E9: a user fold or unfold during
	 * the settle/match window wins). `null` skips this check (see the file comment). */
	liveAnchorKeys: ReadonlySet<string> | null;
}

export interface RestorePlan {
	toFold: FoldTarget[];
	deferred: FoldTarget[];
}

function isFoldable(range: LineRange): boolean {
	return range.endLine > range.startLine;
}

function sameRange(a: LineRange, b: LineRange): boolean {
	return a.startLine === b.startLine && a.endLine === b.endLine;
}

function cursorInside(range: LineRange, cursorLine: number | null): boolean {
	return cursorLine !== null && cursorLine >= range.startLine && cursorLine <= range.endLine;
}

/**
 * Builds a restore plan from the matcher's own output (see the file comment for exactly which
 * anchors are left out, and why, and the one case — G13 — that's redirected rather than left
 * out). Never throws: an out-of-range `match.target`, an empty `matches`/`candidates`, or a
 * `cursorLine`/`liveAnchorKeys` of `null` are all handled without error.
 */
export function planRestore(input: RestorePlanInput): RestorePlan {
	const toFold: FoldTarget[] = [];
	const deferred: FoldTarget[] = [];

	for (let i = 0; i < input.matches.length; i++) {
		const match = input.matches[i];
		if (match.tier === "none") continue; // F4/G15: the matcher found nothing confident enough

		const candidate = input.candidates[match.target];
		if (!candidate) continue; // defensive: a target outside `candidates` should never happen

		const range = candidate.range;
		if (!isFoldable(range)) continue; // the block is a single line now — nothing to collapse
		if (input.alreadyFolded.some((folded) => sameRange(folded, range))) continue; // idempotent

		if (input.liveAnchorKeys !== null) {
			const stored = input.stored[i];
			if (!stored || !input.liveAnchorKeys.has(anchorKey(stored))) continue; // E3
		}

		const target: FoldTarget = { anchorIndex: i, range };
		if (cursorInside(range, input.cursorLine)) deferred.push(target);
		else toFold.push(target);
	}

	return { toFold, deferred };
}
