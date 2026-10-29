/**
 * Finds out which stored embed records have gone away, and reports it to the store (ticket
 * warkworth-21, PR-7, G6, E6, E12). For one host note it reads the host's source text and, for
 * each record the store holds for that host, decides whether the embed is still there:
 *  - `live`: the record's key (target, subpath and occurrence, the chain of containing embeds for a
 *    nested one) is among the embeds found in the text, and its target note and block id or
 *    heading still resolve;
 *  - `absent` (G6): the key is not among the embeds in the text: the link was retargeted or
 *    removed. A deleted target note reads as absent too: the link then no longer resolves to the
 *    stored path;
 *  - `broken` (E6): the key is in the text, but the target note, block id or heading is missing.
 * The store then applies the one dormancy rule (`FoldStore.reconcileEmbedDormancy`,
 * src/embed-dormant.ts). Only records that already exist are looked at, so typing or retargeting
 * a link never creates state (E12), and only the records of this host, so no other embed changes (G8).
 *
 * It is called from the embed restore pass (src/embed-fold-restorer.ts) before the embed is read,
 * so a link that came back is revived before its folds are applied, and on opening a note. It
 * is not called from any vault `rename` handler: a link Obsidian rewrites itself must not start
 * the clock (PR-8 migrates those records instead).
 *
 * Heading links wait before a record goes dormant (PR-8 R1, G17). When Dan renames a heading,
 * Obsidian rewrites the links of an open host and re-renders its embeds before the metadata events
 * that tell the heading-rename tracker (src/embed-heading-rename.ts) it was a rename, and either
 * order is possible. A record whose chain holds a heading link that is seen absent or broken is
 * therefore not stamped until it has been seen so for `HEADING_RENAME_GRACE_MS`, so a rename that
 * migrates the record in that time never makes the old key dormant. `reconcileHost` reports how
 * many records it held back, so the caller can look again once the wait is over. Block and
 * whole-note embeds, and a record already stamped, are not delayed.
 *
 * Reads notes through the injected read-only readers; writes nothing to any note (F7), adds no
 * UI (F1), and does not touch Obsidian's own browser-storage fold state (F10). It starts no timer: the
 * restore pass that calls it already runs on the render-coalescing window (E5).
 */
import { findEmbeds } from "./embed-key";
import { isHeadingSubpath } from "./embed-lifecycle";
import { diagnosticEntry, reportDiagnostic, type DiagnosticSink } from "./diagnostic-log";
import { sliceEmbed } from "./embed-slice";
import type { EmbedPresence } from "./embed-dormant";
import type { EmbedFoldRecord } from "./types";

export interface EmbedDormancyDeps {
	store: {
		embedRecordsForHost(host: string): EmbedFoldRecord[];
		reconcileEmbedDormancy(
			host: string,
			presenceOf: (record: EmbedFoldRecord) => EmbedPresence | undefined,
		): { stamped: number; revived: number; forgotten: number };
	};
	/** The current text of a vault note, or null when it does not exist. Read-only. */
	readNote: (path: string) => Promise<string | null>;
	/** Obsidian's link resolver: link text as written in `sourcePath` to a vault path, or null. */
	resolveLink: (linktext: string, sourcePath: string) => string | null;
	/** Wall clock in ms for the heading wait; defaults to `Date.now`. */
	now?: () => number;
	/** How long a heading-linked record seen absent or broken is left unstamped. Defaults to
	 * `HEADING_RENAME_GRACE_MS`; a test sets 0 to turn the wait off. */
	headingGraceMs?: number;
	/** Warkworth-46 PR-3 (E19): settles whether a note that was read as `""` really is empty on disk
	 * (`vault.adapter.read` is `""` and the stat size is 0). Resolves true only then; rejects when
	 * the disk cannot be read. Optional: without it a `""` read is taken at its word, as before. */
	confirmEmpty?: (path: string) => Promise<boolean>;
	/** Warkworth-46 PR-3: where a refused empty read, or a failed confirming read, logs its one
	 * `embed` line. Optional; fire and forget. */
	diagnosticLog?: DiagnosticSink;
}

/** What `classifyEmbedRecord` reports when it declines to judge a record. */
export interface EmbedReadRefusal {
	outcome: "refused-empty" | "read-failed";
	/** The note whose read was refused. */
	path: string;
}

/** How long a record with a heading link, seen absent or broken, waits for a heading rename to
 * migrate it before it is stamped dormant. Longer than the rename tracker's window for the links
 * and the renamed note to arrive (`PENDING_WINDOW_MS`, 5 s), and the two seconds Obsidian takes to
 * re-parse the renamed note after rewriting the links. */
export const HEADING_RENAME_GRACE_MS = 10_000;

/** Added to the wait before the second look at an opened host, so it is past the wait. */
const OPEN_RECHECK_MARGIN_MS = 500;

/** True when any link in the record's chain names a heading. */
function hasHeadingLink(record: EmbedFoldRecord): boolean {
	return isHeadingSubpath(record.subpath) || (record.outer ?? []).some((link) => isHeadingSubpath(link.subpath));
}

/** A record's identity inside its host: the part of the key that is not the host. */
function recordKey(record: EmbedFoldRecord): string {
	return JSON.stringify([record.target, record.subpath, record.occurrence, (record.outer ?? []).map((l) => [l.target, l.subpath, l.occurrence])]);
}

/**
 * How one stored embed record stands against the host's text and the notes it names. The chain
 * is walked from the host inward: each link must be among the embeds of the text that contains it
 * (the host's source, then each embed's slice), and each target must exist and hold the block or
 * heading. Throws only if a reader does.
 */
export async function classifyEmbedRecord(
	record: EmbedFoldRecord,
	hostText: string,
	deps: Pick<EmbedDormancyDeps, "readNote" | "resolveLink" | "confirmEmpty">,
	reads: Map<string, Promise<string | null>> = new Map(),
	refusals?: EmbedReadRefusal[],
): Promise<EmbedPresence | undefined> {
	const read = (path: string): Promise<string | null> => {
		let hit = reads.get(path);
		if (hit === undefined) {
			hit = deps.readNote(path);
			reads.set(path, hit);
		}
		return hit;
	};
	const chain = [...(record.outer ?? []), { target: record.target, subpath: record.subpath, occurrence: record.occurrence }];
	let text = hostText;
	let source = record.host;
	for (const link of chain) {
		const here = source;
		const present = findEmbeds(here, text, (linktext) => deps.resolveLink(linktext, here)).some(
			(e) => e.target === link.target && e.subpath === link.subpath && e.occurrence === link.occurrence,
		);
		if (!present) return "absent";
		const targetText = await read(link.target);
		if (targetText === null) return "broken";
		// Warkworth-46 PR-3 (E19): a note that reads as "" while its file is not empty is a note
		// that has not loaded, not a broken embed. The record is not judged at all (`undefined`,
		// "not assessed"), so nothing is stamped dormant on the strength of it. A note that is
		// empty on disk too (E6) goes on to `sliceEmbed("")`, `broken`, as it always did.
		if (targetText === "" && deps.confirmEmpty !== undefined) {
			try {
				if (!(await deps.confirmEmpty(link.target))) {
					refusals?.push({ outcome: "refused-empty", path: link.target });
					return undefined;
				}
			} catch {
				refusals?.push({ outcome: "read-failed", path: link.target });
				return undefined;
			}
		}
		const slice = sliceEmbed(targetText, link.subpath);
		if (slice === null) return "broken";
		text = slice.text;
		source = link.target;
	}
	return "live";
}

export class EmbedDormancyTracker {
	private readonly deps: EmbedDormancyDeps;
	private readonly now: () => number;
	private readonly graceMs: number;
	/** When each heading-linked record was first seen absent or broken and not yet stamped, by
	 * host and record key. In memory only: a restart starts the wait again. */
	private readonly firstGone = new Map<string, number>();
	/** The pending second look at each host opened while records were held back. */
	private readonly rechecks = new Map<string, number>();
	private disposed = false;

	constructor(deps: EmbedDormancyDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
		this.graceMs = deps.headingGraceMs ?? HEADING_RENAME_GRACE_MS;
	}

	/**
	 * Brings the dormancy of every record `hostPath` owns up to date with `hostText`. Does nothing
	 * (and reads nothing) when the host has no records. If a reader throws, nothing is changed:
	 * a record is never stamped, revived or forgotten on a guess. Returns how many records were
	 * held back by the heading wait (see the file comment).
	 */
	async reconcileHost(hostPath: string, hostText: string): Promise<{ deferred: number }> {
		const records = this.deps.store.embedRecordsForHost(hostPath);
		if (records.length === 0) return { deferred: 0 };
		// Warkworth-46 PR-3 (E19): a host read as "" while its file is not empty has not loaded; its
		// embeds are not "absent", and nothing is reconciled on the strength of it.
		if (hostText === "" && (await this.hostNotLoaded(hostPath, records))) return { deferred: 0 };
		const presence = new Map<string, EmbedPresence | undefined>();
		const reads = new Map<string, Promise<string | null>>();
		const refusals: EmbedReadRefusal[] = [];
		try {
			for (const record of records) presence.set(recordKey(record), await classifyEmbedRecord(record, hostText, this.deps, reads, refusals));
		} catch (err) {
			console.error("persistent-folded-state: embed dormancy check failed", err);
			return { deferred: 0 };
		}
		this.logRefusals(hostPath, hostText.length, records, refusals);
		const deferred = this.holdHeadingRecords(hostPath, records, presence);
		// A record created while the notes were being read was not assessed: it is left alone.
		this.deps.store.reconcileEmbedDormancy(hostPath, (record) => presence.get(recordKey(record)));
		return { deferred };
	}

	/**
	 * Reconciles a host that was just opened, reading its text itself. When that holds heading-linked
	 * records back, it looks at the host again once the wait is over (`HEADING_RENAME_GRACE_MS` plus
	 * a margin), whether or not any embed of the host renders: a source-mode pane, or a heading
	 * embed deleted while the host was closed, has no embed to trigger the restore pass's own second
	 * look, and the wait is in memory only, so each session's first open starts it again. One look
	 * is pending per host; `dispose()` cancels it. A failure is logged and changes nothing.
	 */
	async reconcileOnOpen(hostPath: string): Promise<void> {
		if (this.disposed) return;
		try {
			const text = await this.deps.readNote(hostPath);
			if (text === null || this.disposed) return;
			const { deferred } = await this.reconcileHost(hostPath, text);
			if (deferred > 0) this.scheduleOpenRecheck(hostPath);
		} catch (err) {
			console.error("persistent-folded-state: embed dormancy on open failed", err);
		}
	}

	/** True when a host that read as `""` is not empty on disk (or cannot be confirmed to be): logs
	 * the one `embed` line for it. False when there is no way to check, or the host is empty. */
	private async hostNotLoaded(hostPath: string, records: EmbedFoldRecord[]): Promise<boolean> {
		const confirm = this.deps.confirmEmpty;
		if (confirm === undefined) return false;
		try {
			if (await confirm(hostPath)) return false;
			this.logRefusals(hostPath, 0, records, [{ outcome: "refused-empty", path: hostPath }]);
		} catch {
			this.logRefusals(hostPath, 0, records, [{ outcome: "read-failed", path: hostPath }]);
		}
		return true;
	}

	/** One `embed` line per outcome, with the host's record counts (the same before and after: a
	 * refusal changes nothing) and no note text. */
	private logRefusals(hostPath: string, editorLen: number, records: EmbedFoldRecord[], refusals: EmbedReadRefusal[]): void {
		const counts = { folds: 0, dormant: 0 };
		for (const record of records) {
			counts.folds += record.folds.length;
			counts.dormant += record.dormant.length;
		}
		for (const outcome of new Set(refusals.map((r) => r.outcome))) {
			reportDiagnostic(
				this.deps.diagnosticLog,
				diagnosticEntry({ path: hostPath, pass: "embed", outcome, editorLen, diskLen: outcome === "refused-empty" ? 0 : -1, before: counts, after: counts }),
			);
		}
	}

	/** Cancels every pending second look; later opens do nothing. */
	dispose(): void {
		this.disposed = true;
		for (const timer of this.rechecks.values()) window.clearTimeout(timer);
		this.rechecks.clear();
	}

	private scheduleOpenRecheck(hostPath: string): void {
		if (this.disposed || this.rechecks.has(hostPath)) return;
		const timer = window.setTimeout(() => {
			this.rechecks.delete(hostPath);
			void this.reconcileOnOpen(hostPath);
		}, this.graceMs + OPEN_RECHECK_MARGIN_MS);
		this.rechecks.set(hostPath, timer);
	}

	/** Marks `undefined` (not assessed) the records the heading wait holds back, and forgets the
	 * wait of every record that is live again, stamped, or gone from the store. */
	private holdHeadingRecords(hostPath: string, records: EmbedFoldRecord[], presence: Map<string, EmbedPresence | undefined>): number {
		const now = this.now();
		const waiting = new Set<string>();
		let deferred = 0;
		for (const record of records) {
			const key = recordKey(record);
			const mapKey = `${hostPath}\u0000${key}`;
			const seen = presence.get(key);
			if (seen === undefined || seen === "live" || record.dormantSince !== undefined || !hasHeadingLink(record)) continue;
			const first = this.firstGone.get(mapKey) ?? now;
			this.firstGone.set(mapKey, first);
			waiting.add(mapKey);
			if (now - first < this.graceMs) {
				presence.set(key, undefined);
				deferred++;
			}
		}
		for (const mapKey of [...this.firstGone.keys()]) {
			if (mapKey.startsWith(`${hostPath}\u0000`) && !waiting.has(mapKey)) this.firstGone.delete(mapKey);
		}
		return deferred;
	}
}
