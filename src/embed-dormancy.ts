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
 * Reads notes through the injected read-only readers; writes nothing to any note (F7), adds no
 * UI (F1), and does not touch Obsidian's own browser-storage fold state (F10). It starts no timer: the
 * restore pass that calls it already runs on the render-coalescing window (E5).
 */
import { findEmbeds } from "./embed-key";
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
	deps: Pick<EmbedDormancyDeps, "readNote" | "resolveLink">,
	reads: Map<string, Promise<string | null>> = new Map(),
): Promise<EmbedPresence> {
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
		const slice = sliceEmbed(targetText, link.subpath);
		if (slice === null) return "broken";
		text = slice.text;
		source = link.target;
	}
	return "live";
}

export class EmbedDormancyTracker {
	private readonly deps: EmbedDormancyDeps;

	constructor(deps: EmbedDormancyDeps) {
		this.deps = deps;
	}

	/**
	 * Brings the dormancy of every record `hostPath` owns up to date with `hostText`. Does nothing
	 * (and reads nothing) when the host has no records. If a reader throws, nothing is changed:
	 * a record is never stamped, revived or forgotten on a guess.
	 */
	async reconcileHost(hostPath: string, hostText: string): Promise<void> {
		const records = this.deps.store.embedRecordsForHost(hostPath);
		if (records.length === 0) return;
		const presence = new Map<string, EmbedPresence>();
		const reads = new Map<string, Promise<string | null>>();
		try {
			for (const record of records) presence.set(recordKey(record), await classifyEmbedRecord(record, hostText, this.deps, reads));
		} catch (err) {
			console.error("persistent-folded-state: embed dormancy check failed", err);
			return;
		}
		// A record created while the notes were being read was not assessed: it is left alone.
		this.deps.store.reconcileEmbedDormancy(hostPath, (record) => presence.get(recordKey(record)));
	}
}
