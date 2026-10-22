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
 *   reprieve and retried on every reload of that file (PR-6: `src/dormant.ts`, wired from
 *   `src/fold-restorer.ts`). Always present (never undefined) so the on-disk shape never had to
 *   change when PR-6 started populating it. */
export interface FileFoldRecord {
	contentHash: string;
	folds: StoredAnchor[];
	dormant: StoredAnchor[];
}

/** Who owns an embed's fold state: the embed itself, not a path. Persisted as these four
 * structured fields (never as a composite string key), so a path containing `#`, `|`, `/`, `>`,
 * spaces, unicode or quotes can never collide with another embed's identity.
 * - `host`: vault-relative path of the note that contains the embed.
 * - `target`: vault-relative path of the note the embed shows.
 * - `subpath`: block id, heading, or `""` for a whole-note embed.
 * - `occurrence`: 0-based index among identical embeds (same host, target and subpath) in the
 *   host. */
export interface EmbedIdentity {
	host: string;
	target: string;
	subpath: string;
	occurrence: number;
	/** Only for an embed nested inside embedded content (G12): the embeds that contain it, from
	 * the outermost inward, so the key reads host > outer[0] > ... > this embed. `target`,
	 * `subpath` and `occurrence` above then describe the innermost embed, with its occurrence
	 * counted in the text of the embed that contains it. Absent (never an empty array) for an
	 * embed rendered directly in the host, so a flat record is byte-for-byte what it was before
	 * nested embeds were recorded, and an older build ignores the field. */
	outer?: EmbedLinkId[];
}

/** One link of a nested embed's chain: the same three fields an embed key carries besides the
 * host. */
export interface EmbedLinkId {
	target: string;
	subpath: string;
	occurrence: number;
}

/** Per-embed record persisted in the optional `embeds` section of data.json. Same payload as a
 * `FileFoldRecord`, computed over the embedded slice rather than a whole note. */
export interface EmbedFoldRecord extends EmbedIdentity {
	contentHash: string;
	folds: StoredAnchor[];
	dormant: StoredAnchor[];
}

/** The whole on-disk/in-memory shape saved to and loaded from data.json.
 * `embeds` is optional and omitted while there are no embed records, so a file with only notes
 * is byte-for-byte what 0.1.1 wrote. `version` stays 1: an older build reads `version` and
 * `files`, ignores `embeds`, and so keeps every note's folds (dropping only embed state on its
 * next save). */
export interface StoreData {
	version: number;
	files: Record<string, FileFoldRecord>;
	embeds?: EmbedFoldRecord[];
}
