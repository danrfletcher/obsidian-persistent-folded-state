/**
 * Shared on-disk/in-memory shapes for the fold store.
 *
 * PR-1 built the persistence layer: get/set/forget of whole records, debounced and immediate
 * flushing, and load-time sanitisation. `StoredAnchor` was left opaque here on purpose — the
 * *contents* of a fold entry weren't defined yet (that was PR-3's job, `src/anchors.ts`'s
 * `Anchor`). PR-5 is the one that starts actually relying on that shape: `src/fold-store.ts`'s
 * load-time sanitiser now validates every entry against `anchors.ts`'s `parseAnchor`, discarding
 * anything that isn't a real `Anchor` (including a PR-2-era raw-text record). `StoredAnchor`
 * stays `Record<string, unknown>` here regardless — it's the on-disk JSON type, which has no
 * notion of a TypeScript interface anyway — but every entry that actually survives sanitisation
 * from PR-5 onward is a real, valid `Anchor` round-tripped through JSON, not an arbitrary object.
 */

/** A single stored fold. Typed opaquely here (see the file comment above) but, from PR-5
 * onward, validated against `anchors.ts`'s `Anchor` shape on load. Must round-trip through JSON
 * unchanged (a valid `Anchor` survives a load/sanitise/flush cycle byte-for-byte). */
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
