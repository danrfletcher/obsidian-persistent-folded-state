/**
 * The pure embed restore planner (ticket warkworth-21, PR-5, G2, G13, E4). Given the matcher's
 * own decision for an embed's stored folds, the embed's slice blocks, and what the embed's fold
 * arrows show right now, says which arrows to fold and which to unfold so that the embed ends on
 * exactly the stored matched set.
 *
 * Plain data in, plain data out: no Obsidian, DOM, CodeMirror, store, file or timer imports. It
 * never re-decides a match: it walks `matches` in input order and only decides "this block is in
 * the result set or it is not", exactly as `src/restore-plan.ts` does for a note.
 *
 * The result set (the blocks that must end up folded):
 *  - a stored anchor the matcher placed (`tier` is not `none`) on a block that can fold (more than
 *    one line, as `src/restore-plan.ts` requires). A `none` result (no candidate, below threshold,
 *    ambiguous tie, capped) adds nothing, so such a block stays unfolded (rule 4, E2).
 *  - each block is in the set at most once, and the matcher already gives each block to at most
 *    one stored anchor; a second anchor pointing at an already taken block is ignored here too.
 *
 * Stored set against live set (E4, G13: the stored set wins):
 *  - an arrow whose block is in the set and is not collapsed is folded (Obsidian did not restore
 *    it);
 *  - an arrow that is collapsed and whose block is not in the set is unfolded (a stray: Obsidian's
 *    own memory, or a whole-note embed sharing the source's folds). This is also what makes an
 *    embed with no stored state, or an empty stored set, render fully expanded;
 *  - an arrow whose block could not be told (`block` null) is never guessed at and never touched,
 *    whether the set is empty or not (PR-5 R2): the recorder cannot pair it either, so a fold Dan
 *    made on it was not recorded, and undoing it would lose a fold he just made. A collapsed
 *    arrow of that kind stays collapsed even when the stored set says nothing should be folded,
 *    so "the stored set wins" is not strict for it; this is a known limit (README, "Embed folds: known limits");
 *  - an arrow already in the right state is left alone, so a restore that finds the live set equal
 *    to the stored set plans nothing.
 */
import type { AnchoredBlock } from "./anchors";
import type { MatchResult } from "./matcher";

/** One fold arrow of an embed as it is now. `block` is the index of its block in `candidates`
 * (the slice's `buildAnchors` output), or null when the arrow could not be paired with one. */
export interface LiveArrow {
	block: number | null;
	collapsed: boolean;
}

export interface EmbedRestoreInput {
	/** One matcher result per stored anchor, in stored order (the matcher's output, unmodified). */
	matches: readonly MatchResult[];
	/** Every block of the embed's slice; `matches[i].target` indexes into this. */
	candidates: readonly AnchoredBlock[];
	/** The embed's own arrows, in DOM order. */
	arrows: readonly LiveArrow[];
}

export interface EmbedRestorePlan {
	/** Indices into `arrows` to fold, ascending. */
	fold: number[];
	/** Indices into `arrows` to unfold, ascending. */
	unfold: number[];
}

/** The blocks (indices into `candidates`) the stored folds resolve to: the result set. */
export function resolvedBlocks(matches: readonly MatchResult[], candidates: readonly AnchoredBlock[]): Set<number> {
	const blocks = new Set<number>();
	for (const match of matches) {
		if (match.tier === "none") continue;
		const candidate = candidates[match.target];
		if (candidate === undefined) continue; // defensive: a target outside `candidates`
		if (candidate.range.endLine <= candidate.range.startLine) continue; // nothing to collapse
		blocks.add(match.target);
	}
	return blocks;
}

/** Plans the folds and unfolds that bring the embed's arrows to the stored matched set. Never
 * throws; empty inputs plan nothing. */
export function planEmbedRestore(input: EmbedRestoreInput): EmbedRestorePlan {
	const wanted = resolvedBlocks(input.matches, input.candidates);
	const fold: number[] = [];
	const unfold: number[] = [];
	input.arrows.forEach((arrow, i) => {
		if (arrow.block === null) return; // never guessed at, never touched (PR-5 R2)
		const shouldFold = wanted.has(arrow.block);
		if (shouldFold && !arrow.collapsed) fold.push(i);
		else if (!shouldFold && arrow.collapsed) unfold.push(i);
	});
	return { fold, unfold };
}
