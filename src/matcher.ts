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
 * Scope (G14 nesting, G7 moved blocks): a stored anchor's eligible candidate pool is, by default,
 * every candidate whose full parent chain (kind + normalized text at every ancestor level) is
 * deep-equal to the stored anchor's own parent chain — i.e. "the children of its matched parent",
 * where a parent counts as matched only when its own ancestor chain's text is unchanged end to
 * end. The moment any ancestor's text differs even slightly, that exact-chain pool is empty and
 * the anchor falls back to the *entire* candidate list (G14's "file-wide" fallback) — deliberately
 * all-or-nothing (no partial/fuzzy parent resolution): a parent either still reads the same, or
 * it counts as having no match for scoping purposes. That is also what keeps a block moved to a
 * different (still-matching) parent unclaimed (G7) without this module ever growing a notion of
 * "moved" (F6): the fallback is the *only* out-of-scope search, reached exactly when, and only
 * when, the parent chain stopped reading the same.
 *
 * Within a pool, the three tiers differ only in which candidates are eligible and what threshold
 * applies:
 *  - exact: candidate's normalized text === stored's, same kind (string equality — no
 *    `similarity()` call). Duplicates (several stored anchors sharing one (scope, text)) pair by
 *    order against the candidates sharing that (scope, text), per E1 — not an E2 tie (C20).
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
import type { Anchor } from "./anchors";

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
	 * `chunkSize` comparisons. Defaults to a no-op — a later PR injects the real scheduler. */
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
	// No real host to yield to in a pure module — a later PR injects the real scheduler.
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

/** A deterministic key for an anchor's full ancestor lineage (kind + normalized text at every
 * level) — two anchors sharing this key read as "under the same still-recognizable parent". */
function chainKey(anchor: Anchor): string {
	return JSON.stringify(anchor.parentChain.map((ref) => [ref.kind, ref.text]));
}

/** Full parent-chain text, joined, for the C14/E2 tiebreak: comparing *this* (not either
 * candidate's raw block text again) is what lets a tie be broken only by how ancestry reads,
 * never by re-deciding the text match that was already tied. */
function chainText(anchor: Anchor): string {
	return anchor.parentChain.map((ref) => `${ref.kind}:${ref.text}`).join(" > ");
}

/** Every candidate index eligible for `stored` (G14/G7 scoping, see the file comment):
 * candidates whose full parent chain deep-equals `stored`'s, or — once that set is empty,
 * meaning some ancestor's text no longer matches at all — every candidate in the file. */
function scopeFor(stored: Anchor, candidates: Anchor[]): number[] {
	const key = chainKey(stored);
	const exact: number[] = [];
	for (let i = 0; i < candidates.length; i++) {
		if (chainKey(candidates[i]) === key) exact.push(i);
	}
	if (exact.length > 0) return exact;

	const fileWide: number[] = [];
	for (let i = 0; i < candidates.length; i++) fileWide.push(i);
	return fileWide;
}

interface PendingAnchor {
	/** Index into `stored`. */
	index: number;
	/** Candidate indices eligible for this anchor's scope (before any tier-specific filter). */
	pool: number[];
}
