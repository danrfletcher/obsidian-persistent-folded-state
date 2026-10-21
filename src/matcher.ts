/**
 * The pure anchor matcher (PR-4). Given the anchors `stored` for a file (the user's currently
 * folded blocks) and the `candidates` extracted from the file's new text (every foldable block,
 * via `buildAnchors` — not just the folded ones), decides which candidate (if any) each stored
 * anchor now belongs to. No Obsidian, CodeMirror, DOM, file or network imports — plain data in,
 * plain data out (fence: F1/F8, enforced by tests/unit/matcher-purity.test.ts). This module does
 * not read or write the fold store, and it does not track moved blocks (F6): the only search
 * outside a stored anchor's matched parent is the G14 file-wide fallback, taken only when the
 * parent itself has no match.
 *
 * Tiers run over *all* anchors in turn — every anchor's exact-text attempt first, then every
 * anchor's positional attempt, then every anchor's fuzzy attempt (G4, C9) — so a fuzzy match can
 * never take a candidate that another anchor already claimed exactly or positionally.
 *
 * Scope (G14 nesting, G7 moved blocks): a stored anchor's eligible candidate pool is "the
 * children of its matched parent", where a parent counts as matched when it has a unique match
 * at *any* tier — not only when its text reads identically. Resolving this is recursive and
 * level-by-level (`matchAncestor`/`resolveScopePool`): to find a match for one ancestor
 * (`AnchorParentRef`, which carries only `kind` + normalized `text` — no indent or sibling
 * index, so an ancestor can never use tier 2's siblingIndex-and-indent eligibility test the way a
 * real anchor does), first resolve *its own* parent the same way to get its search pool (every
 * candidate under the already-resolved grandparent, or every candidate file-wide once some
 * ancestor above it has no match), then look for a unique candidate of the same kind in that
 * pool: exact text wins outright with no `similarity()` call; otherwise the unique best-scoring
 * candidate at or above `positionalThreshold` wins (there is no separate "fuzzy" bar for an
 * ancestor — lacking any position signal, every same-kind candidate in its pool is already as
 * eligible as tier 2's "same position" set, so the lower bar is the only one that applies). A tie
 * at an ancestor's own best score resolves to no match for that ancestor, same as elsewhere.
 * Once a parent is resolved to a specific matched candidate, the next level's pool is exactly
 * that candidate's real children (by its *current* kind + text, not the stored anchor's possibly
 * stale memory of it) — so a parent that now reads differently (renamed, or itself found only
 * through a fallback) still scopes its own children correctly. A parent with no match at any
 * tier (renamed past its bar) does not demote its children to an empty pool: each child falls
 * back to the *entire* candidate list (G14's "file-wide" fallback), found only once it is itself
 * unique and above its own bar. That fallback is also what keeps a block moved to a different,
 * still-matching parent unclaimed (G7): the still-matching parent's pool stays scoped to its own
 * real children, so the moved block (now sitting under a different, unrelated parent) is simply
 * never in that pool — without this module ever growing a notion of "moved" (F6). The fallback is
 * the *only* out-of-scope search, reached exactly when, and only when, the immediate parent has
 * no match of its own.
 *
 * Within a pool, the three tiers differ only in which candidates are eligible and what threshold
 * applies:
 *  - exact: candidate's normalized text === stored's, same kind (string equality — no
 *    `similarity()` call). Duplicates (several stored anchors sharing one (scope, text)) pair by
 *    order against the candidates sharing that (scope, text), per E1 — not an E2 tie (C20). This
 *    order-pairing only ever applies within a *real* scope (a true top-level search, or the
 *    children of an actually-matched parent): inside a G14 *fallback* pool (the immediate parent
 *    itself had no match), the exact tier instead requires the match to be unique file-wide —
 *    two or more same-text candidates there are left ambiguous, never paired by order, so
 *    duplicates that happen to sit under two different (both-unresolved) parents never cross-pair
 *    (C18, R8).
 *  - positional: candidate has the same kind, sibling index and indent; score >= 40%.
 *  - fuzzy: candidate has the same kind but *not* the same sibling-index-and-indent pair; score
 *    >= 60% for lines of 20+ characters (the shorter of the two normalized strings), >= 80% for
 *    shorter lines (G4's "shorter text" — the shorter of the *two strings being compared*, not
 *    always the stored one).
 * A tie at the best score (within 1e-9), in either direction (one anchor vs several candidates,
 * or several anchors vs one candidate), folds nothing for the tied parties (E2) *unless* the
 * parent chains' own similarity differs between the tied options, in which case that breaks the
 * tie (C14, E2) — the parent chain only ever separates an *already-tied* match score; it never
 * raises a score or rescues a below-threshold candidate.
 */
import * as similarityModule from "./similarity";
import type { Anchor, AnchorParentRef } from "./anchors";

export type MatchTier = "exact" | "positional" | "fuzzy";
export type NoMatchReason = "no-candidate" | "below-threshold" | "ambiguous" | "capped";

export type MatchResult = { tier: MatchTier; target: number } | { tier: "none"; reason: NoMatchReason };

/** Every threshold and cap named in one place (C3), each overridable through `options` so tests
 * can shrink them to exercise boundary/cap behaviour without huge fixtures. */
export interface MatcherOptions {
	/** G4 Tier 2: minimum similarity for a same-sibling-index-and-indent candidate. */
	positionalThreshold?: number;
	/** G4 Tier 3: minimum similarity for a changed-position candidate, when the *shorter* of the
	 * two normalized strings being compared has `shortLongSplit` characters or more. */
	fuzzyThresholdLong?: number;
	/** G4 Tier 3: minimum similarity for a changed-position candidate, when the shorter of the
	 * two normalized strings has fewer than `shortLongSplit` characters. */
	fuzzyThresholdShort?: number;
	/** The character-count split between the fuzzy tier's two bars, measured on the *shorter* of
	 * the two normalized strings being compared (G4: "shorter text"). */
	shortLongSplit?: number;
	/** E6: at most this many stored anchors are processed per run, in stored order; the rest are
	 * `none / capped` without ever entering a tier. */
	maxFolds?: number;
	/** E6: at most this many `similarity()` calls happen per run, across tiers 2 and 3 only. */
	maxComparisons?: number;
	/** E6: `yieldToHost()` is awaited at least this often, counted in comparisons. */
	chunkSize?: number;
	/** Injected so this stays a pure, timer-free module (F1/F8): awaited at least every
	 * `chunkSize` comparisons. Defaults to a no-op — PR-5's restore pass (src/fold-restorer.ts)
	 * injects the real scheduler (a plain `window.setTimeout`-based yield) when it calls this. */
	yieldToHost?: () => Promise<void> | void;
}

export const POSITIONAL_THRESHOLD = 0.4;
export const FUZZY_THRESHOLD_LONG = 0.6;
export const FUZZY_THRESHOLD_SHORT = 0.8;
export const SHORT_LONG_SPLIT = 20;
export const MAX_FOLDS = 500;
export const MAX_COMPARISONS = 5000;
export const CHUNK_SIZE = 250;

async function defaultYieldToHost(): Promise<void> {
	// No real host to yield to in a pure module — PR-5's restore pass (src/fold-restorer.ts)
	// injects the real one.
}

interface ResolvedOptions {
	positionalThreshold: number;
	fuzzyThresholdLong: number;
	fuzzyThresholdShort: number;
	shortLongSplit: number;
	maxFolds: number;
	maxComparisons: number;
	chunkSize: number;
	yieldToHost: () => Promise<void> | void;
}

function resolveOptions(options: MatcherOptions | undefined): ResolvedOptions {
	return {
		positionalThreshold: options?.positionalThreshold ?? POSITIONAL_THRESHOLD,
		fuzzyThresholdLong: options?.fuzzyThresholdLong ?? FUZZY_THRESHOLD_LONG,
		fuzzyThresholdShort: options?.fuzzyThresholdShort ?? FUZZY_THRESHOLD_SHORT,
		shortLongSplit: options?.shortLongSplit ?? SHORT_LONG_SPLIT,
		maxFolds: options?.maxFolds ?? MAX_FOLDS,
		maxComparisons: options?.maxComparisons ?? MAX_COMPARISONS,
		chunkSize: options?.chunkSize ?? CHUNK_SIZE,
		yieldToHost: options?.yieldToHost ?? defaultYieldToHost,
	};
}

/** Tolerance for "tied" similarity scores (E2: "within 1e-9"). */
const TIE_EPSILON = 1e-9;

function tiedScores(a: number, b: number): boolean {
	return Math.abs(a - b) <= TIE_EPSILON;
}

/** A deterministic key for a full ancestor lineage (kind + normalized text at every level, as a
 * plain array of refs) — two chains sharing this key read as "the same still-recognizable
 * ancestry". Used both for a stored anchor's own (possibly stale) `parentChain` and, in
 * `childrenOf`, for a resolved candidate's *current* chain + itself. */
function chainKeyFromRefs(refs: { kind: string; text: string }[]): string {
	return JSON.stringify(refs.map((ref) => [ref.kind, ref.text]));
}

function chainKey(anchor: Anchor): string {
	return chainKeyFromRefs(anchor.parentChain);
}

/** Full parent-chain text, joined, for the C14/E2 tiebreak: comparing *this* (not either
 * candidate's raw block text again) is what lets a tie be broken only by how ancestry reads,
 * never by re-deciding the text match that was already tied. */
function chainText(anchor: Anchor): string {
	return anchor.parentChain.map((ref) => `${ref.kind}:${ref.text}`).join(" > ");
}

function allCandidateIndices(candidates: Anchor[]): number[] {
	const all: number[] = [];
	for (let i = 0; i < candidates.length; i++) all.push(i);
	return all;
}

/** Every candidate that is a direct child of `parent` — i.e. whose own full parent chain is
 * exactly `parent`'s chain with `parent` itself appended — judged by `parent`'s *current* kind
 * and text (not any stale memory of it), so a parent found only through a rename or a fallback
 * still scopes its own children correctly. */
function childrenOf(parent: Anchor, candidates: Anchor[]): number[] {
	const expectedKey = chainKeyFromRefs([...parent.parentChain, { kind: parent.kind, text: parent.text }]);
	const result: number[] = [];
	for (let i = 0; i < candidates.length; i++) {
		if (chainKey(candidates[i]) === expectedKey) result.push(i);
	}
	return result;
}

/** Resolves one ancestor reference (`ref`) to a unique matching candidate within `pool`, or
 * `null` if none exists (R9). An ancestor has no indent or sibling index of its own (see the
 * file comment), so it skips straight from exact text to a single blended bar
 * (`positionalThreshold`) rather than running separate positional/fuzzy tiers — every same-kind
 * candidate in `pool` is already as eligible as a real anchor's "same position" set would be,
 * since there is no position signal available to narrow it further. R12 (PR-4): its
 * `similarity()` calls go through the run's `ComparisonBudget` like every tier-2/tier-3 call, so
 * they count toward the E6 comparisons cap (and are memoized and chunk-yielded with the rest).
 * An exhausted budget means this ancestor reads as unmatched, which sends its children to the
 * G14 file-wide fallback — the same graceful degradation as any other cap. */
async function resolveAncestorMatch(
	ref: { kind: string; text: string },
	pool: number[],
	candidates: Anchor[],
	opts: ResolvedOptions,
	budget: ComparisonBudget,
): Promise<number | null> {
	const sameKind = pool.filter((i) => candidates[i].kind === ref.kind);

	const exact = sameKind.filter((i) => candidates[i].text === ref.text);
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) return null; // duplicate ancestor text in one pool — ambiguous

	let bestScore = Number.NEGATIVE_INFINITY;
	let bestIdx = -1;
	let tieCount = 0;
	for (const i of sameKind) {
		const score = await budget.score(`a\u0000${ref.kind}\u0000${ref.text}\u0000${i}`, ref.text, candidates[i].text);
		if (score === null) return null; // cap reached: leave this ancestor unresolved
		if (score > bestScore + TIE_EPSILON) {
			bestScore = score;
			bestIdx = i;
			tieCount = 1;
		} else if (tiedScores(score, bestScore)) {
			tieCount++;
		}
	}
	if (bestIdx !== -1 && tieCount === 1 && bestScore >= opts.positionalThreshold) return bestIdx;
	return null;
}

/** Resolves `chain` (an ancestor lineage prefix, outermost first) to the matched candidate for
 * its *last* entry, or `null` if that entry has no match. Recursive and memoized by the chain's
 * own content: resolving `chain[chain.length - 1]` first needs `chain`'s own parent (everything
 * but the last entry) resolved, to know whether to search its children or fall back file-wide. */
async function matchAncestor(
	chain: AnchorParentRef[],
	candidates: Anchor[],
	opts: ResolvedOptions,
	memo: Map<string, number | null>,
	budget: ComparisonBudget,
): Promise<number | null> {
	const key = chainKeyFromRefs(chain);
	const cached = memo.get(key);
	if (cached !== undefined) return cached;

	const parentChain = chain.slice(0, -1);
	const ref = chain[chain.length - 1];
	const pool = await poolFor(parentChain, candidates, opts, memo, budget);
	const result = await resolveAncestorMatch(ref, pool, candidates, opts, budget);

	memo.set(key, result);
	return result;
}

/** The candidate pool a would-be anchor with parent chain `chain` should itself be searched in:
 * file-wide when `chain` is empty (no parent to match or fail) or when `chain`'s own last entry
 * has no match of its own; otherwise the real children of whatever candidate that entry resolved
 * to. */
async function poolFor(
	chain: AnchorParentRef[],
	candidates: Anchor[],
	opts: ResolvedOptions,
	memo: Map<string, number | null>,
	budget: ComparisonBudget,
): Promise<number[]> {
	if (chain.length === 0) return allCandidateIndices(candidates);
	const matched = await matchAncestor(chain, candidates, opts, memo, budget);
	if (matched === null) return allCandidateIndices(candidates);
	return childrenOf(candidates[matched], candidates);
}

/** Every candidate index eligible for `stored` (G14/G7 scoping, see the file comment), plus
 * whether that pool is a real scope or the G14 file-wide fallback (R8: the fallback pool must
 * require a *unique* exact-text match in `runExactTier`, never an order-paired one). A top-level
 * anchor (`parentChain` empty) has no parent to match or fail, so it always searches every
 * candidate — and that is a real (non-fallback) scope, not a fallback one: there is no parent to
 * have failed. */
async function scopeFor(
	stored: Anchor,
	candidates: Anchor[],
	opts: ResolvedOptions,
	memo: Map<string, number | null>,
	budget: ComparisonBudget,
): Promise<{ pool: number[]; fallback: boolean }> {
	if (stored.parentChain.length === 0) return { pool: allCandidateIndices(candidates), fallback: false };

	const matched = await matchAncestor(stored.parentChain, candidates, opts, memo, budget);
	if (matched === null) return { pool: allCandidateIndices(candidates), fallback: true };
	return { pool: childrenOf(candidates[matched], candidates), fallback: false };
}

interface PendingAnchor {
	/** Index into `stored`. */
	index: number;
	/** Candidate indices eligible for this anchor's scope (before any tier-specific filter). */
	pool: number[];
	/** True when `pool` is the G14 file-wide fallback (this anchor's immediate parent has no
	 * match of its own), rather than a real scope — see `runExactTier`'s uniqueness guard (R8). */
	fallback: boolean;
}

/** Tier 1 (G4 exact, E1 duplicates): groups unresolved stored anchors and unconsumed candidates
 * sharing one (scope, normalized text, kind) and pairs them by order: within a group, a stored
 * duplicate is first paired with the candidate duplicate at the *same* `siblingIndex` (an
 * unchanged document pairs up trivially, and — the literal E1 example — "only the 2nd of three
 * folded" is recovered correctly because that stored anchor's own `siblingIndex` already says
 * "2nd", independent of how many *other* duplicates happen to be present in `stored`). Whatever
 * is left on both sides after that (e.g. duplicates removed, shifting the rest down) is then
 * paired by relative rank — both sides sorted by `siblingIndex` ascending and zipped position by
 * position — so a stored anchor past the end of its group's remaining candidates (E1: "fewer
 * duplicates now") is left pending here, never remapped onto a different duplicate and never
 * marked ambiguous — duplicates are E1 pairing, not an E2 tie (C20). No `similarity()` call:
 * exact text is plain string equality. */
function runExactTier(
	pending: PendingAnchor[],
	stored: Anchor[],
	candidates: Anchor[],
	consumed: boolean[],
	results: MatchResult[],
): PendingAnchor[] {
	const groups = new Map<string, { storedIdxs: number[]; candidateIdxs: number[]; fallback: boolean }>();

	for (const p of pending) {
		const anchor = stored[p.index];
		const groupKey = `${chainKey(anchor)}\u0000${anchor.kind}\u0000${anchor.text}`;
		const group = groups.get(groupKey) ?? { storedIdxs: [], candidateIdxs: [], fallback: p.fallback };
		group.storedIdxs.push(p.index);
		if (!groups.has(groupKey)) {
			// Every member of a group shares the same (chainKey, kind, text), so any member's
			// own scope pool finds the same candidate set — computed once per group. Nothing
			// is consumed yet at this point (consumption only happens once every group's pool
			// has been built, below), so every candidate in `p.pool` is still fair game here.
			for (const c of p.pool) {
				const candidate = candidates[c];
				if (candidate.kind === anchor.kind && candidate.text === anchor.text) {
					group.candidateIdxs.push(c);
				}
			}
		}
		groups.set(groupKey, group);
	}

	const resolvedStoredIdx = new Set<number>();
	for (const group of groups.values()) {
		// R8: inside a G14 fallback pool (this group's anchors have no matched parent of their
		// own), the exact tier must claim only a *unique* file-wide match — two or more
		// same-text candidates here are genuinely ambiguous (they may sit under two different,
		// unrelated, both-unresolved parents), never order-paired as if they were true E1
		// duplicates under one real parent (C18).
		if (group.fallback && group.candidateIdxs.length > 1) {
			for (const storedIdx of group.storedIdxs) {
				results[storedIdx] = { tier: "none", reason: "ambiguous" };
				resolvedStoredIdx.add(storedIdx);
			}
			continue;
		}

		const pairs = new Map<number, number>(); // storedIdx -> candidateIdx
		const usedCandidates = new Set<number>();

		for (const storedIdx of group.storedIdxs) {
			const siblingIndex = stored[storedIdx].siblingIndex;
			const direct = group.candidateIdxs.find(
				(c) => !usedCandidates.has(c) && candidates[c].siblingIndex === siblingIndex,
			);
			if (direct !== undefined) {
				pairs.set(storedIdx, direct);
				usedCandidates.add(direct);
			}
		}

		const leftoverStored = group.storedIdxs
			.filter((i) => !pairs.has(i))
			.sort((a, b) => stored[a].siblingIndex - stored[b].siblingIndex);
		const leftoverCandidates = group.candidateIdxs
			.filter((c) => !usedCandidates.has(c))
			.sort((a, b) => candidates[a].siblingIndex - candidates[b].siblingIndex);
		const n = Math.min(leftoverStored.length, leftoverCandidates.length);
		for (let i = 0; i < n; i++) pairs.set(leftoverStored[i], leftoverCandidates[i]);

		for (const [storedIdx, candidateIdx] of pairs) {
			consumed[candidateIdx] = true;
			results[storedIdx] = { tier: "exact", target: candidateIdx };
			resolvedStoredIdx.add(storedIdx);
		}
	}

	return pending.filter((p) => !resolvedStoredIdx.has(p.index));
}

/** Memoized, capped, chunk-yielding source of every `similarity()` score in a run (R12, PR-4):
 * tier 2/3 text scores, ancestor resolution and the parent-chain tiebreak all come through
 * `score`, so the E6 cap and a spy on `similarity` see the same count. Memoized by a caller-built
 * `key` (distinct per kind of comparison) so a pair re-examined across several
 * deferred-acceptance passes is never re-counted. Returns `null` once the cap is reached and the
 * pair has never been scored before; callers must stop offering further candidates to that
 * anchor once they see `null`. `yieldToHost` is awaited each time `chunkSize` fresh calls have
 * accumulated since the last yield, so no stretch of consecutive `similarity()` calls is longer
 * than one chunk. */
class ComparisonBudget {
	private readonly memo = new Map<string, number>();
	private count = 0;
	private sinceYield = 0;
	exhausted: boolean;

	constructor(
		private readonly max: number,
		private readonly chunkSize: number,
		private readonly yieldToHost: () => Promise<void> | void,
	) {
		this.exhausted = max <= 0;
	}

	async score(key: string, textA: string, textB: string): Promise<number | null> {
		const cached = this.memo.get(key);
		if (cached !== undefined) return cached;
		if (this.exhausted) return null;

		const value = similarityModule.similarity(textA, textB);
		this.memo.set(key, value);
		this.count++;
		this.sinceYield++;
		if (this.count >= this.max) this.exhausted = true;
		if (this.sinceYield >= this.chunkSize) {
			this.sinceYield = 0;
			await this.yieldToHost();
		}
		return value;
	}
}

interface ScoredClaim {
	/** Index into `stored`/`results` (not into `pending`/`remaining`). */
	anchorIndex: number;
	candidateIdx: number;
	/** This claimant's own best score against `candidateIdx` — never the parent-chain score. */
	score: number;
}

/** Separates a group of items tied at the best score by comparing each one's own parent-chain
 * text against a fixed chain (E2/C14, both directions — see the file comment): the forward
 * direction fixes the anchor's chain and varies over tied candidates, the reverse direction
 * fixes the candidate's chain and varies over tied claimant anchors. A strictly higher chain
 * similarity (beyond `TIE_EPSILON`) wins outright; if the chain comparison is itself tied, or
 * nothing separates the group, nobody wins (null) — this never raises or invents a text score,
 * it only ever discriminates between options that already tied on one. */
async function breakTieByChain<T>(
	tied: T[],
	chainTextFor: (item: T) => string,
	fixedChainText: string,
	budget: ComparisonBudget,
): Promise<T | null> {
	if (tied.length === 1) return tied[0];

	let bestChainScore = Number.NEGATIVE_INFINITY;
	let winners: T[] = [];
	for (const item of tied) {
		// R12: counted toward the E6 comparisons cap through the run's budget (a tiebreak over
		// already-tied text scores is still a `similarity()` call), and memoized, so the
		// tiebreak re-running on every deferred-acceptance pass costs nothing the second time.
		const itemChainText = chainTextFor(item);
		const chainScore = await budget.score(`c\u0000${fixedChainText}\u0000${itemChainText}`, fixedChainText, itemChainText);
		if (chainScore === null) return null; // cap reached: nothing separates the tie
		if (chainScore > bestChainScore + TIE_EPSILON) {
			bestChainScore = chainScore;
			winners = [item];
		} else if (tiedScores(chainScore, bestChainScore)) {
			winners.push(item);
		}
	}
	return winners.length === 1 ? winners[0] : null;
}

/** Picks the single winner among one or more anchors that all proposed to the same candidate
 * (E2, reverse direction). A clear best text score wins outright; several anchors tied on their
 * own match score are separated by `breakTieByChain` — how well each one's own parent chain
 * reads against the candidate's — and if that is tied too, nobody wins this round. Never used to
 * decide a lone claimant, and never used to compare a lower text score against a higher one —
 * only to break an already-equal text score. */
async function pickWinner(
	claimants: ScoredClaim[],
	stored: Anchor[],
	candidate: Anchor,
	budget: ComparisonBudget,
): Promise<ScoredClaim | null> {
	if (claimants.length === 1) return claimants[0];

	const bestScore = Math.max(...claimants.map((c) => c.score));
	const atBestScore = claimants.filter((c) => tiedScores(c.score, bestScore));
	return breakTieByChain(atBestScore, (claim) => chainText(stored[claim.anchorIndex]), chainText(candidate), budget);
}

/** One deferred-acceptance pass over `remaining`, repeated until no further progress is made:
 * every pending anchor proposes to its own best-scoring eligible, unconsumed candidate; a
 * candidate claimed by exactly one anchor is confirmed; one claimed by several anchors is
 * resolved by `pickWinner`. Anchors that lose a round (their candidate went to someone else, or
 * an unbroken tie left nobody confirmed) retry next round against whatever remains — so losing
 * a contested top choice can still end in a lower-scoring match, never in reusing a consumed
 * candidate. Converges because every pass either confirms at least one match or leaves the
 * state unchanged (which stops the loop), and the confirmed set only grows. */
async function runScoredTier(
	pending: PendingAnchor[],
	stored: Anchor[],
	candidates: Anchor[],
	consumed: boolean[],
	results: MatchResult[],
	reasonHint: Map<number, NoMatchReason>,
	eligibleFor: (anchor: Anchor, pool: number[]) => number[],
	thresholdFor: (anchor: Anchor, candidate: Anchor) => number,
	tier: "positional" | "fuzzy",
	budget: ComparisonBudget,
): Promise<PendingAnchor[]> {
	let remaining = pending;

	while (remaining.length > 0 && !budget.exhausted) {
		const perAnchorScored: { candidateIdx: number; score: number }[][] = [];

		for (const p of remaining) {
			const anchor = stored[p.index];
			const eligible = eligibleFor(anchor, p.pool).filter((c) => !consumed[c]);
			const scored: { candidateIdx: number; score: number }[] = [];
			for (const c of eligible) {
				const candidate = candidates[c];
				const score = await budget.score(`s\u0000${p.index}\u0000${c}`, anchor.text, candidate.text);
				if (score === null) break; // the budget's own exhausted-check, not a redundant pre-check here
				if (score >= thresholdFor(anchor, candidate)) scored.push({ candidateIdx: c, score });
			}
			if (eligible.length > 0 && scored.length === 0 && !reasonHint.has(p.index)) {
				reasonHint.set(p.index, "below-threshold");
			}
			perAnchorScored.push(scored);
		}

		const claims: (ScoredClaim | null)[] = [];
		for (let i = 0; i < remaining.length; i++) {
			const p = remaining[i];
			const scored = perAnchorScored[i];
			if (scored.length === 0) {
				claims.push(null);
				continue;
			}
			const best = Math.max(...scored.map((s) => s.score));
			const atBest = scored.filter((s) => tiedScores(s.score, best));
			if (atBest.length === 1) {
				claims.push({ anchorIndex: p.index, candidateIdx: atBest[0].candidateIdx, score: best });
				continue;
			}
			// E2 forward direction: several candidates tied at this one anchor's own best score.
			// The parent chain (C14/C20) gets one chance to separate them — fixed on the
			// anchor's own chain, varying over the tied candidates — before falling back to
			// ambiguous; it never raises the tied text score, only discriminates between them.
			const winner = await breakTieByChain(
				atBest,
				(s) => chainText(candidates[s.candidateIdx]),
				chainText(stored[p.index]),
				budget,
			);
			if (winner === null) {
				reasonHint.set(p.index, "ambiguous");
				claims.push(null);
				continue;
			}
			claims.push({ anchorIndex: p.index, candidateIdx: winner.candidateIdx, score: best });
		}

		const byCandidate = new Map<number, ScoredClaim[]>();
		for (const claim of claims) {
			if (claim === null) continue;
			const list = byCandidate.get(claim.candidateIdx) ?? [];
			list.push(claim);
			byCandidate.set(claim.candidateIdx, list);
		}

		const confirmed = new Set<number>();
		for (const [candidateIdx, claimants] of byCandidate) {
			const winner = await pickWinner(claimants, stored, candidates[candidateIdx], budget);
			if (winner !== null) {
				consumed[candidateIdx] = true;
				results[winner.anchorIndex] = { tier, target: candidateIdx };
				confirmed.add(winner.anchorIndex);
			} else {
				for (const c of claimants) reasonHint.set(c.anchorIndex, "ambiguous");
			}
		}

		if (confirmed.size === 0) break; // no progress possible — nothing left will converge
		remaining = remaining.filter((p) => !confirmed.has(p.index));
	}

	return remaining;
}

/** G4 Tier 2 eligibility: same kind, sibling index and indent as `anchor` (within its scope
 * pool). Sibling index is counted per-kind by `buildAnchors`, so the kind check matters — two
 * unrelated blocks of different kinds could otherwise coincide on a bare index number. */
function samePositionCandidates(anchor: Anchor, pool: number[], candidates: Anchor[]): number[] {
	return pool.filter((c) => {
		const candidate = candidates[c];
		return (
			candidate.kind === anchor.kind &&
			candidate.siblingIndex === anchor.siblingIndex &&
			candidate.indent === anchor.indent
		);
	});
}

/** G4 Tier 3 eligibility: same kind as `anchor`, but *not* the same sibling-index-and-indent
 * pair (that's Tier 2's territory) — "a block whose sibling index changed", generalized to any
 * positional change so the two tiers partition a scope's same-kind candidates cleanly. */
function changedPositionCandidates(anchor: Anchor, pool: number[], candidates: Anchor[]): number[] {
	return pool.filter((c) => {
		const candidate = candidates[c];
		if (candidate.kind !== anchor.kind) return false;
		return !(candidate.siblingIndex === anchor.siblingIndex && candidate.indent === anchor.indent);
	});
}

/** G4 Tier 3's two bars, chosen by the length of the *shorter* of the two normalized strings
 * being compared (not always the stored anchor's own text) — commented and tested per C8. */
function fuzzyThreshold(anchorText: string, candidateText: string, opts: ResolvedOptions): number {
	const shorterLength = Math.min(anchorText.length, candidateText.length);
	return shorterLength >= opts.shortLongSplit ? opts.fuzzyThresholdLong : opts.fuzzyThresholdShort;
}

/**
 * Matches every anchor in `stored` against `candidates`, returning one result per stored anchor
 * in input order. Never throws, including on empty `stored`, empty `candidates`, or both (C24).
 * See the file comment for the scoping, tiering, ambiguity and cap rules.
 */
export async function matchAnchors(
	stored: Anchor[],
	candidates: Anchor[],
	options?: MatcherOptions,
): Promise<MatchResult[]> {
	const opts = resolveOptions(options);
	const results: MatchResult[] = stored.map((): MatchResult => ({ tier: "none", reason: "no-candidate" }));
	if (stored.length === 0) return results;

	// E6: at most `maxFolds` stored anchors are processed at all, in stored order.
	const cappedCount = Math.min(stored.length, Math.max(0, opts.maxFolds));
	for (let i = cappedCount; i < stored.length; i++) {
		results[i] = { tier: "none", reason: "capped" };
	}
	if (cappedCount === 0) return results;

	const consumed = new Array<boolean>(candidates.length).fill(false);
	const reasonHint = new Map<number, NoMatchReason>();
	const ancestorMemo = new Map<string, number | null>();

	// R12: one budget for the whole run — ancestor resolution, the parent-chain tiebreak and the
	// tier 2/3 scores all draw on the same E6 cap.
	const budget = new ComparisonBudget(opts.maxComparisons, opts.chunkSize, opts.yieldToHost);

	let pending: PendingAnchor[] = [];
	for (let i = 0; i < cappedCount; i++) {
		const scope = await scopeFor(stored[i], candidates, opts, ancestorMemo, budget);
		pending.push({ index: i, pool: scope.pool, fallback: scope.fallback });
	}

	pending = runExactTier(pending, stored, candidates, consumed, results);
	if (pending.length === 0) return results;

	pending = await runScoredTier(
		pending,
		stored,
		candidates,
		consumed,
		results,
		reasonHint,
		(anchor, pool) => samePositionCandidates(anchor, pool, candidates),
		() => opts.positionalThreshold,
		"positional",
		budget,
	);

	if (pending.length > 0 && !budget.exhausted) {
		pending = await runScoredTier(
			pending,
			stored,
			candidates,
			consumed,
			results,
			reasonHint,
			(anchor, pool) => changedPositionCandidates(anchor, pool, candidates),
			(anchor, candidate) => fuzzyThreshold(anchor.text, candidate.text, opts),
			"fuzzy",
			budget,
		);
	}

	for (const p of pending) {
		results[p.index] = budget.exhausted
			? { tier: "none", reason: "capped" }
			: { tier: "none", reason: reasonHint.get(p.index) ?? "no-candidate" };
	}

	return results;
}
