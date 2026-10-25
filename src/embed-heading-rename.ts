/**
 * Notices a heading renamed inside Obsidian and moves the stored embed folds to the new heading
 * (ticket warkworth-21, PR-8, G17). Obsidian rewrites the `![[Note#Heading]]` links to a heading
 * Dan renames; without this, those embeds would look retargeted to PR-7 (their folds dormant for 10
 * minutes, then forgotten). It only reads the metadata cache, through the structural `FileMeta`
 * shape handed to `onChanged`/`seed`, and writes nowhere but the plugin's own store (F7, F10).
 *
 * What it tracks, per note: the headings the note had at the last metadata event (`snapshots`),
 * seeded when a note is opened or when a stored embed's target is known at layout ready, and
 * replaced on every `changed` event. When a note's headings change, the change is kept as a
 * pending rename of that note (the target) for `PENDING_WINDOW_MS`. When a note's cache then shows
 * its links (the note holding the rewritten links, the "source") the tracker asks the one pure rule
 * (`headingRenameSubpath`, src/embed-lifecycle.ts) whether each stored link of that source to that
 * target moved to a new heading; if so it migrates the records through the store. Whether it is a
 * rename or a hand edit is decided only by that rule: a link edited by hand leaves the target's
 * headings as they were, so there is no pending rename, nothing migrates, and the PR-7 retarget
 * path applies.
 *
 * Order: either. Observed in real Obsidian (tests/e2e/embed-rename-delete.e2e.ts, "Rename this
 * heading..."): Obsidian rewrites the links in the other note first, and the target note's own
 * file is written, and re-parsed, about two seconds later. So the `changed` event of the note
 * holding the links can arrive before the target's. The tracker therefore keeps the embed links
 * of each note that holds a stored heading embed (`recentLinks`, for `PENDING_WINDOW_MS`), and
 * when a target's headings then change it runs the same rule over those links. The other order
 * (the target's event first) is handled as the links arrive, through the pending rename. A note
 * that embeds its own heading is both at once and is handled in a single event. In either order
 * it is the one rule that decides whether a link move is a rename.
 *
 * Memory and cost (PR-8 R3, R5): a baseline is kept only for a note that was opened or seeded, or
 * that is the target of a stored heading embed; the other notes a vault re-index reports are not
 * remembered. Which notes those are is an index over the stored records, rebuilt only when the
 * store says its embed records changed (`embedRevision`), so a re-index of many files costs a
 * set lookup each, not a pass over every record.
 *
 * Never throws out of an event handler. No timers of its own: the window is measured with the
 * injected clock when an event arrives.
 */
import { parseEmbedLinktext } from "./embed-key";
import { headingRenameSubpath, isHeadingSubpath } from "./embed-lifecycle";
import type { HeadingEntry, HeadingMigration } from "./embed-lifecycle";
import type { EmbedFoldRecord } from "./types";

/** How long a target's heading change waits for the rewritten links of a linking note. */
export const PENDING_WINDOW_MS = 5000;

/** The part of Obsidian's `CachedMetadata` this module reads. */
export interface FileMeta {
	headings?: readonly { heading: string; level: number }[];
	embeds?: readonly { link: string }[];
}

export interface HeadingRenameDeps {
	store: {
		embedRecords(): EmbedFoldRecord[];
		migrateEmbedHeading(migration: HeadingMigration): number;
		/** Changes whenever the embed records do. Without it the index is rebuilt on every use. */
		embedRevision?(): number;
	};
	/** Obsidian's link resolver: link text as written in `sourcePath` to a vault path, or null. */
	resolveLink: (linktext: string, sourcePath: string) => string | null;
	/** Wall clock in ms; defaults to `Date.now`. */
	now?: () => number;
	/** Called after records were migrated to a new heading. The embeds they belong to may be on
	 * screen already, rendered before the records moved, so the caller looks at them again
	 * (PR-8 R1). A throw is logged by `onChanged` and does not undo the migration. */
	onMigrated?: () => void;
}

interface RecentLinks {
	embeds: readonly { link: string }[];
	at: number;
}

interface PendingRename {
	before: HeadingEntry[];
	after: HeadingEntry[];
	at: number;
}

function toEntries(meta: FileMeta | null | undefined): HeadingEntry[] {
	return (meta?.headings ?? []).map((h) => ({ text: h.heading, level: h.level }));
}

function sameEntries(a: readonly HeadingEntry[], b: readonly HeadingEntry[]): boolean {
	return a.length === b.length && a.every((h, i) => h.text === b[i].text && h.level === b[i].level);
}

/** Every link of a stored record as `[source note, target, subpath]`: the record's own embed last,
 * each containing embed before it. A flat record has one. */
function chainLinks(record: EmbedFoldRecord): { source: string; target: string; subpath: string }[] {
	const links: { source: string; target: string; subpath: string }[] = [];
	let source = record.host;
	for (const link of [...(record.outer ?? []), { target: record.target, subpath: record.subpath }]) {
		links.push({ source, target: link.target, subpath: link.subpath });
		source = link.target;
	}
	return links;
}

/** Every note a record's links name by heading: the targets whose headings are worth a baseline. */
export function headingTargetsOf(record: EmbedFoldRecord): string[] {
	return chainLinks(record)
		.filter((link) => isHeadingSubpath(link.subpath))
		.map((link) => link.target);
}

/** The notes of stored heading links, by role. */
interface HeadingIndex {
	revision: number | null;
	/** Notes named by a stored heading link. */
	targets: Set<string>;
	/** Notes that hold a stored heading link. */
	sources: Set<string>;
}

export class EmbedHeadingRenameTracker {
	private readonly deps: HeadingRenameDeps;
	private readonly now: () => number;
	private readonly snapshots = new Map<string, HeadingEntry[]>();
	private readonly pending = new Map<string, PendingRename>();
	/** The embed links of notes that hold a stored heading embed, as of their last re-parse. Only
	 * read when a target's headings change later; see the file comment on order. */
	private readonly recentLinks = new Map<string, RecentLinks>();
	private index: HeadingIndex | null = null;

	constructor(deps: HeadingRenameDeps) {
		this.deps = deps;
		this.now = deps.now ?? Date.now;
	}

	/** Remembers the headings `path` has now, as the baseline a later change is compared with.
	 * Does nothing when a baseline exists already, and never looks for a rename. */
	seed(path: string, meta: FileMeta | null | undefined): void {
		if (meta === null || meta === undefined || this.snapshots.has(path)) return;
		this.snapshots.set(path, toEntries(meta));
	}

	/** How many notes have a heading baseline. For tests and diagnostics. */
	baselineCount(): number {
		return this.snapshots.size;
	}

	/** Every target of a stored embed link that names a heading: the notes worth a baseline. */
	storedHeadingTargets(): string[] {
		return [...this.headingIndex().targets];
	}

	private headingIndex(): HeadingIndex {
		const revision = this.deps.store.embedRevision?.() ?? null;
		if (this.index !== null && revision !== null && this.index.revision === revision) return this.index;
		const index: HeadingIndex = { revision, targets: new Set(), sources: new Set() };
		for (const record of this.deps.store.embedRecords()) {
			for (const link of chainLinks(record)) {
				if (!isHeadingSubpath(link.subpath)) continue;
				index.targets.add(link.target);
				index.sources.add(link.source);
			}
		}
		this.index = index;
		return index;
	}

	/** Called for every metadata `changed` event: `path` was re-parsed and `meta` is its new cache. */
	onChanged(path: string, meta: FileMeta | null | undefined): void {
		try {
			this.handleChanged(path, meta);
		} catch (err) {
			console.error("persistent-folded-state: heading rename check failed", err);
		}
	}

	/** A note or folder moved: its baselines and pending renames move with it. */
	handleRename(oldPath: string, newPath: string): void {
		for (const map of [this.snapshots, this.pending, this.recentLinks] as Map<string, unknown>[]) {
			for (const [path, value] of [...map]) {
				if (path !== oldPath && !path.startsWith(`${oldPath}/`)) continue;
				map.delete(path);
				map.set(`${newPath}${path.slice(oldPath.length)}`, value);
			}
		}
	}

	/** A note or folder deleted: nothing about it is kept. */
	handleDelete(path: string): void {
		for (const map of [this.snapshots, this.pending, this.recentLinks] as Map<string, unknown>[]) {
			for (const key of [...map.keys()]) if (key === path || key.startsWith(`${path}/`)) map.delete(key);
		}
	}

	private handleChanged(path: string, meta: FileMeta | null | undefined): void {
		const now = this.now();
		const headings = toEntries(meta);
		const previous = this.snapshots.get(path);
		// A note nobody opened and no stored heading embed names gets no baseline: a vault
		// re-index reports every note, and remembering them all would grow with the vault.
		if (previous !== undefined || this.headingIndex().targets.has(path)) this.snapshots.set(path, headings);
		this.rememberLinks(path, meta, now);
		// A change with the same headings (typing in the body) must not replace a pending rename.
		const renamed = previous !== undefined && !sameEntries(previous, headings);
		if (renamed) {
			this.pending.set(path, { before: previous, after: headings, at: now });
		}
		for (const [target, rename] of [...this.pending]) {
			if (now - rename.at > PENDING_WINDOW_MS) this.pending.delete(target);
		}
		for (const [source, links] of [...this.recentLinks]) {
			if (now - links.at > PENDING_WINDOW_MS) this.recentLinks.delete(source);
		}
		if (this.pending.size === 0) return;
		if (meta !== null && meta !== undefined) this.migrateLinksOf(path, meta);
		// The links may have been rewritten before this note's own headings were re-parsed.
		if (renamed) {
			for (const [source, links] of [...this.recentLinks]) {
				if (source !== path) this.migrateLinksOf(source, links);
			}
		}
	}

	/** Keeps the embed links of `source` when it holds a stored heading embed: the rewritten links
	 * of a heading rename can be parsed before the renamed note is. */
	private rememberLinks(source: string, meta: FileMeta | null | undefined, now: number): void {
		const embeds = meta?.embeds ?? [];
		// A heading link is written with a '#', so a note with no such embed link holds none.
		if (!embeds.some((embed) => embed.link.includes("#"))) {
			this.recentLinks.delete(source);
			return;
		}
		const holdsHeadingEmbed = this.headingIndex().sources.has(source);
		if (holdsHeadingEmbed) this.recentLinks.set(source, { embeds, at: now });
		else this.recentLinks.delete(source);
	}

	/** `source` was re-parsed: for each pending target, move the stored links of `source` that the
	 * rule says follow the rename. */
	private migrateLinksOf(source: string, meta: Pick<FileMeta, "embeds">): void {
		const linkSubpaths = new Map<string, string[]>();
		for (const embed of meta.embeds ?? []) {
			const parsed = parseEmbedLinktext(embed.link);
			if (parsed === null) continue;
			const target = parsed.target === "" ? source : this.deps.resolveLink(parsed.target, source);
			if (target === null || !this.pending.has(target)) continue;
			const list = linkSubpaths.get(target) ?? [];
			list.push(parsed.subpath);
			linkSubpaths.set(target, list);
		}
		if (linkSubpaths.size === 0) return;
		const stored = new Map<string, Set<string>>();
		for (const record of this.deps.store.embedRecords()) {
			for (const link of chainLinks(record)) {
				if (link.source !== source || !linkSubpaths.has(link.target) || !isHeadingSubpath(link.subpath)) continue;
				const key = link.target;
				stored.set(key, (stored.get(key) ?? new Set()).add(link.subpath));
			}
		}
		for (const [target, subpaths] of stored) {
			const rename = this.pending.get(target);
			if (rename === undefined) continue;
			for (const from of subpaths) {
				const to = headingRenameSubpath({
					before: rename.before,
					after: rename.after,
					storedSubpath: from,
					linkSubpaths: linkSubpaths.get(target) ?? [],
				});
				if (to === null) continue;
				if (this.deps.store.migrateEmbedHeading({ source, target, from, to }) > 0) this.deps.onMigrated?.();
			}
		}
	}
}
