/**
 * Shared on-disk/in-memory shapes for the fold store.
 *
 * This PR (PR-1) only builds the persistence layer: get/set/forget of whole records, debounced
 * and immediate flushing, and load-time sanitisation. The *contents* of a fold entry (its anchor:
 * kind, indent level, normalized text, sibling index, parent chain) are defined by a later PR
 * (the anchor and matcher module). Until then every fold entry is treated as an opaque, JSON-safe
 * object: this file only fixes the shape of the *record* and *store*, not what's inside a fold.
 */

/** A single stored fold. Opaque here on purpose — see the file comment above. Must round-trip
 * through JSON unchanged (whatever a later PR puts in survives a load/sanitise/flush cycle). */
export type StoredAnchor = Record<string, unknown>;

/** Per-file record persisted in data.json, keyed by vault-relative path.
 * - `contentHash`: hash of the last-seen text for this file (see `hashText` in fold-store.ts),
 *   used by a later PR to detect a non-user change and decide whether anchors need re-matching.
 * - `folds`: the user's confirmed, currently-applied folds.
 * - `dormant`: anchors that found no confident match on a reload (G6), kept for a 10-minute
 *   reprieve and retried on every reload of that file. Always present (never undefined) so the
 *   on-disk shape doesn't change when a later PR starts populating it. */
export interface FileFoldRecord {
	contentHash: string;
	folds: StoredAnchor[];
	dormant: StoredAnchor[];
}

/** The whole on-disk/in-memory shape saved to and loaded from data.json. */
export interface StoreData {
	version: number;
	files: Record<string, FileFoldRecord>;
}
