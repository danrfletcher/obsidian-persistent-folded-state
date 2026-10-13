/**
 * The persistence layer every later PR sits on: an in-memory map of per-file fold records,
 * flushed to Obsidian's own `data.json` (via injected `loadData`/`saveData`, never anything
 * else — F2/F8). Deliberately has no dependency on "obsidian" so it's trivial to unit test and
 * so a later PR can reuse it from a worker if it ever needs to (E6).
 *
 * Flush timing (E12): an ordinary change (`set`) is debounced 150ms after the last change, so a
 * burst of edits costs one write, not many. A user-triggered forget (`forget`/`forgetAll`) and
 * the lifecycle hooks (unload, visibilitychange-hidden, pagehide — wired in main.ts) all flush at
 * once instead, since those are exactly the moments a mobile app kill or a disable could otherwise
 * lose the latest state. Overlapping flushes are serialised on a promise chain so the last write
 * always carries the newest state, and a flush with nothing pending never calls `saveData`.
 */
import type { FileFoldRecord, StoreData } from "./types";

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
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeAnchorArray(value: unknown): StoredAnchorArray {
	if (!Array.isArray(value)) return [];
	return value.filter(isPlainObject);
}

type StoredAnchorArray = Record<string, unknown>[];

/** Pure sanitiser for whatever `loadData()` resolved to (E8). Never throws: anything that isn't
 * the expected shape — `null`, an array, a string, a number, the wrong `version`, a `files` that
 * isn't an object — yields an empty store. Inside `files`, each record is checked on its own: a
 * record missing `contentHash` or whose `folds` isn't an array is dropped, but its neighbours
 * survive (so one bad entry never costs the whole store). `dormant` defaults to `[]` if missing
 * or malformed, since it isn't populated until a later PR. */
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
			dormant: sanitizeAnchorArray(value.dormant),
		};
	}
	return { version: STORE_VERSION, files };
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
	private dirty = false;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	/** Serialises every flush (scheduled or immediate) so overlapping calls never race: each
	 * write only takes its snapshot once earlier writes have finished, so it always reflects the
	 * freshest in-memory state rather than whatever was current when it was *called*. */
	private flushChain: Promise<void> = Promise.resolve();
	private readonly loadDataFn: () => Promise<unknown>;
	private readonly saveDataFn: (data: unknown) => Promise<void>;
	private readonly flushDelayMs: number;

	constructor(options: FoldStoreOptions) {
		this.loadDataFn = options.loadData;
		this.saveDataFn = options.saveData;
		this.flushDelayMs = options.flushDelayMs ?? 150;
	}

	/** E8: populates the in-memory map from `loadData()`, sanitising whatever comes back and
	 * never throwing out of `onload` — a rejecting `loadData()` is caught here too. */
	async load(): Promise<void> {
		let raw: unknown;
		try {
			raw = await this.loadDataFn();
		} catch {
			raw = undefined;
		}
		const sanitized = sanitizeStoreData(raw);
		this.files = new Map(Object.entries(sanitized.files));
		this.dirty = false;
		this.cancelScheduledFlush();
	}

	get(path: string): FileFoldRecord | undefined {
		return this.files.get(path);
	}

	/** Number of notes with a stored record. */
	get size(): number {
		return this.files.size;
	}

	/** Replaces the whole record for `path`. Schedules a debounced flush (E9/E12) — this is the
	 * hot path for ordinary fold recording in a later PR, so it never writes synchronously.
	 *
	 * Uses the global `setTimeout`/`clearTimeout`, not `window.setTimeout`/`window.clearTimeout`:
	 * this file is deliberately obsidian- and DOM-free (see the file comment) so it stays usable
	 * from a worker if a later PR needs that; it has no `window` to call through to in the first
	 * place, and nothing it does is tied to a particular popout window. */
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
		void this.flush();
		return true;
	}

	/** G12 (settings button): empties the whole map and flushes at once. Returns the number of
	 * notes that were cleared, for the confirmation Notice. A no-op (and no flush) if already
	 * empty, for the same reason as `forget`'s miss case. */
	forgetAll(): number {
		const count = this.files.size;
		if (count === 0) return 0;
		this.files.clear();
		this.dirty = true;
		void this.flush();
		return count;
	}

	/** Immediate flush, bypassing the debounce window. Safe to call even with nothing pending
	 * (writes nothing) and safe to call while another flush is already in flight (serialised). */
	flush(): Promise<void> {
		this.cancelScheduledFlush();
		const task = this.flushChain.then(async () => {
			if (!this.dirty) return;
			const snapshot: StoreData = {
				version: STORE_VERSION,
				files: Object.fromEntries(this.files),
			};
			this.dirty = false;
			await this.saveDataFn(snapshot);
		});
		// Keep the chain alive even if this write rejects, so a later flush still gets its turn;
		// the caller's own promise (`task`) still rejects, so the failure isn't swallowed.
		this.flushChain = task.catch(() => undefined);
		return task;
	}

	private scheduleDebouncedFlush(): void {
		this.dirty = true;
		this.cancelScheduledFlush();
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, this.flushDelayMs);
	}

	private cancelScheduledFlush(): void {
		if (this.flushTimer !== null) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
	}
}
