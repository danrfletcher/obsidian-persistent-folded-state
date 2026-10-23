/**
 * The persistence layer every later PR sits on: an in-memory map of per-file fold records,
 * flushed to Obsidian's own `data.json` (via injected `loadData`/`saveData`, never anything
 * else — F2/F8). Deliberately has no dependency on the "obsidian" package so it's trivial to
 * unit test; it does use `window.setTimeout`/`window.clearTimeout` for the debounce timer
 * (obsidianmd/prefer-window-timers), so it still needs a DOM/`window` to run in.
 *
 * Flush timing (E12): an ordinary change (`set`) is debounced 150ms after the last change, so a
 * burst of edits costs one write, not many. A user-triggered forget (`forget`/`forgetAll`) and
 * the lifecycle hooks (unload, visibilitychange-hidden, pagehide — wired in main.ts) all flush at
 * once instead, since those are exactly the moments a mobile app kill or a disable could otherwise
 * lose the latest state. Overlapping flushes are serialised on a promise chain so the last write
 * always carries the newest state, and a flush with nothing pending never calls `saveData`.
 *
 * PR-6 (G6/E7): a dormant anchor old enough is forgotten "at plugin load, or when the store is
 * flushed" — both pruned here via `expireDormant` (src/dormant.ts), using the injectable `now`
 * option so this stays testable with a fake clock rather than `Date.now()`.
 *
 * PR-7 (G9/G10): `handleRename`/`handleDelete` are the thin wrappers `main.ts`'s own
 * `vault.on("rename"/"delete", ...)` listeners call into; `pruneOrphans` is called once from
 * `onload()` after `load()` (G9's "renamed outside Obsidian: not in v1 — pruned at plugin
 * load"). All three flush at once, same as `forget`/`forgetAll` and for the same reason (E12).
 * The actual re-key/removal/prune logic is pure and lives in `src/vault-lifecycle.ts`; this file
 * only converts between its own `Map` and that module's plain-object shape and handles the
 * dirty/flush bookkeeping.
 *
 * Embeds (ticket warkworth-21, PR-1): a second owner of fold state next to the notes map. Embed
 * records live in an optional `embeds` array in the same data.json (version stays 1), identified
 * by the structured fields host/target/subpath/occurrence and never by a persisted composite key.
 * They share the notes' dirty flag, debounce and flush chain. `handleRename`, `handleDelete` and
 * `pruneOrphans` deliberately leave them alone: those treat keys as file paths and cover the `files`
 * section only. PR-8 adds the embed-aware twins `handleEmbedRename`, `handleEmbedDelete`,
 * `pruneOrphanEmbeds` and `migrateEmbedHeading` (rules in src/embed-lifecycle.ts), which work on
 * the structured host/target fields and never touch `files`. Dormant expiry for them is PR-7 (G6, E6): a record whose embed went
 * away carries `dormantSince` (`reconcileEmbedDormancy`), and `load()` and `flush()` forget it,
 * and any per-anchor dormant entry, once it is 10 minutes old (src/embed-dormant.ts).
 *
 * PR-4 (recording): a nested embed's identity also carries the chain of embeds that contain it
 * (`EmbedIdentity.outer`, see src/types.ts), validated on load and folded into the in-memory key.
 * A flat embed is stored exactly as before.
 */
import type { EmbedFoldRecord, EmbedIdentity, EmbedLinkId, FileFoldRecord, StoreData } from "./types";
import { parseAnchor } from "./anchors";
import { expireDormant, parseDormantAnchor } from "./dormant";
import { expireEmbedRecords, isValidDormantSince, nextEmbedDormancy } from "./embed-dormant";
import type { EmbedPresence } from "./embed-dormant";
import { deleteFiles, pruneOrphanFiles, renameFiles } from "./vault-lifecycle";
import { deleteEmbeds, migrateEmbedHeading, pruneOrphanEmbeds, renameEmbeds } from "./embed-lifecycle";
import type { HeadingMigration } from "./embed-lifecycle";

/** Bumped only if a later PR needs to migrate an incompatible on-disk shape. An unrecognised
 * version is treated the same as a corrupt file (E8): start empty rather than guess. */
export const STORE_VERSION = 1;

export interface FoldStoreOptions {
	/** Obsidian's `Plugin.loadData`, or an equivalent for tests/integration. May resolve to
	 * anything (E8: file absent -> null is the Obsidian convention) or reject; both are handled. */
	loadData: () => Promise<unknown>;
	/** Obsidian's `Plugin.saveData`, or an equivalent for tests/integration. */
	saveData: (data: unknown) => Promise<void>;
	/** Debounce window for `set()`. Defaults to 150ms (E12); overridable only for tests. */
	flushDelayMs?: number;
	/** PR-6 (G6): clock used to prune expired dormant anchors at load and at flush. Defaults to
	 * `Date.now`; overridable so a test can drive dormant expiry with a fake clock. */
	now?: () => number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** PR-5: each entry is validated against PR-3's real `Anchor` shape (`parseAnchor`), not just
 * "is it a plain object" — a PR-2-era raw-text record (`{text, kind, indent}`, no
 * `siblingIndex`/`parentChain`) fails that validation and is discarded here, on load, rather
 * than ever being matched against (the data is per-device and at most a few minutes old, so
 * losing it is an accepted one-time cost of this PR landing). A non-object, a string, a number
 * or `null` entry is dropped the same way `parseAnchor` already rejects any of those. */
function sanitizeAnchorArray(value: unknown): StoredAnchorArray {
	if (!Array.isArray(value)) return [];
	const result: StoredAnchorArray = [];
	for (const entry of value) {
		const anchor = parseAnchor(entry);
		if (anchor !== null) result.push(anchor as unknown as Record<string, unknown>);
	}
	return result;
}

/** PR-6: like `sanitizeAnchorArray`, but for the `dormant` list — each entry must be a
 * well-formed `Anchor` *and* carry a finite, non-negative `dormantSince` (E8: "a dormant entry
 * with a missing or non-numeric dormantSince ... drop that entry, never throw"). Uses
 * `parseDormantAnchor` (src/dormant.ts) so `dormantSince` round-trips rather than being dropped
 * as an "unknown field" the way `parseAnchor` would. */
function sanitizeDormantArray(value: unknown): StoredAnchorArray {
	if (!Array.isArray(value)) return [];
	const result: StoredAnchorArray = [];
	for (const entry of value) {
		const anchor = parseDormantAnchor(entry);
		if (anchor !== null) result.push(anchor as unknown as Record<string, unknown>);
	}
	return result;
}

type StoredAnchorArray = Record<string, unknown>[];

/** In-memory key for an embed's identity. Derived from the structured fields on every call and
 * never persisted (the file stores the fields themselves), so it only has to be collision-free:
 * a JSON array of the four fields (plus the chain of containing embeds, for a nested embed) is,
 * whatever characters the paths contain. Deliberately not
 * exported: the embed key builder that reads identity out of a host's source text is PR-3's. */
function embedMapKey(id: EmbedIdentity): string {
	const flat = [id.host, id.target, id.subpath, id.occurrence];
	if (id.outer === undefined || id.outer.length === 0) return JSON.stringify(flat);
	// A nested embed (PR-4): the chain is part of the identity, so it never collides with a flat
	// embed of the same inner content in the same host.
	return JSON.stringify([...flat, id.outer.map((link) => [link.target, link.subpath, link.occurrence])]);
}

/** The `outer` chain of a nested embed record, `[]` when absent or empty (a flat embed), or null
 * when present but malformed (the record is then dropped rather than read as a flat embed,
 * which would give it the wrong identity). */
function sanitizeOuter(value: unknown): EmbedLinkId[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return null;
	const chain: EmbedLinkId[] = [];
	for (const entry of value) {
		if (!isPlainObject(entry)) return null;
		const { target, subpath, occurrence } = entry;
		if (typeof target !== "string" || target === "" || typeof subpath !== "string") return null;
		if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 0) return null;
		chain.push({ target, subpath, occurrence });
	}
	return chain;
}

/** Validates one raw `embeds` entry. Returns null for anything malformed: not an object; a
 * missing or empty `host`/`target`; a non-string `subpath`; an `occurrence` that is not a
 * non-negative integer; a missing `contentHash`; `folds` not an array; a `dormantSince` that is
 * present but not a finite, non-negative number (PR-7, E8). Inside a valid record, `folds` and
 * `dormant` keep only entries that pass `parseAnchor`/`parseDormantAnchor`. */
function sanitizeEmbedRecord(value: unknown): EmbedFoldRecord | null {
	if (!isPlainObject(value)) return null;
	const { host, target, subpath, occurrence, contentHash, folds, dormant } = value;
	if (typeof host !== "string" || host === "") return null;
	if (typeof target !== "string" || target === "") return null;
	if (typeof subpath !== "string") return null;
	if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 0) return null;
	if (typeof contentHash !== "string") return null;
	if (!Array.isArray(folds)) return null;
	const outer = sanitizeOuter(value.outer);
	if (outer === null) return null;
	// PR-7 (E8): the whole-embed dormancy stamp is optional (a healthy embed has none), but when
	// the field is there it has to be a finite, non-negative number; otherwise the record is
	// dropped on load rather than guessed at.
	const { dormantSince } = value;
	if (dormantSince !== undefined && !isValidDormantSince(dormantSince)) return null;
	return {
		host,
		target,
		subpath,
		occurrence,
		...(outer.length > 0 ? { outer } : {}),
		contentHash,
		folds: sanitizeAnchorArray(folds),
		dormant: sanitizeDormantArray(dormant),
		...(dormantSince !== undefined ? { dormantSince } : {}),
	};
}

/** Sanitises the optional `embeds` section. A missing section, or one that is not an array
 * (object, string, number, null), yields no records. A bad record is dropped on its own and its
 * neighbours survive. Two records with the same identity collapse to one, last wins. Never
 * throws. */
function sanitizeEmbeds(raw: unknown): EmbedFoldRecord[] {
	if (!Array.isArray(raw)) return [];
	const byIdentity = new Map<string, EmbedFoldRecord>();
	for (const entry of raw) {
		const record = sanitizeEmbedRecord(entry);
		if (record !== null) byIdentity.set(embedMapKey(record), record);
	}
	return [...byIdentity.values()];
}

/** Pure sanitiser for whatever `loadData()` resolved to (E8). Never throws: anything that isn't
 * the expected shape — `null`, an array, a string, a number, the wrong `version`, a `files` that
 * isn't an object — yields an empty store. Inside `files`, each record is checked on its own: a
 * record missing `contentHash` or whose `folds` isn't an array is dropped, but its neighbours
 * survive (so one bad entry never costs the whole store). `dormant` defaults to `[]` if missing
 * or malformed; both `folds` and `dormant` keep only the entries inside them that are real,
 * valid `Anchor`s (PR-5; see `sanitizeAnchorArray`), and `dormant` additionally requires a
 * well-formed `dormantSince` on each entry (PR-6; see `sanitizeDormantArray`). The optional
 * `embeds` section is sanitised on its own terms (see `sanitizeEmbeds`) and left out of the result
 * entirely while empty, so a notes-only file sanitises to exactly the shape it always did. This does not
 * prune a dormant entry for being *expired* — that's `FoldStore.load()`'s job (G6), driven by an
 * injectable clock rather than baked into this otherwise clock-free, pure sanitiser. */
export function sanitizeStoreData(raw: unknown): StoreData {
	const empty: StoreData = { version: STORE_VERSION, files: {} };
	if (!isPlainObject(raw)) return empty;
	if (raw.version !== STORE_VERSION) return empty;
	if (!isPlainObject(raw.files)) return empty;

	const files: Record<string, FileFoldRecord> = {};
	for (const [path, value] of Object.entries(raw.files)) {
		if (!isPlainObject(value)) continue;
		if (typeof value.contentHash !== "string") continue;
		if (!Array.isArray(value.folds)) continue;
		files[path] = {
			contentHash: value.contentHash,
			folds: sanitizeAnchorArray(value.folds),
			dormant: sanitizeDormantArray(value.dormant),
		};
	}
	const embeds = sanitizeEmbeds(raw.embeds);
	return embeds.length > 0 ? { version: STORE_VERSION, files, embeds } : { version: STORE_VERSION, files };
}

/** Normalizes line endings so the same text hashes the same regardless of CRLF vs LF, then runs
 * a small, fast, non-cryptographic 64-bit mix (cyrb53-style). This is a content-change detector,
 * not a security primitive — collision resistance against an adversary is not a requirement. */
export function hashText(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n");
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

export class FoldStore {
	private files = new Map<string, FileFoldRecord>();
	/** Embed records by `embedMapKey(identity)`. Untouched by `handleRename`, `handleDelete` and
	 * `pruneOrphans`: those treat keys as file paths. The embed twins (`handleEmbedRename`,
	 * `handleEmbedDelete`, `pruneOrphanEmbeds`, `migrateEmbedHeading`) are what move or remove them. */
	private embeds = new Map<string, EmbedFoldRecord>();
	private dirty = false;
	private flushTimer: number | null = null;
	/** Serialises every flush (scheduled or immediate) so overlapping calls never race: each
	 * write only takes its snapshot once earlier writes have finished, so it always reflects the
	 * freshest in-memory state rather than whatever was current when it was *called*. */
	private flushChain: Promise<void> = Promise.resolve();
	private readonly loadDataFn: () => Promise<unknown>;
	private readonly saveDataFn: (data: unknown) => Promise<void>;
	private readonly flushDelayMs: number;
	private readonly nowFn: () => number;

	constructor(options: FoldStoreOptions) {
		this.loadDataFn = options.loadData;
		this.saveDataFn = options.saveData;
		this.flushDelayMs = options.flushDelayMs ?? 150;
		this.nowFn = options.now ?? Date.now;
	}

	/** E8: populates the in-memory map from `loadData()`, sanitising whatever comes back and
	 * never throwing out of `onload` — a rejecting `loadData()` is caught here too.
	 *
	 * R7 (reviewed, not fixed here): a *rejecting* `loadData()` could mean the underlying file
	 * is just transiently unreadable, not actually corrupt — but this starts empty the same as a
	 * genuinely corrupt file, and the next `set()` then overwrites `data.json`, discarding
	 * whatever was there if the read failure was transient. The spec (E8) mandates "start empty"
	 * for exactly this case, so this is spec-compliant as written. A later PR could reduce the
	 * blast radius by copying the unreadable file aside (e.g. `data.json.corrupt`) before the
	 * first overwrite, so a transient read failure stays recoverable; out of scope for PR-1. */
	async load(): Promise<void> {
		let raw: unknown;
		try {
			raw = await this.loadDataFn();
		} catch {
			raw = undefined;
		}
		const sanitized = sanitizeStoreData(raw);
		const now = this.nowFn();
		const files = new Map<string, FileFoldRecord>();
		for (const [path, record] of Object.entries(sanitized.files)) {
			// G6/E7: "forgotten ... at plugin load" — a dormant anchor aged out while the
			// plugin was disabled (or Obsidian was shut) never comes back as a candidate to
			// retry; a long gap between loads is exactly what's supposed to expire it.
			files.set(path, { ...record, dormant: expireDormant(record.dormant, now) });
		}
		this.files = files;
		// PR-7 (G6, E9): an embed state that stayed dormant for the whole window while the plugin
		// was disabled (or Obsidian was shut) is forgotten here, by the wall clock; one still
		// inside the window keeps its `dormantSince`, so the 10 minutes carry on across a relaunch.
		const loadedEmbeds = sanitized.embeds ?? [];
		const keptEmbeds = expireEmbedRecords(loadedEmbeds, now);
		this.embeds = new Map(keptEmbeds.map((record) => [embedMapKey(record), record]));
		this.dirty = false;
		this.cancelScheduledFlush();
		// T16: what was just forgotten here is still in `data.json` until the store writes again,
		// and an unrelated write may never come: a record dropped (or a per-anchor dormant entry
		// pruned) at load is written out by the ordinary debounce, so the file matches memory.
		if (keptEmbeds.length !== loadedEmbeds.length || keptEmbeds.some((record, i) => record !== loadedEmbeds[i])) {
			this.scheduleDebouncedFlush();
		}
	}

	get(path: string): FileFoldRecord | undefined {
		return this.files.get(path);
	}

	/** Number of notes with a stored record. */
	get size(): number {
		return this.files.size;
	}

	/** Number of embeds with a stored record. */
	get embedSize(): number {
		return this.embeds.size;
	}

	/** The record for the embed with this identity, looked up by its structured fields. */
	getEmbed(id: EmbedIdentity): EmbedFoldRecord | undefined {
		return this.embeds.get(embedMapKey(id));
	}

	/** Every stored embed record, in insertion order. */
	embedRecords(): EmbedFoldRecord[] {
		return [...this.embeds.values()];
	}

	/** Every stored embed record hosted by `host` (an exact path match), in insertion order. */
	embedRecordsForHost(host: string): EmbedFoldRecord[] {
		return [...this.embeds.values()].filter((record) => record.host === host);
	}

	/**
	 * PR-7 (G6, E6): the one dormancy step. Applies `nextEmbedDormancy` (src/embed-dormant.ts) to
	 * every record `host` owns, given how each stands (`presenceOf`, decided by the caller from
	 * the host's source text and the targets, src/embed-dormancy.ts):
	 *  - first seen absent or broken: stamped dormant at the store's `now`, its folds kept;
	 *  - already dormant and seen absent or broken again: left alone, the clock does not restart;
	 *  - dormant and live again inside the window: the stamp is removed, the folds apply as the
	 *    embed renders;
	 *  - dormant for the whole window: forgotten.
	 * Only records that already exist can change (E12), and only the record concerned: no other
	 * embed's record, and nothing in `files`, is read or changed (F2, G8). Nothing is written to
	 * any note (F7). A change is flushed by the ordinary debounce, not at once: it is not a user
	 * action.
	 *
	 * Deliberately a single function that only the render path calls and that a vault `rename`
	 * handler never does: a link Obsidian rewrites itself after a rename or heading rename must
	 * not start the clock, and the later rename and heading-rename migration (PR-8) re-keys the
	 * records instead of going through here.
	 */
	reconcileEmbedDormancy(host: string, presenceOf: (record: EmbedFoldRecord) => EmbedPresence | undefined): { stamped: number; revived: number; forgotten: number } {
		const now = this.nowFn();
		const tally = { stamped: 0, revived: 0, forgotten: 0 };
		for (const [key, record] of [...this.embeds]) {
			if (record.host !== host) continue;
			const presence = presenceOf(record);
			if (presence === undefined) continue; // not assessed: left exactly as it is
			const action = nextEmbedDormancy(record.dormantSince, presence, now);
			if (action.kind === "stamp") {
				this.embeds.set(key, { ...record, dormantSince: action.dormantSince });
				tally.stamped++;
			} else if (action.kind === "revive") {
				const { dormantSince: _stamp, ...live } = record;
				this.embeds.set(key, live);
				tally.revived++;
			} else if (action.kind === "forget") {
				this.embeds.delete(key);
				tally.forgotten++;
			}
		}
		if (tally.stamped + tally.revived + tally.forgotten > 0) this.scheduleDebouncedFlush();
		return tally;
	}

	/** Replaces the whole record for the embed `record` identifies (host, target, subpath and
	 * occurrence, and the chain of containing embeds for a nested one). Debounced like `set()`.
	 * An empty `outer` is dropped, so a flat embed is always stored and written without the field. */
	setEmbed(record: EmbedFoldRecord): void {
		if (record.outer !== undefined && record.outer.length === 0) {
			const { outer: _empty, ...flat } = record;
			record = flat;
		}
		this.embeds.set(embedMapKey(record), record);
		this.scheduleDebouncedFlush();
	}

	/** Removes one embed's record. A miss is a no-op that never reaches `saveData`; a hit
	 * flushes at once, like `forget`. */
	forgetEmbed(id: EmbedIdentity): boolean {
		if (!this.embeds.delete(embedMapKey(id))) return false;
		this.dirty = true;
		this.flushAndLog();
		return true;
	}

	/** Removes every embed record hosted by `host` (an exact path match: records where `host` is
	 * only the *target* are untouched). Flushes once, at once, if anything was removed. Returns
	 * how many records were removed; zero is a no-op that never reaches `saveData`. */
	forgetEmbedsForHost(host: string): number {
		const removed = this.removeEmbedsForHost(host);
		if (removed === 0) return 0;
		this.dirty = true;
		this.flushAndLog();
		return removed;
	}

	/** G15 (command): forgets the note's own record and every embed record it hosts, in one
	 * immediate flush. Nothing found means nothing written. */
	forgetNote(path: string): { note: boolean; embeds: number } {
		const note = this.files.delete(path);
		const embeds = this.removeEmbedsForHost(path);
		if (note || embeds > 0) {
			this.dirty = true;
			this.flushAndLog();
		}
		return { note, embeds };
	}

	private removeEmbedsForHost(host: string): number {
		let removed = 0;
		for (const [key, record] of this.embeds) {
			if (record.host !== host) continue;
			this.embeds.delete(key);
			removed++;
		}
		return removed;
	}

	/** Replaces the whole record for `path`. Schedules a debounced flush (E9/E12) — this is the
	 * hot path for ordinary fold recording in a later PR, so it never writes synchronously.
	 *
	 * Uses `window.setTimeout`/`window.clearTimeout` rather than the bare globals, so a timer
	 * started in one popout window is tracked against that window rather than Obsidian's main
	 * one (obsidianmd/prefer-window-timers). This file otherwise still has no dependency on the
	 * `obsidian` package itself (see the file comment); only this timer call needs `window`. */
	set(path: string, record: FileFoldRecord): void {
		this.files.set(path, record);
		this.scheduleDebouncedFlush();
	}

	/** G12 (command): removes one note's record. Returns whether anything was actually removed;
	 * a miss is a no-op that never reaches `saveData` (nothing changed, nothing written). Flushes
	 * at once — a user-triggered forget should never be lost to a later kill. */
	forget(path: string): boolean {
		if (!this.files.delete(path)) return false;
		this.dirty = true;
		this.flushAndLog();
		return true;
	}

	/** G12/G15 (settings button): empties the notes map *and* the embeds map and flushes at once.
	 * Returns the number of notes that were cleared, for the confirmation Notice (read
	 * `embedSize` beforehand for the embed count). A store holding only embeds is not empty:
	 * it is cleared and flushed, returning 0. A no-op (and no flush) if both are already empty,
	 * for the same reason as `forget`'s miss case. */
	forgetAll(): number {
		const count = this.files.size;
		if (count === 0 && this.embeds.size === 0) return 0;
		this.files.clear();
		this.embeds.clear();
		this.dirty = true;
		this.flushAndLog();
		return count;
	}

	/** G9 (PR-7): re-keys `oldPath` (and, for a folder rename/move, every entry nested beneath
	 * it) to `newPath`, carrying `contentHash` and `dormant` along unchanged — nothing here
	 * re-matches, since the file's own content didn't change, only where it lives. Flushes at
	 * once, same as `forget`/`forgetAll`: a rename arriving while a debounced flush is still
	 * pending for the old key must never let a later write land under that old key (flushing
	 * here, after the in-memory map has already been re-keyed, means even a *stale* pending
	 * timer firing afterwards reads the already-renamed map, not the old key). Returns whether
	 * anything was actually found under `oldPath`; a miss is a no-op that never reaches
	 * `saveData`. */
	handleRename(oldPath: string, newPath: string): boolean {
		if (oldPath === newPath) return false;
		const before = Object.fromEntries(this.files);
		const prefix = `${oldPath}/`;
		if (!(oldPath in before) && !Object.keys(before).some((p) => p.startsWith(prefix))) return false;
		const after = renameFiles(before, oldPath, newPath);
		this.files = new Map(Object.entries(after));
		this.dirty = true;
		this.flushAndLog();
		return true;
	}

	/** G10 (PR-7): removes `path` (and, for a folder delete, every entry nested beneath it).
	 * Flushes at once, for the same reason `forget` does. Returns whether anything was actually
	 * removed; a miss is a no-op that never reaches `saveData`. */
	handleDelete(path: string): boolean {
		const before = Object.fromEntries(this.files);
		const prefix = `${path}/`;
		if (!(path in before) && !Object.keys(before).some((p) => p.startsWith(prefix))) return false;
		const after = deleteFiles(before, path);
		this.files = new Map(Object.entries(after));
		this.dirty = true;
		this.flushAndLog();
		return true;
	}

	/** G9 ("renamed outside Obsidian: not in v1"): called once from `main.ts`'s own `onload()`,
	 * right after `load()`, so an orphan left behind by a rename, move or delete that happened
	 * outside Obsidian (or while it wasn't running) is pruned at the next plugin load rather
	 * than kept forever. `exists` is injected (rather than this file depending on `app.vault`
	 * itself — see the file comment) so this stays testable without a real vault. Flushes at
	 * once if anything was actually pruned; a no-op (and no flush) otherwise. Returns the
	 * number of entries removed. */
	pruneOrphans(exists: (path: string) => boolean): number {
		const before = Object.fromEntries(this.files);
		const after = pruneOrphanFiles(before, exists);
		const removed = Object.keys(before).length - Object.keys(after).length;
		if (removed === 0) return 0;
		this.files = new Map(Object.entries(after));
		this.dirty = true;
		this.flushAndLog();
		return removed;
	}

	/**
	 * PR-8 (G10): the embed twin of `handleRename`. Re-keys every embed record whose host or target
	 * (or a containing embed's target, for a nested one) is `oldPath` or lies beneath it, to
	 * `newPath` (src/embed-lifecycle.ts). Only the `embeds` section is read or changed: the notes'
	 * own `files` entries are `handleRename`'s, so a note-level rename and this one can both run
	 * for one vault event without either touching the other's section (F2). Flushes at once, so a
	 * rename arriving while a debounced flush is pending never lets a later write land under the
	 * old key. Returns whether any record was found; a miss is a no-op that never reaches `saveData`.
	 */
	handleEmbedRename(oldPath: string, newPath: string): boolean {
		return this.replaceEmbeds(renameEmbeds(this.embedRecords(), oldPath, newPath));
	}

	/** PR-8 (G11): the embed twin of `handleDelete`. Removes every embed record whose host or target
	 * (or a containing embed's target) is `path` or lies beneath it. This is removal, not dormancy:
	 * the file is gone. Flushes at once. A miss is a no-op that never reaches `saveData`. */
	handleEmbedDelete(path: string): boolean {
		return this.replaceEmbeds(deleteEmbeds(this.embedRecords(), path));
	}

	/** PR-8 (G10, outside Obsidian): the embed twin of `pruneOrphans`, called from the same
	 * `onLayoutReady` callback in `main.ts`. Drops every embed record whose host or any note in its
	 * chain does not exist. Flushes at once if anything was pruned. Returns the number removed. */
	pruneOrphanEmbeds(exists: (path: string) => boolean): number {
		const before = this.embedRecords();
		const after = pruneOrphanEmbeds(before, exists);
		this.replaceEmbeds(after);
		return before.length - after.length;
	}

	/** PR-8 (G17): moves the embed records of the links `migration` describes to the new heading
	 * (src/embed-lifecycle.ts `migrateEmbedHeading`). Deliberately not routed through
	 * `reconcileEmbedDormancy`: a rename is a migration, so no record is stamped dormant and no
	 * 10-minute timer starts for it. Flushes at once. Returns how many records now sit under a
	 * different key; none means nothing was written. */
	migrateEmbedHeading(migration: HeadingMigration): number {
		const before = this.embedRecords();
		const after = migrateEmbedHeading(before, migration);
		const moved = after.filter((record) => !before.includes(record)).length;
		this.replaceEmbeds(after);
		return moved;
	}

	/** Swaps the embeds map for `after` and flushes at once, but only when it differs from what the
	 * map holds (a record changed, or one was dropped by replacement or removal). Returns whether it did. */
	private replaceEmbeds(after: readonly EmbedFoldRecord[]): boolean {
		const before = this.embedRecords();
		if (after.length === before.length && after.every((record, i) => record === before[i])) return false;
		this.embeds = new Map(after.map((record) => [embedMapKey(record), record]));
		this.dirty = true;
		this.flushAndLog();
		return true;
	}

	/** Immediate flush, bypassing the debounce window. Safe to call even with nothing pending
	 * (writes nothing) and safe to call while another flush is already in flight (serialised). */
	flush(): Promise<void> {
		this.cancelScheduledFlush();
		const task = this.flushChain.then(async () => {
			if (!this.dirty) return;
			// G6: "forgotten ... when the store is flushed" — prune expired dormant anchors
			// out of the in-memory map itself (not just the snapshot) so a later read of
			// `get()` for that path doesn't still see an anchor this same tick just forgot.
			const now = this.nowFn();
			for (const [path, record] of this.files) {
				if (record.dormant.length === 0) continue;
				const pruned = expireDormant(record.dormant, now);
				if (pruned.length !== record.dormant.length) this.files.set(path, { ...record, dormant: pruned });
			}
			// PR-7: the same pruning for the embeds section: an embed state dormant for the
			// whole window is forgotten, and a per-anchor dormant entry (G14) that aged out goes.
			if (this.embeds.size > 0) {
				const before = [...this.embeds.values()];
				const after = expireEmbedRecords(before, now);
				if (after.length !== before.length || after.some((record, i) => record !== before[i])) {
					this.embeds = new Map(after.map((record) => [embedMapKey(record), record]));
				}
			}
			const snapshot: StoreData = {
				version: STORE_VERSION,
				files: Object.fromEntries(this.files),
			};
			// Omitted while empty: a notes-only store writes exactly what 0.1.1 wrote.
			if (this.embeds.size > 0) snapshot.embeds = [...this.embeds.values()];
			this.dirty = false;
			try {
				await this.saveDataFn(snapshot);
			} catch (err) {
				// The write never reached disk: put the store back in a dirty state so the next
				// flush (a lifecycle hook, or a later debounced one) retries it, instead of
				// silently staying "clean" with nothing actually saved (E12). If a newer
				// set()/forget() already re-dirtied the store while this write was in flight,
				// this is a no-op — that newer flush's snapshot already covers this one too,
				// since it reads straight off the same in-memory map.
				this.dirty = true;
				throw err;
			}
		});
		// Keep the chain alive even if this write rejects, so a later flush still gets its turn;
		// the caller's own promise (`task`) still rejects, so the failure isn't swallowed.
		this.flushChain = task.catch(() => undefined);
		return task;
	}

	private scheduleDebouncedFlush(): void {
		this.dirty = true;
		this.cancelScheduledFlush();
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			this.flushAndLog();
		}, this.flushDelayMs);
	}

	private cancelScheduledFlush(): void {
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}

	/** `flush()`, but for call sites that can't await it (a user action, a lifecycle hook) and
	 * would otherwise leave a rejected `flush()` as an unhandled promise rejection. `flush()`
	 * itself has already re-dirtied the store on failure (see above), so the only thing left to
	 * do here is make the failure visible instead of silent. */
	private flushAndLog(): void {
		this.flush().catch((err: unknown) => {
			console.error("persistent-folded-state: flush failed", err);
		});
	}
}
