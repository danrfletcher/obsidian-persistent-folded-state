/**
 * Pure vault-lifecycle bookkeeping (PR-7, G9/G10/E4). No Obsidian, CodeMirror, DOM, file or
 * network imports — plain data in, plain data out, same fence discipline as
 * `src/matcher.ts`/`src/restore-plan.ts`/`src/dormant.ts` (F1/F8/F9). The CM6/Obsidian-level
 * wiring (reading `app.vault.on("rename"/"delete", ...)`, deciding what "exists" means) lives in
 * `src/fold-store.ts` (thin wrapper methods) and `main.ts`; this module only decides what the
 * resulting map of records should look like.
 *
 * G9 (rename/move): `renameFiles` re-keys one note's entry (file rename) or every entry nested
 * beneath a path (folder rename/move) to its new vault-relative path, carrying `contentHash` and
 * `dormant` along unchanged — nothing here re-matches or re-hashes, since the file's own content
 * didn't change, only where it lives. A rename onto a path that already has a stored entry
 * replaces that entry outright (the destination's own stale data is simply overwritten) and the
 * old key never survives the call, whether or not anything was actually found under `oldPath`
 * (a miss is a no-op, never a throw).
 *
 * G10 (delete): `deleteFiles` removes one note's entry (file delete) or every entry nested
 * beneath a path (folder delete). A miss is a no-op, never a throw.
 *
 * G9 ("renamed outside Obsidian: not in v1"): there is no listener for that case at all — the
 * orphan this leaves behind is only ever cleaned up at the next plugin load, by
 * `pruneOrphanFiles` below (not by anything reacting to the rename itself).
 *
 * G8 (content-hash decision): `needsRematchOnOpen` is the one-line decision a file-open handler
 * (`src/open-restore.ts`) makes before doing anything else — true when the text as opened no
 * longer hashes the same as what was last stored for it, meaning Obsidian's own native restore
 * may be showing stale offsets and the stored (and dormant) anchors need re-matching against the
 * text as it actually reads now.
 *
 * E4 (native restore reconciliation): `reconcileNativeRestore` is the other half of the same
 * open-time decision. Given every range Obsidian's own native per-session fold restore already
 * applied (`nativeFolded`) and every range the plugin's own matched set says should be folded
 * (`matched` — active and dormant matches alike, deferred-for-G13 ones included, since those are
 * still "matched", just not dispatched yet), decides what the caller still needs to fold
 * (`matched` minus `nativeFolded`) and what it needs to explicitly unfold (`nativeFolded` minus
 * `matched` — a stale offset, or a native fold for something that isn't stored at all any more).
 * Line-count-preserving content changes are exactly the case E4 names as native restore's own
 * blind spot (it has no notion of *which* block a line range used to mean, only that a range
 * which used to be valid is still in range), so this never trusts `nativeFolded` over the
 * matcher's own decision — it only ever uses it to avoid redispatching a fold that's already
 * correctly showing.
 */
import type { LineRange } from "./anchors";
import type { FileFoldRecord } from "./types";

/** G9: re-keys `oldPath` (and, for a folder, everything nested under it) to `newPath` in a copy
 * of `files` — `files` itself is never mutated. A rename onto a path that already has an entry
 * replaces it; a rename of a path with no entry at all (file or folder) is a no-op, returning a
 * shallow copy of `files` unchanged. */
export function renameFiles(
	files: Readonly<Record<string, FileFoldRecord>>,
	oldPath: string,
	newPath: string,
): Record<string, FileFoldRecord> {
	const result: Record<string, FileFoldRecord> = { ...files };
	if (oldPath === newPath) return result;

	const prefix = `${oldPath}/`;
	for (const [path, record] of Object.entries(files)) {
		if (path !== oldPath && !path.startsWith(prefix)) continue;
		delete result[path];
		const destination = path === oldPath ? newPath : `${newPath}/${path.slice(prefix.length)}`;
		result[destination] = record; // replaces whatever (if anything) was already stored there
	}
	return result;
}

/** G10: removes `path` (and, for a folder, everything nested under it) from a copy of `files` —
 * `files` itself is never mutated. A delete of a path with no entry at all is a no-op, returning
 * a shallow copy of `files` unchanged. */
export function deleteFiles(files: Readonly<Record<string, FileFoldRecord>>, path: string): Record<string, FileFoldRecord> {
	const prefix = `${path}/`;
	const result: Record<string, FileFoldRecord> = {};
	for (const [p, record] of Object.entries(files)) {
		if (p === path || p.startsWith(prefix)) continue;
		result[p] = record;
	}
	return result;
}

/** G9 ("renamed outside Obsidian: not in v1"), run at plugin load: keeps only the entries in
 * `files` for which `exists(path)` is true, dropping every orphan left behind by a rename, move
 * or delete that happened outside Obsidian (or while it wasn't running) entirely. */
export function pruneOrphanFiles(
	files: Readonly<Record<string, FileFoldRecord>>,
	exists: (path: string) => boolean,
): Record<string, FileFoldRecord> {
	const result: Record<string, FileFoldRecord> = {};
	for (const [path, record] of Object.entries(files)) {
		if (exists(path)) result[path] = record;
	}
	return result;
}

/** G8: true once the text as opened no longer hashes the same as what was last stored for this
 * file — the trigger for a re-match (and, per E4, for replacing Obsidian's own native restore
 * with the plugin's matched set). False (no re-match at all) when the hashes still agree. */
export function needsRematchOnOpen(storedContentHash: string, currentContentHash: string): boolean {
	return storedContentHash !== currentContentHash;
}

export interface NativeReconcileResult {
	/** Ranges the plugin's matched set wants folded that aren't folded live yet. */
	toFold: LineRange[];
	/** Ranges Obsidian's own native restore folded that aren't in the matched set at all — a
	 * stale offset (E4), or simply nothing stored for that line range any more. */
	toUnfold: LineRange[];
}

function sameRange(a: LineRange, b: LineRange): boolean {
	return a.startLine === b.startLine && a.endLine === b.endLine;
}

/** E4: reconciles Obsidian's own native per-session fold restore (`nativeFolded`) against the
 * plugin's own matched set (`matched`, in whatever coordinates both lists already share). Never
 * throws, including on either list being empty — an empty `matched` with a non-empty
 * `nativeFolded` unfolds every native fold outright (nothing stored says any of it should still
 * be folded); an empty `nativeFolded` with a non-empty `matched` folds all of it, with nothing to
 * unfold. A range present in both is left alone (in neither `toFold` nor `toUnfold`) — it is
 * already correctly showing, matching E4's "the plugin adds nothing that was not stored" for the
 * ranges that already agree.
 *
 * PR-1 R4: "the same range" is `covers(native, matched)`, `sameRange` by default. A caller whose
 * `matched` are `buildAnchors` ranges (blank separators included) but whose `nativeFolded` are
 * live CM6 folds (ending at the last content line) passes `liveFoldCoversCandidate`, so a
 * trimmed fold counts as agreeing with its block instead of being unfolded as a stale offset. */
export function reconcileNativeRestore(
	nativeFolded: readonly LineRange[],
	matched: readonly LineRange[],
	covers: (native: LineRange, matched: LineRange) => boolean = sameRange,
): NativeReconcileResult {
	const toFold = matched.filter((m) => !nativeFolded.some((n) => covers(n, m)));
	const toUnfold = nativeFolded.filter((n) => !matched.some((m) => covers(n, m)));
	return { toFold, toUnfold };
}
