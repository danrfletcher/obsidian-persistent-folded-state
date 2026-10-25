/**
 * The pure embed re-match planner (ticket warkworth-21, PR-6, G3, G4, E2, E7). When an embed
 * renders again, this decides where its stored folds now belong in the embed's slice, and what
 * the embed's record should say afterwards. The restorer (src/embed-fold-restorer.ts) gathers
 * the inputs, calls this, and applies the answer through the embed's own arrows.
 *
 * Plain data in, plain data out: no Obsidian, DOM, CodeMirror, store, file or timer imports.
 * The only scheduling it does is awaiting the `yieldToHost` it is handed.
 *
 * Two ways to place the stored folds:
 *  - Same slice (G4): the record's content hash equals the slice's hash and every stored anchor is
 *    found, unchanged, among the slice's blocks. The stored set is re-applied as it is. The
 *    matcher does not run and nothing is written.
 *  - Changed slice (G3): the stored anchors are matched against the blocks built from the new
 *    slice text only (never the whole target note), with `matchAnchors` unchanged: exact
 *    normalized text, then positional (>= POSITIONAL_THRESHOLD), then fuzzy (FUZZY_THRESHOLD_LONG
 *    on lines of SHORT_LONG_SPLIT characters or more, FUZZY_THRESHOLD_SHORT on shorter ones). The
 *    thresholds are the matcher's own exports, passed through explicitly. A tie folds neither
 *    candidate (E2) and each block is taken by at most one anchor, both decided inside the matcher.
 *
 * Caps (E7):
 *  - at most `MAX_FOLDS` (500) stored folds are placed per embed; the rest are kept in the record,
 *    untouched, and not applied;
 *  - at most `MAX_COMPARISONS` (5,000) similarity comparisons per host per render pass, held in
 *    one `HostComparisonBudget` shared by every embed of that host. Each embed is handed what is
 *    left; the comparisons it makes are subtracted afterwards (counted exactly, through the
 *    matcher's own chunk hook, so the matcher itself is not touched). An embed that runs out of
 *    budget gets `budgetExhausted` and no record update: its stored folds are kept as they were.
 *  - comparisons are awaited in chunks of `CHUNK_SIZE`, yielding to the host between chunks, so
 *    typing is never blocked.
 *
 * The record update (`update`) is built only from successful matches: a matched stored anchor is
 * replaced by the anchor of the block it landed on, so a second edit matches against the latest
 * state; an anchor with no confident match is kept exactly as stored (dormancy is PR-7's). A
 * block with no stored fold is never added (G16).
 */
import type { Anchor, AnchoredBlock } from "./anchors";
import { CHUNK_SIZE, FUZZY_THRESHOLD_LONG, FUZZY_THRESHOLD_SHORT, MAX_COMPARISONS, MAX_FOLDS, POSITIONAL_THRESHOLD, SHORT_LONG_SPLIT, matchAnchors } from "./matcher";
import type { MatchResult, MatcherOptions } from "./matcher";

/** The comparisons one host may spend in one render pass, shared by all of its embeds (E7). Also
 * runs the embeds' matching one at a time, so the amount left is read after the previous embed
 * has paid for what it used and 51 embeds cannot each be handed the full 5,000. */
export class HostComparisonBudget {
	private left: number;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(readonly total: number = MAX_COMPARISONS) {
		this.left = Math.max(0, total);
	}

	/** Comparisons still available in this pass. */
	get remaining(): number {
		return this.left;
	}

	/** Subtracts comparisons that were made. Never goes below zero. */
	spend(count: number): void {
		this.left = Math.max(0, this.left - count);
	}

	/** Gives back comparisons spent by work whose result was thrown away (an embed's pass that
	 * started over because its record changed, E3), so that the second go at the same embed does
	 * not take budget meant for its siblings. Never goes above `total`. */
	refund(count: number): void {
		this.left = Math.min(this.total, this.left + Math.max(0, count));
	}

	/** Runs `task` after every earlier `exclusive` task has finished, whether it succeeded or not. */
	exclusive<T>(task: () => Promise<T>): Promise<T> {
		const run = this.tail.then(task, task);
		this.tail = run.catch(() => undefined);
		return run;
	}
}

export interface RematchInput {
	/** The embed's stored folds, parsed, in stored order. */
	stored: readonly Anchor[];
	/** The content hash stored with them; undefined when the record has none. */
	storedHash: string | undefined;
	/** The hash of the slice as it is now. */
	sliceHash: string;
	/** The blocks of the embed's slice (`buildAnchors(sliceText)`), never of the whole target. */
	candidates: readonly AnchoredBlock[];
	/** The host's budget for this render pass. */
	budget: HostComparisonBudget;
	/** Awaited between chunks of comparisons. */
	yieldToHost: () => Promise<void> | void;
	/** Test seam: overrides the matcher's thresholds and caps, and the chunk size and yield hook.
	 * `maxComparisons` is still limited by the host budget. */
	matcherOptions?: MatcherOptions;
}

/** What the embed's record should hold after the re-match. */
export interface RematchUpdate {
	/** The new stored folds, in stored order. */
	folds: Anchor[];
	contentHash: string;
}

export interface RematchOutcome {
	/** One matcher-shaped result per stored anchor, in stored order, for `planEmbedRestore`. */
	matches: MatchResult[];
	/** False when the stored set was re-applied as it was (same slice). */
	usedMatcher: boolean;
	/** Similarity comparisons made, charged to the host budget. */
	comparisons: number;
	/** True when at least one stored anchor was left unplaced because the host budget ran out. */
	budgetExhausted: boolean;
	/** Stored folds beyond the per-embed cap: kept, not applied. */
	foldsOverCap: number;
	/** The record changes to write, or null when there is nothing to write. */
	update: RematchUpdate | null;
}

function sameAnchor(a: Anchor, b: Anchor): boolean {
	if (a.kind !== b.kind || a.indent !== b.indent || a.text !== b.text || a.siblingIndex !== b.siblingIndex) return false;
	if (a.parentChain.length !== b.parentChain.length) return false;
	return a.parentChain.every((ref, i) => ref.kind === b.parentChain[i].kind && ref.text === b.parentChain[i].text);
}

function dedupeKey(anchor: Anchor): string {
	return JSON.stringify([anchor.kind, anchor.indent, anchor.siblingIndex, anchor.text, anchor.parentChain.map((r) => [r.kind, r.text])]);
}

/** Places each of the first `limit` stored anchors on the slice block it is, unchanged; null when
 * any of them is not there (the record and the slice disagree, so the matcher has to decide). */
function placeUnchanged(stored: readonly Anchor[], candidates: readonly AnchoredBlock[], limit: number): MatchResult[] | null {
	const taken = new Set<number>();
	const results: MatchResult[] = [];
	for (let i = 0; i < stored.length; i++) {
		if (i >= limit) {
			results.push({ tier: "none", reason: "capped" });
			continue;
		}
		const at = candidates.findIndex((c, j) => !taken.has(j) && sameAnchor(c.anchor, stored[i]));
		if (at === -1) return null;
		taken.add(at);
		results.push({ tier: "exact", target: at });
	}
	return results;
}

/** The record's folds after the re-match: each placed anchor swapped for its block's current
 * anchor, every other anchor as it was. Null when nothing was placed or nothing changed. */
function buildUpdate(input: RematchInput, matches: readonly MatchResult[]): RematchUpdate | null {
	let placed = 0;
	const seen = new Set<string>();
	const folds: Anchor[] = [];
	input.stored.forEach((anchor, i) => {
		const match = matches[i];
		let next = anchor;
		if (match !== undefined && match.tier !== "none") {
			const block = input.candidates[match.target];
			if (block !== undefined) {
				next = block.anchor;
				placed++;
			}
		}
		const key = dedupeKey(next);
		if (seen.has(key)) return;
		seen.add(key);
		folds.push(next);
	});
	if (placed === 0) return null;
	const unchanged = input.storedHash === input.sliceHash && folds.length === input.stored.length && folds.every((a, i) => sameAnchor(a, input.stored[i]));
	return unchanged ? null : { folds, contentHash: input.sliceHash };
}

/** Re-matches an embed's stored folds against its slice. See the file comment. Never throws on
 * empty input; an empty stored set plans nothing and writes nothing. */
export async function planEmbedRematch(input: RematchInput): Promise<RematchOutcome> {
	const maxFolds = Math.max(0, input.matcherOptions?.maxFolds ?? MAX_FOLDS);
	const foldsOverCap = Math.max(0, input.stored.length - maxFolds);
	if (input.stored.length === 0) {
		return { matches: [], usedMatcher: false, comparisons: 0, budgetExhausted: false, foldsOverCap: 0, update: null };
	}

	if (input.storedHash === input.sliceHash) {
		const unchanged = placeUnchanged(input.stored, input.candidates, maxFolds);
		if (unchanged !== null) {
			return { matches: unchanged, usedMatcher: false, comparisons: 0, budgetExhausted: false, foldsOverCap, update: null };
		}
	}

	const { matches, comparisons } = await input.budget.exclusive(async () => {
		let counted = 0;
		const chunk = Math.max(1, input.matcherOptions?.chunkSize ?? CHUNK_SIZE);
		const yieldToHost = input.matcherOptions?.yieldToHost ?? input.yieldToHost;
		const options: MatcherOptions = {
			positionalThreshold: POSITIONAL_THRESHOLD,
			fuzzyThresholdLong: FUZZY_THRESHOLD_LONG,
			fuzzyThresholdShort: FUZZY_THRESHOLD_SHORT,
			shortLongSplit: SHORT_LONG_SPLIT,
			maxFolds,
			...input.matcherOptions,
			// The matcher calls this once per `chunkSize` comparisons: with a chunk of one it is a
			// meter that counts them exactly. Only every `chunk`-th call really yields.
			chunkSize: 1,
			maxComparisons: Math.min(input.budget.remaining, input.matcherOptions?.maxComparisons ?? MAX_COMPARISONS),
			yieldToHost: async () => {
				counted++;
				input.budget.spend(1);
				if (counted % chunk === 0) await yieldToHost();
			},
		};
		const results = await matchAnchors([...input.stored], input.candidates.map((c) => c.anchor), options);
		return { matches: results, comparisons: counted };
	});

	// A "capped" result among the folds that were processed at all means the budget ran out
	// (anchors past the per-embed cap are "capped" too, but they were never processed).
	let budgetExhausted = false;
	for (let i = 0; i < Math.min(matches.length, maxFolds); i++) {
		const match = matches[i];
		if (match.tier === "none" && match.reason === "capped") budgetExhausted = true;
	}

	return {
		matches,
		usedMatcher: true,
		comparisons,
		budgetExhausted,
		foldsOverCap,
		update: budgetExhausted ? null : buildUpdate(input, matches),
	};
}
