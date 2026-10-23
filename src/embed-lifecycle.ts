/**
 * Pure vault-lifecycle bookkeeping for embed records (ticket warkworth-21, PR-8, G10, G11, G17,
 * E15). The embed twin of `src/vault-lifecycle.ts`: that module treats the keys of the `files`
 * section as file paths; an embed record is identified by structured fields (host, target,
 * subpath, occurrence, and for a nested embed the chain of containing embeds), so it needs its own
 * rules. Plain data in, plain data out: no Obsidian, CodeMirror, DOM, file or network import, no
 * timer, no clock. Inputs are never mutated; a record a rule does not touch is returned as the very
 * same object, so a caller can tell "nothing changed" by comparing references.
 *
 * Nothing here reads or writes a note, and nothing here looks at the `files` section: an embed
 * record is moved or removed on its own terms, whatever happens to the source note's own entry (F2).
 *
 * G10 (`renameEmbeds`): a path that is renamed or moved, or a folder that is renamed or moved,
 * re-keys every record whose host, target or any containing embed's target lies at or beneath it.
 * Matching is on a full path segment (`Projects/Quarry` does not match `Projects/Quarry2024`). The
 * subpath, occurrence index (E15), folds, content hash, dormant anchors and dormancy stamp are
 * carried over unchanged. A record that lands on the key of an existing record replaces it, and the
 * old key never survives. A miss is a no-op.
 *
 * G11 (`deleteEmbeds`): a path or folder that is deleted removes every record whose host, target or
 * any containing embed's target lies at or beneath it. This is removal, not the dormant retention
 * (G6, E6): that is for a target or block id that is gone while the file is still there.
 *
 * G10, outside Obsidian (`pruneOrphanEmbeds`): run once at plugin load. Keeps a record only when
 * its host and every note in its chain still exist.
 *
 * G17 (`headingRenameSubpath`, `migrateEmbedHeading`): when Dan renames a heading in Obsidian and
 * Obsidian rewrites the `![[Note#Heading]]` links to it, the records of those links follow the new
 * heading. Only a heading subpath moves; a block embed (`^id`) or a whole-note embed (empty
 * subpath) is never changed here (a whole-note embed's slice changes with the rename and its folds
 * are re-matched by the existing matcher, with no key change).
 */
import type { EmbedFoldRecord, EmbedLinkId } from "./types";

/** `path` re-based from `oldPath` to `newPath` when it is `oldPath` itself or lies beneath it (a
 * full path-segment prefix, so a sibling that merely starts with the same characters does not
 * match); otherwise `path` unchanged. */
export function remapPath(path: string, oldPath: string, newPath: string): string {
	if (oldPath === "") return path;
	if (path === oldPath) return newPath;
	if (path.startsWith(`${oldPath}/`)) return `${newPath}${path.slice(oldPath.length)}`;
	return path;
}

/** True when `path` is `root` or lies beneath it (a full path-segment prefix). */
export function isWithinPath(path: string, root: string): boolean {
	return root !== "" && (path === root || path.startsWith(`${root}/`));
}

/** The whole identity of a record as one comparable string: JSON of every identifying field, so
 * no path or subpath, whatever characters it holds, can make two different records equal. */
function identityOf(record: EmbedFoldRecord): string {
	return JSON.stringify([
		record.host,
		record.target,
		record.subpath,
		record.occurrence,
		(record.outer ?? []).map((link) => [link.target, link.subpath, link.occurrence]),
	]);
}

/** Every note a record depends on besides its host: the targets of the containing embeds, then its
 * own target. */
function dependencies(record: EmbedFoldRecord): string[] {
	return [...(record.outer ?? []).map((link) => link.target), record.target];
}

/** True when at least one record has `path` (or a path beneath it) as its host or as the target of
 * its own embed or of any containing embed. Lets a caller tell a miss without rebuilding anything. */
export function embedsTouchPath(embeds: readonly EmbedFoldRecord[], path: string): boolean {
	return embeds.some((record) => isWithinPath(record.host, path) || dependencies(record).some((p) => isWithinPath(p, path)));
}

/**
 * Applies a per-record rewrite and settles key collisions. `rewrite` returns the record unchanged
 * (the same object) when it does not apply. A rewritten record replaces any other record that has
 * its key, wherever that record sits; of two rewritten records with one key the later wins. Order
 * is otherwise kept.
 */
function applyRewrite(embeds: readonly EmbedFoldRecord[], rewrite: (record: EmbedFoldRecord) => EmbedFoldRecord): EmbedFoldRecord[] {
	const rewritten = embeds.map((record) => rewrite(record));
	const winners = new Map<string, number>();
	rewritten.forEach((record, i) => {
		if (record !== embeds[i]) winners.set(identityOf(record), i);
	});
	if (winners.size === 0) return [...embeds];
	const result: EmbedFoldRecord[] = [];
	rewritten.forEach((record, i) => {
		const winner = winners.get(identityOf(record));
		if (record !== embeds[i] ? winner === i : winner === undefined) result.push(record);
	});
	return result;
}

/** G10: `embeds` with every host and target path at or beneath `oldPath` re-based onto `newPath`.
 * A record whose host and target both lie beneath it has both fields updated in one pass; the
 * `outer` chain of a nested embed is re-based link by link, order kept. A rename onto a key that
 * already has a record replaces that record. A rename that matches nothing, or `oldPath ===
 * newPath`, returns the records unchanged (same objects). */
export function renameEmbeds(embeds: readonly EmbedFoldRecord[], oldPath: string, newPath: string): EmbedFoldRecord[] {
	if (oldPath === "" || oldPath === newPath) return [...embeds];
	return applyRewrite(embeds, (record) => {
		if (!embedsTouchPath([record], oldPath)) return record;
		const outer = record.outer?.map((link): EmbedLinkId => ({ ...link, target: remapPath(link.target, oldPath, newPath) }));
		return {
			...record,
			host: remapPath(record.host, oldPath, newPath),
			target: remapPath(record.target, oldPath, newPath),
			...(outer !== undefined ? { outer } : {}),
		};
	});
}

/** G11: `embeds` without any record whose host, target or containing embed's target is `path` or
 * lies beneath it (a deleted note or folder). A delete that matches nothing returns the records
 * unchanged. */
export function deleteEmbeds(embeds: readonly EmbedFoldRecord[], path: string): EmbedFoldRecord[] {
	if (path === "") return [...embeds];
	return embeds.filter((record) => !embedsTouchPath([record], path));
}

/** G10, outside Obsidian: `embeds` keeping only the records whose host and whole chain of targets
 * `exists`. A rename, move or delete done outside Obsidian leaves such an orphan behind; it is not
 * migrated, only dropped. */
export function pruneOrphanEmbeds(embeds: readonly EmbedFoldRecord[], exists: (path: string) => boolean): EmbedFoldRecord[] {
	return embeds.filter((record) => exists(record.host) && dependencies(record).every((path) => exists(path)));
}

/** A heading of a note as the metadata cache reports it: its text and level (1 to 6). */
export interface HeadingEntry {
	text: string;
	level: number;
}

/** True for a subpath that names a heading: not empty (a whole-note embed) and not a block id. */
export function isHeadingSubpath(subpath: string): boolean {
	return subpath !== "" && !subpath.startsWith("^");
}

/** A heading as a link spells it: the characters Obsidian drops from link text become spaces,
 * runs of white space collapse and the ends are trimmed. Applied to both sides of a comparison,
 * so it only ever treats two spellings of one heading as equal. Case is kept: `Notes` and `notes`
 * are different headings. */
function linkSpelling(text: string): string {
	return text.replace(/[#|^:%\\[\]]/g, " ").replace(/\s+/g, " ").trim();
}

interface SingleRename {
	from: string;
	to: string;
}

/** The one heading that was renamed, when `after` is `before` with exactly one entry's text
 * changed in place (same position, same level, every other entry identical); otherwise null. It is
 * also null when the rename is not unambiguous: the old or the new spelling is shared with another
 * heading of the note, or the two spellings are the same once written as a link. */
function singleRename(before: readonly HeadingEntry[], after: readonly HeadingEntry[]): SingleRename | null {
	if (before.length !== after.length) return null;
	let changed = -1;
	for (let i = 0; i < before.length; i++) {
		if (before[i].level === after[i].level && before[i].text === after[i].text) continue;
		if (changed !== -1 || before[i].level !== after[i].level) return null;
		changed = i;
	}
	if (changed === -1) return null;
	const from = linkSpelling(before[changed].text);
	const to = linkSpelling(after[changed].text);
	if (from === "" || to === "" || from === to) return null;
	if (before.some((h, i) => i !== changed && linkSpelling(h.text) === from)) return null;
	if (before.some((h) => linkSpelling(h.text) === to)) return null;
	if (after.some((h, i) => i !== changed && linkSpelling(h.text) === to)) return null;
	return { from, to };
}

/**
 * THE discrimination rule between a heading rename Obsidian performed and a link retargeted by
 * hand (G17). Given the heading list of the target note `before` and `after` the edit, the
 * `storedSubpath` of an embed record, and the subpaths of every link in the linking note that
 * resolves to that target as they read now (`linkSubpaths`), returns the subpath the record moves
 * to, or null when the change is not a rename. Null means: no migration, and the record is left
 * to the retarget handling of PR-7 (dormant for 10 minutes, then forgotten).
 *
 * It is a rename only when all of these hold:
 *  1. the stored subpath names a heading (not a block id, not a whole-note embed), and the linking
 *     note no longer links it: a link still reading the stored subpath was not rewritten;
 *  2. the target's headings are the same list with exactly one heading's text changed in place
 *     (same position, same level), and neither the old nor the new spelling is shared with another
 *     heading: a deleted heading plus an added one elsewhere, several headings changed, or an
 *     ambiguous name is not a rename;
 *  3. exactly one link now differs from the stored subpath, in exactly one `#` segment, and that
 *     segment went from the renamed heading's old text to its new text.
 * A link edited by hand to a different heading leaves the target's headings as they were, so rule
 * 2 fails. Case-different or similarly named headings never match: spellings compare exactly.
 */
export function headingRenameSubpath(input: {
	before: readonly HeadingEntry[];
	after: readonly HeadingEntry[];
	storedSubpath: string;
	linkSubpaths: readonly string[];
}): string | null {
	const { before, after, storedSubpath, linkSubpaths } = input;
	if (!isHeadingSubpath(storedSubpath) || linkSubpaths.includes(storedSubpath)) return null;
	const rename = singleRename(before, after);
	if (rename === null) return null;
	const stored = storedSubpath.split("#");
	const candidates = new Set<string>();
	for (const link of linkSubpaths) {
		if (!isHeadingSubpath(link)) continue;
		const segments = link.split("#");
		if (segments.length !== stored.length) continue;
		const differing = segments.map((segment, i) => (segment === stored[i] ? -1 : i)).filter((i) => i !== -1);
		if (differing.length !== 1) continue;
		const k = differing[0];
		if (linkSpelling(stored[k]) === rename.from && linkSpelling(segments[k]) === rename.to) candidates.add(link);
	}
	return candidates.size === 1 ? [...candidates][0] : null;
}

/** One migration of a link: in the note `source`, links to `target` that read `from` now read `to`. */
export interface HeadingMigration {
	/** The note whose text holds the rewritten link. For a flat embed that is the record's host;
	 * for an embed nested inside embedded content it is the containing note. */
	source: string;
	target: string;
	from: string;
	to: string;
}

/**
 * G17: `embeds` with the subpath of every link that `migration` describes moved to the new
 * heading. A link is one step of a record's chain (the record's own embed, or a containing embed
 * of a nested one): a step whose source note is `migration.source`, whose target is
 * `migration.target` and whose subpath is exactly `migration.from`. The occurrence index, folds,
 * content hash and dormant anchors are kept as they are. A dormancy stamp left on a migrated
 * record is cleared: the embed is live under its new heading, so it has no dormant period. A
 * migration onto a key that already has a record replaces that record (the G10 collision rule).
 * Only a heading subpath migrates; for a block or whole-note `from` the records come back
 * unchanged, as they do when nothing matches.
 */
export function migrateEmbedHeading(embeds: readonly EmbedFoldRecord[], migration: HeadingMigration): EmbedFoldRecord[] {
	const { source, target, from, to } = migration;
	if (!isHeadingSubpath(from) || !isHeadingSubpath(to) || from === to) return [...embeds];
	return applyRewrite(embeds, (record) => {
		let moved = false;
		let origin = record.host;
		const outer = record.outer?.map((link): EmbedLinkId => {
			const hit = origin === source && link.target === target && link.subpath === from;
			origin = link.target;
			if (!hit) return link;
			moved = true;
			return { ...link, subpath: to };
		});
		const ownHit = origin === source && record.target === target && record.subpath === from;
		if (!moved && !ownHit) return record;
		const { dormantSince: _stamp, ...rest } = record;
		return { ...rest, subpath: ownHit ? to : record.subpath, ...(outer !== undefined ? { outer } : {}) };
	});
}
