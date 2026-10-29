/**
 * Pure duplicate cleanup for a stored record (ticket warkworth-46, PR-4, E14). An anchor that is
 * in a record's `folds` list is active; the same anchor in its `dormant` (set-aside) list is a
 * stale second copy, left behind by an older fold recorder. This removes the dormant copy and
 * keeps the active one.
 *
 * No Obsidian, CodeMirror, DOM, file, clock or network imports: plain data in, plain data out,
 * same discipline as `src/dormant.ts`. Duplicates are found by `anchorKey` (the anchor's
 * structural identity), never by comparing raw JSON, so the `dormantSince` stamp on the dormant
 * copy does not hide a duplicate. Age plays no part: a dormant copy that is already past
 * `MAX_DORMANT_AGE_MS` is removed here like any other, and expiry never touches `folds`.
 *
 * Only the overlap with `folds` is removed. Every other dormant entry is carried over as the very
 * same object in the same order, `dormantSince` untouched (G6: the clock never restarts), and
 * that includes entries this module cannot read as an anchor (malformed ones, which the store's
 * sanitiser and `expireDormant` already deal with) and a second copy of a key that is dormant
 * only. Never mutates its input.
 */
import { anchorKey, parseAnchor } from "./anchors";
import type { StoredAnchor } from "./types";

export interface DedupeResult {
	/** `folds`, unchanged (a copy of the same entries in the same order). */
	folds: StoredAnchor[];
	/** `dormant` without the entries whose anchor is also in `folds`. */
	dormant: StoredAnchor[];
	/** How many dormant entries were removed. 0 means nothing changed. */
	removed: number;
}

/** The `anchorKey` of a stored entry, or null when it is not a well-formed anchor. */
function keyOf(raw: StoredAnchor): string | null {
	const anchor = parseAnchor(raw);
	return anchor === null ? null : anchorKey(anchor);
}

/** E14: `dormant` minus every entry whose anchor key is also a key in `folds`. */
export function dedupeFoldsDormant(folds: readonly StoredAnchor[], dormant: readonly StoredAnchor[]): DedupeResult {
	const active = new Set<string>();
	for (const raw of folds) {
		const key = keyOf(raw);
		if (key !== null) active.add(key);
	}
	const kept: StoredAnchor[] = [];
	for (const raw of dormant) {
		const key = keyOf(raw);
		if (key !== null && active.has(key)) continue;
		kept.push(raw);
	}
	return { folds: [...folds], dormant: kept, removed: dormant.length - kept.length };
}
