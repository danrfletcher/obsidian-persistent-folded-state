/**
 * Pure whole-embed dormancy rules (ticket warkworth-21, PR-7, G6, E6, E8, F2). When the embed an
 * `embeds` record belongs to goes away, the record is not thrown away at once: it is kept
 * dormant for `MAX_DORMANT_AGE_MS` (10 minutes of wall-clock time, src/dormant.ts) and only then
 * forgotten. Two things make an embed go away:
 *  - `absent` (G6): the host's link was retargeted, so the embed's key no longer appears among
 *    the embeds in the host's source text;
 *  - `broken` (E6): the key is still in the host, but its target note or block id no longer
 *    exists.
 * Both are handled the same way; what differs is only how the caller found out
 * (src/embed-dormancy.ts).
 *
 * A dormant record carries `dormantSince` (the first time the plugin saw it absent or broken).
 * Nothing else in the record changes, so going dormant, coming back and expiring never alter its
 * folds, its per-anchor dormant list or its hash, and never touch any other record (F2, G8).
 *
 * The clock never restarts: a record that is already dormant keeps its `dormantSince` however
 * many times it is seen absent or broken again. When the embed is live again inside the window the
 * stamp is simply removed and the folds apply as the embed renders; once the window has passed
 * the record is forgotten, whether or not the embed has come back, so a late revert starts the
 * embed fully expanded (G13).
 *
 * Plain data in, plain data out: no Obsidian, DOM, store, file or timer imports, and `now` is
 * always an argument, so the 600,000 ms boundary is tested with a fake clock. Dormancy of an
 * individual fold inside a live embed (G14) is src/embed-anchor-dormancy.ts.
 */
import { MAX_DORMANT_AGE_MS, expireDormant } from "./dormant";
import type { EmbedFoldRecord } from "./types";

/** How a stored embed record stands against what the plugin can see now. */
export type EmbedPresence =
	/** Its key is in the host and its target and block id resolve. */
	| "live"
	/** Its key is not among the embeds of the host's source text (retargeted or removed). */
	| "absent"
	/** Its key is in the host, but the target note or block id (or heading) is missing. */
	| "broken";

/** What to do with one record. */
export type EmbedDormancyAction =
	| { kind: "keep" }
	/** First sighting of the record absent or broken: set `dormantSince` to `now`. */
	| { kind: "stamp"; dormantSince: number }
	/** Live again inside the window: remove `dormantSince`. */
	| { kind: "revive" }
	/** Dormant for the whole window: forget the record. */
	| { kind: "forget" };

/** True for a number a `dormantSince` may hold: finite and not negative. */
export function isValidDormantSince(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** True once a record dormant since `dormantSince` has been dormant for the full window: 599,999
 * ms is not yet, 600,000 ms is. */
export function isEmbedDormancyExpired(dormantSince: number, now: number): boolean {
	return now - dormantSince >= MAX_DORMANT_AGE_MS;
}

/**
 * The one rule for a record seen as `presence` at `now`, given its current `dormantSince`
 * (undefined when healthy). This is the single dormancy step: the store applies it to a host's
 * records (`FoldStore.reconcileEmbedDormancy`), and nothing else ever sets or clears the stamp.
 *  - already dormant and the window is over: forget, whatever `presence` is;
 *  - not dormant and seen absent or broken: stamp `now`;
 *  - dormant and seen absent or broken again: keep (the clock does not restart);
 *  - dormant and live inside the window: revive;
 *  - healthy and live: keep.
 */
export function nextEmbedDormancy(dormantSince: number | undefined, presence: EmbedPresence, now: number): EmbedDormancyAction {
	if (dormantSince !== undefined && isEmbedDormancyExpired(dormantSince, now)) return { kind: "forget" };
	if (presence === "live") return dormantSince === undefined ? { kind: "keep" } : { kind: "revive" };
	return dormantSince === undefined ? { kind: "stamp", dormantSince: now } : { kind: "keep" };
}

/**
 * `records` as they stand at `now`: a record whose whole-embed window is over is forgotten, and
 * inside every kept record the per-anchor `dormant` list (G14) is pruned with `expireDormant`.
 * Used by the store at load and at flush (G6, E9). Returns the same array contents untouched when
 * nothing expired, record objects included; a pruned record is a new object. Never mutates its
 * input.
 */
export function expireEmbedRecords(records: readonly EmbedFoldRecord[], now: number): EmbedFoldRecord[] {
	const kept: EmbedFoldRecord[] = [];
	for (const record of records) {
		if (record.dormantSince !== undefined && isEmbedDormancyExpired(record.dormantSince, now)) continue;
		const dormant = expireDormant(record.dormant, now);
		kept.push(dormant.length === record.dormant.length ? record : { ...record, dormant });
	}
	return kept;
}
