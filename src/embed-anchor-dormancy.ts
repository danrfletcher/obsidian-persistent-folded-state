/**
 * Dormant folds inside a live embed (ticket warkworth-21, PR-7, G14, G16, E7). When an embed
 * renders and the matcher has no confident place for one of its stored folds (no candidate,
 * below threshold, or a tie), the fold is not lost and not guessed at: it becomes a dormant
 * anchor in the record's `dormant` list, stamped with the time it first went dormant, and its
 * block stays unfolded (G16). On every later render of that embed (the restorer's settled render,
 * E5) the dormant anchors are tried again:
 *  - one that now matches a free block is folded like an active match, through the same arrows,
 *    and moves back to the record's `folds` (G14);
 *  - one that still does not match stays, with its original `dormantSince` (the clock never
 *    restarts: `addDormant` is a no-op for an anchor already dormant);
 *  - one that would have matched a block an active fold already took is dropped: Dan folded
 *    that block himself while its anchor was dormant, and one fold only is kept
 *    (`dropDormantClaimedByActive`);
 *  - one 10 minutes old is forgotten (`freshDormantAnchors`, wall clock, src/dormant.ts).
 *
 * Reuses src/dormant.ts and the embed re-match planner (src/embed-rematch.ts, and through it the
 * matcher with its thresholds and caps) unchanged. Active and dormant anchors go through one
 * matcher call, active first, so a block is taken by at most one of them, as for a note
 * (src/fold-restorer.ts). The dormant retries draw on the same per-host comparison budget as the
 * active re-match and run in the same yielded chunks, so typing is never blocked and nothing is
 * dropped for want of budget or cap (E7): an anchor the matcher did not look at (`capped`) is kept
 * as it was. With the budget exhausted the record is not changed at all.
 *
 * Plain data in, plain data out: no Obsidian, DOM, CodeMirror, store, file or timer imports, and
 * `now` is an argument. Dormancy of a whole embed (the link retargeted or broken) is
 * src/embed-dormant.ts.
 */
import { anchorKey, parseAnchor } from "./anchors";
import type { Anchor, AnchoredBlock } from "./anchors";
import { addDormant, dropDormantClaimedByActive, freshDormantAnchors, splitDormantResults, survivorsStillDormant } from "./dormant";
import { planEmbedRematch } from "./embed-rematch";
import type { HostComparisonBudget } from "./embed-rematch";
import type { MatchResult, MatcherOptions } from "./matcher";
import type { EmbedFoldRecord, StoredAnchor } from "./types";

export interface EmbedPassInput {
	/** The embed's record, or undefined when it has none. */
	record: EmbedFoldRecord | undefined;
	/** The hash of the slice as it is now. */
	sliceHash: string;
	/** The blocks of the embed's slice (`buildAnchors(sliceText)`). */
	candidates: readonly AnchoredBlock[];
	budget: HostComparisonBudget;
	yieldToHost: () => Promise<void> | void;
	matcherOptions?: MatcherOptions;
	/** Wall-clock time (ms). */
	now: number;
}

/** What the record should hold after the pass. */
export interface EmbedPassUpdate {
	folds: StoredAnchor[];
	dormant: StoredAnchor[];
	contentHash: string;
}

export interface EmbedPassOutcome {
	/** One result per active stored fold, then one per fresh dormant anchor (the retry), for
	 * `planEmbedRestore`. A dormant anchor that did not match, or was dropped, is "none". */
	matches: MatchResult[];
	/** True when the host's budget ran out before everything was placed: no update is made. */
	budgetExhausted: boolean;
	/** Comparisons this pass charged to the host budget (both matcher calls), so a caller that
	 * throws the outcome away can refund them. */
	comparisons: number;
	/** The record changes to write, or null when there is nothing to write. */
	update: EmbedPassUpdate | null;
	/** Dormant anchors that matched and moved back to the active set. */
	promoted: number;
	/** Dormant anchors dropped because the user folded the same block meanwhile. */
	droppedClaimed: number;
}

function parseAll(raws: readonly StoredAnchor[]): Anchor[] {
	const anchors: Anchor[] = [];
	for (const raw of raws) {
		const parsed = parseAnchor(raw);
		if (parsed !== null) anchors.push(parsed);
	}
	return anchors;
}

/** The same folds in the same order, by structural identity (a stored anchor and the block's
 * anchor that replaced it may differ only in key order). Anything unparseable differs. */
function sameFolds(a: readonly StoredAnchor[], b: readonly StoredAnchor[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((raw, i) => {
		const left = parseAnchor(raw);
		const right = parseAnchor(b[i]);
		return left !== null && right !== null && anchorKey(left) === anchorKey(right);
	});
}

/**
 * Places an embed's stored folds and retries its dormant anchors against its slice, and says
 * what the record should hold afterwards. See the file comment.
 */
export async function planEmbedPass(input: EmbedPassInput): Promise<EmbedPassOutcome> {
	const { record, candidates } = input;
	const stored = parseAll(record?.folds ?? []);
	const survivors = freshDormantAnchors(record?.dormant ?? [], input.now);
	const common = { sliceHash: input.sliceHash, candidates, budget: input.budget, yieldToHost: input.yieldToHost, matcherOptions: input.matcherOptions };

	// No dormant anchor to retry: the PR-6 planner as it was, plus the no-match -> dormant step.
	// With some, a single matcher call over both (active first) so they cannot share a block.
	const rematch = await planEmbedRematch({
		stored: [...stored, ...survivors.map((s) => s.anchor)],
		storedHash: survivors.length === 0 ? record?.contentHash : undefined,
		...common,
	});
	if (rematch.budgetExhausted) return { matches: rematch.matches, budgetExhausted: true, comparisons: rematch.comparisons, update: null, promoted: 0, droppedClaimed: 0 };

	const activeMatches = rematch.matches.slice(0, stored.length);
	const dormantResults = rematch.matches.slice(stored.length);
	const split = splitDormantResults(survivors, dormantResults);
	let stillDormant = split.stillDormant;
	let droppedClaimed = 0;
	let comparisons = rematch.comparisons;

	// G14: of the dormant anchors with no match, drop those that would have matched a block an
	// active fold took. Asked on their own, with no active fold competing.
	const losers = survivorsStillDormant(survivors, dormantResults);
	const activeTargets = new Set<number>();
	for (const match of activeMatches) if (match.tier !== "none") activeTargets.add(match.target);
	if (losers.length > 0 && activeTargets.size > 0) {
		const solo = await planEmbedRematch({ stored: losers.map((l) => l.anchor), storedHash: undefined, ...common });
		comparisons += solo.comparisons;
		if (!solo.budgetExhausted) {
			const verdict = dropDormantClaimedByActive(losers, solo.matches, activeTargets);
			stillDormant = verdict.kept;
			droppedClaimed = verdict.dropped.length;
		}
	}

	// The new record: placed folds follow their blocks, retried dormant anchors that matched join
	// them, folds with no confident place go dormant (a repeat keeps its stamp), and a fold the
	// matcher never looked at (over the cap) stays exactly as stored.
	const folds = new Map<string, StoredAnchor>();
	let dormant = [...stillDormant];
	const keep = (anchor: Anchor): void => {
		if (!folds.has(anchorKey(anchor))) folds.set(anchorKey(anchor), anchor as unknown as StoredAnchor);
	};
	stored.forEach((anchor, i) => {
		const match = activeMatches[i];
		if (match !== undefined && match.tier !== "none" && candidates[match.target] !== undefined) keep(candidates[match.target].anchor);
		else if (match !== undefined && match.tier === "none" && match.reason !== "capped") dormant = addDormant(dormant, anchor, input.now);
		else keep(anchor);
	});
	for (const matched of split.matched) {
		const block = candidates[matched.candidateIndex];
		if (block !== undefined) keep(block.anchor);
	}

	const next: EmbedPassUpdate = { folds: [...folds.values()], dormant, contentHash: input.sliceHash };
	const unchanged =
		record !== undefined &&
		record.contentHash === next.contentHash &&
		sameFolds(record.folds, next.folds) &&
		JSON.stringify(record.dormant) === JSON.stringify(next.dormant);
	return {
		matches: rematch.matches,
		budgetExhausted: false,
		comparisons,
		// Nothing stored and nothing dormant means nothing to write (E12: no state is created here).
		update: record === undefined || unchanged ? null : next,
		promoted: split.matched.length,
		droppedClaimed,
	};
}
