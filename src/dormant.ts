/**
 * Pure dormant-fold bookkeeping (PR-6, G6). A stored fold the matcher couldn't confidently place
 * on a reload doesn't just vanish (as it silently did before this PR) — it becomes *dormant*:
 * kept for a 10-minute reprieve, retried on every later reload of the same file, and only
 * forgotten once it actually ages out. This module wraps the matcher's own per-anchor decision
 * (src/matcher.ts) rather than changing it — never-break rule 4 ("each stored anchor is consumed
 * by at most one block") still comes from `matchAnchors` itself; this file only decides what
 * happens to an anchor the matcher reports "no match" for, and what happens to one that's
 * already dormant.
 *
 * No Obsidian, CodeMirror, DOM, file or network imports — plain data in, plain data out, same
 * fence discipline as `src/matcher.ts`/`src/restore-plan.ts` (F1/F8/F9). `now` is always an
 * explicit argument (never `Date.now()` read internally), so every rule here — the 600,000ms
 * boundary, "the clock does not restart" — is tested with a fake clock, not a real one.
 *
 * The CM6-level wiring (src/fold-restorer.ts) is the only caller: it reads a file's `dormant`
 * list from the store, calls `retryDormant` against the same candidates it already built for the
 * active-fold restore pass, dispatches a tagged fold effect for every match (through
 * src/restore-plan.ts, exactly like an active-fold match), and persists the result — promoting a
 * match back into the store's `folds` list and demoting the active round's own "no match" result
 * into `dormant` via `addDormant`. src/fold-store.ts is the other caller: it prunes expired
 * entries at load and at flush time (`expireDormant`), per G6's "forgotten ... at plugin load, or
 * when the store is flushed".
 */
import { anchorKey, parseAnchor, type Anchor } from "./anchors";
import { matchAnchors, type MatcherOptions, type MatchResult } from "./matcher";
import type { StoredAnchor } from "./types";

/** G6: a dormant anchor this old (or older) is forgotten outright — never retried again, and
 * never carried forward by `expireDormant`/`retryDormant`, regardless of whether it would have
 * matched this round. */
export const MAX_DORMANT_AGE_MS = 600_000;

export interface DormantAnchor extends Anchor {
	dormantSince: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates and reconstructs a `DormantAnchor` from arbitrary (e.g. freshly-loaded) input.
 * Never throws: anything that isn't a well-formed `Anchor` (see `parseAnchor`), or whose
 * `dormantSince` isn't a finite, non-negative number, is rejected (E8: "a dormant entry with a
 * missing or non-numeric dormantSince ... drop that entry, never throw"). */
export function parseDormantAnchor(value: unknown): DormantAnchor | null {
	const anchor = parseAnchor(value);
	if (anchor === null) return null;
	if (!isPlainObject(value)) return null; // defensive; parseAnchor already guarantees this
	const { dormantSince } = value;
	if (typeof dormantSince !== "number" || !Number.isFinite(dormantSince) || dormantSince < 0) return null;
	return { ...anchor, dormantSince };
}

/** G6 (first transition to dormant): appends `anchor` to `dormant` with `dormantSince: now`,
 * unless an anchor with the same structural identity (`anchorKey`) is already dormant — in
 * which case this is a no-op, so a repeated "no match" for the same anchor across several
 * reloads never resets its own clock ("the clock does not restart"). Never mutates `dormant`;
 * always returns a new array. */
export function addDormant(dormant: readonly StoredAnchor[], anchor: Anchor, now: number): StoredAnchor[] {
	const key = anchorKey(anchor);
	const alreadyDormant = dormant.some((raw) => {
		const parsed = parseAnchor(raw);
		return parsed !== null && anchorKey(parsed) === key;
	});
	if (alreadyDormant) return [...dormant];
	const entry: DormantAnchor = { ...anchor, dormantSince: now };
	return [...dormant, entry as unknown as StoredAnchor];
}

/** G6/E8: `dormant`, with every entry that's either malformed (not a well-formed `Anchor` with a
 * numeric `dormantSince`) or `maxAgeMs` (default `MAX_DORMANT_AGE_MS`) old or older removed.
 * Pure and `now`-driven — called from three places per the ticket plan: a retry (`retryDormant`,
 * below), plugin load and a flush (both src/fold-store.ts). */
export function expireDormant(dormant: readonly StoredAnchor[], now: number, maxAgeMs: number = MAX_DORMANT_AGE_MS): StoredAnchor[] {
	const result: StoredAnchor[] = [];
	for (const raw of dormant) {
		const parsed = parseDormantAnchor(raw);
		if (parsed === null) continue; // E8: malformed or missing dormantSince — forgotten
		if (now - parsed.dormantSince >= maxAgeMs) continue; // G6: aged out — forgotten
		result.push(raw);
	}
	return result;
}

export interface DormantMatch {
	anchor: Anchor;
	/** Index into the `candidates` array `retryDormant` was called with. */
	candidateIndex: number;
}

export interface DormantRetryResult {
	/** Anchors that matched this retry (G6) — the caller folds these through the same tagged CM6
	 * effect as an active match and moves them back to the store's active `folds` list. */
	matched: DormantMatch[];
	/** Everything still dormant after this retry: a below-threshold/ambiguous survivor keeps its
	 * original `dormantSince` untouched (the clock never restarts — G6); an expired or malformed
	 * entry is dropped entirely rather than carried forward. */
	stillDormant: StoredAnchor[];
}

/** One still-fresh (non-expired, well-formed) dormant entry, paired with its parsed anchor. */
export interface DormantSurvivor {
	raw: StoredAnchor;
	anchor: DormantAnchor;
}

/** G6/E8: every entry in `dormant` that is still well-formed and younger than
 * `MAX_DORMANT_AGE_MS` — an already-expired or malformed entry is forgotten outright, never
 * attempted, never returned. Pure and `now`-driven, same discipline as `expireDormant`. Split
 * out of `retryDormant` (R1) so a caller (src/fold-restorer.ts) can fold these survivors' anchors
 * into the *same* `matchAnchors` call as the active-fold pass, rather than running a second,
 * independent call that doesn't know which candidates the active pass already claimed. */
export function freshDormantAnchors(dormant: readonly StoredAnchor[], now: number): DormantSurvivor[] {
	const survivors: DormantSurvivor[] = [];
	for (const raw of dormant) {
		const parsed = parseDormantAnchor(raw);
		if (parsed === null) continue; // E8
		if (now - parsed.dormantSince >= MAX_DORMANT_AGE_MS) continue; // G6: aged out before even trying
		survivors.push({ raw, anchor: parsed });
	}
	return survivors;
}

/** Splits `survivors` into matched/still-dormant given `results` (one `MatchResult` per
 * survivor, in the same order) — the second half of `retryDormant`, usable on its own (R1) when
 * `results` came from a combined `matchAnchors` call rather than one scoped to `survivors` alone. */
export function splitDormantResults(
	survivors: readonly DormantSurvivor[],
	results: readonly MatchResult[],
): DormantRetryResult {
	const matched: DormantMatch[] = [];
	const stillDormant: StoredAnchor[] = [];
	for (let i = 0; i < survivors.length; i++) {
		const result = results[i];
		if (!result || result.tier === "none") {
			stillDormant.push(survivors[i].raw); // original dormantSince preserved verbatim
		} else {
			matched.push({ anchor: survivors[i].anchor, candidateIndex: result.target });
		}
	}
	return { matched, stillDormant };
}

/** G6: retries every still-fresh anchor in `dormant` against `candidates`, in its own
 * `matchAnchors` call. Never throws on an empty `dormant`/`candidates`. Standalone convenience
 * for a caller (and test) that only has dormant anchors to match — src/fold-restorer.ts no
 * longer uses this directly (R1): it needs dormant and active anchors to share one `matchAnchors`
 * call's candidate-claiming, so it calls `freshDormantAnchors`/`splitDormantResults` instead. */
export async function retryDormant(
	dormant: readonly StoredAnchor[],
	candidates: Anchor[],
	now: number,
	options?: MatcherOptions,
): Promise<DormantRetryResult> {
	const survivors = freshDormantAnchors(dormant, now);
	if (survivors.length === 0) return { matched: [], stillDormant: [] };
	const results = await matchAnchors(survivors.map((s) => s.anchor), candidates, options);
	return splitDormantResults(survivors, results);
}
