/**
 * T1: the one place both `src/baseline.ts` and `src/fold-restorer.ts` read CM6's live
 * `foldedRanges` and convert a `{from,to}` span into the same 1-indexed inclusive line-range
 * convention `src/anchors.ts`'s `buildAnchors` uses, so a baseline/`alreadyFolded` rangeKey
 * lookup on one side always speaks the same line numbers as the candidate set on the other.
 *
 * The mismatch this fixes: when a fold is the last foldable block in a file (a trailing heading
 * or section with nothing after it), CM6 extends that fold's `to` all the way to `state.doc.length`
 * — which, for any document ending in a trailing newline (virtually all notes), lands one line
 * *past* the document's last real content line, on the empty line CM6's own `Text` representation
 * keeps after a final `\n`. `buildAnchors` never produces that phantom line (its `splitLines`
 * drops exactly one trailing empty entry — see anchors.ts), so its own `endLine` for that same
 * block is one less. Before this fix, `src/baseline.ts`'s exact `rangeKey` lookup never found a
 * candidate for that live range and silently skipped it as "unbuildable" (T1/T5/T11) — the block
 * was representable; only the EOF boundary convention differed between the two sides.
 *
 * Only the EOF case is special-cased: a fold whose `to` lands anywhere else (not at
 * `state.doc.length`) is unaffected, and a document with no trailing newline at all already
 * agrees with `buildAnchors` (nothing to subtract).
 *
 * T22: a second, mid-document mismatch in the *other* direction. `buildAnchors`' own
 * `closeFramesAbove` (anchors.ts) swallows a run of blank separator lines between an EXTENDABLE
 * block (heading/task/list/other) and its next sibling into that block's own `endLine`. A live
 * CM6 fold made by directly clicking its own fold indicator has no notion of that convention —
 * it only ever covers the block's own content, so it can land *short* of the matching
 * candidate's `endLine` by exactly that trailing blank run (Obsidian's own reopen-time fold
 * restoration happens to recompute a wider range that agrees with `buildAnchors`, but a fold
 * that's never re-rendered keeps its original, narrower range). `widenLiveRangeToCandidate`
 * and `resolveCandidateForLiveRange` below are the fallback both `src/baseline.ts` and
 * `src/editor-watcher.ts`'s grace recheck use, once an *exact* rangeKey match has already
 * failed, to still resolve such a range to its candidate — never the reverse (a candidate is
 * never narrowed to fit a live range), and never for a run that contains anything but blank
 * lines, so a fold whose own convention already agrees with `buildAnchors` (every
 * non-EXTENDABLE kind — frontmatter/code/callout/blockquote — included, since those always
 * have a fixed range that's never extended this way) is completely unaffected.
 */
import { foldedRanges } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import type { AnchoredBlock, LineRange } from "./anchors";

/** `to`'s line number, adjusted so a fold that runs to the very end of a document ending in a
 * trailing newline doesn't count CM6's own trailing blank line — the one line `buildAnchors`
 * never produces for the same block. */
function liveEndLine(state: EditorState, to: number): number {
	const lineNumber = state.doc.lineAt(to).number;
	if (to !== state.doc.length) return lineNumber; // only the EOF boundary is ambiguous
	if (lineNumber <= 1) return lineNumber; // nothing to exclude
	if (state.doc.line(lineNumber).length !== 0) return lineNumber; // not a trailing-newline artifact
	return lineNumber - 1;
}

/** Every range CM6 currently shows as folded in `state`, as 1-indexed inclusive line numbers,
 * using the same EOF convention `buildAnchors` uses (see the file comment). */
export function liveFoldedLineRanges(state: EditorState): LineRange[] {
	const ranges: LineRange[] = [];
	foldedRanges(state).between(0, state.doc.length, (from, to) => {
		ranges.push({ startLine: state.doc.lineAt(from).number, endLine: liveEndLine(state, to) });
	});
	return ranges;
}

/** T22: true when `candidate` is `range` widened by nothing but a run of blank lines — same
 * `startLine`, a strictly greater `endLine`, and every line in between is blank. Never widens
 * past `state.doc.lines`, and never matches a `candidate` that's narrower than or equal to
 * `range` (that's the already-handled exact-match or EOF case, not this one). */
export function widenLiveRangeToCandidate(state: EditorState, range: LineRange, candidate: LineRange): boolean {
	if (candidate.startLine !== range.startLine) return false;
	if (candidate.endLine <= range.endLine) return false;
	if (candidate.endLine > state.doc.lines) return false;
	for (let line = range.endLine + 1; line <= candidate.endLine; line++) {
		if (state.doc.line(line).text.trim() !== "") return false; // only blank separators are swallowed
	}
	return true;
}

/** PR-1 R4: true when `live` (one of `liveFoldedLineRanges`' outputs) is the fold of `candidate`
 * (a `buildAnchors` range): the same range, or `live` narrower by only the trailing blank run
 * `buildAnchors` swallows into `candidate` (`widenLiveRangeToCandidate`). The plugin's own restored
 * folds end at the block's last content line (`foldSpanForLineRange`), as do click-made ones, so
 * an exact comparison against the untrimmed candidate range never sees them as the same block.
 * Every live-vs-candidate comparison in src/open-restore.ts goes through this. */
export function liveFoldCoversCandidate(state: EditorState, live: LineRange, candidate: LineRange): boolean {
	if (live.startLine === candidate.startLine && live.endLine === candidate.endLine) return true;
	return widenLiveRangeToCandidate(state, live, candidate);
}

/** Resolves one of `liveFoldedLineRanges`' own outputs to whichever `AnchoredBlock` in
 * `candidatesByStart` (grouped by `range.startLine`) it represents: an exact rangeKey match
 * first, falling back to `widenLiveRangeToCandidate` (T22) so a live fold whose range is a
 * blank-line-narrower subset of its own candidate's range still resolves. Returns `null` if
 * neither finds anything (E5: a range the PR-3 builder can't produce for any candidate stays
 * unbuildable). Shared by `src/baseline.ts` and `src/editor-watcher.ts`'s grace recheck so
 * first-open baseline adoption behaves identically at either call site. */
export function resolveCandidateForLiveRange(
	state: EditorState,
	range: LineRange,
	candidatesByStart: ReadonlyMap<number, readonly AnchoredBlock[]>,
): AnchoredBlock | null {
	const sameStart = candidatesByStart.get(range.startLine);
	if (!sameStart) return null;
	for (const candidate of sameStart) {
		if (candidate.range.endLine === range.endLine) return candidate;
	}
	for (const candidate of sameStart) {
		if (widenLiveRangeToCandidate(state, range, candidate.range)) return candidate;
	}
	return null;
}

/** The last line of `range` that is not blank (never before `range.startLine`). `buildAnchors`
 * closes a list/task/heading/other block lazily, so its `endLine` includes the blank separator
 * lines before the next sibling (src/anchors.ts, PR-3 R4); a fold must stop at the block's own
 * last content line, which is also where Obsidian's own fold service and a click-made fold end. */
function lastContentLine(doc: Text, range: LineRange): number {
	let endLine = Math.min(range.endLine, doc.lines);
	while (endLine > range.startLine && doc.line(endLine).text.trim() === "") endLine--;
	return endLine;
}

/** The CM6 fold span for `range`, a `buildAnchors` line range: from the end of the block's first
 * line to the end of its last non-blank line (PR-5 R4: trailing blank lines are trimmed, so a
 * restored fold never hides the blank separator that follows the block). `null` when the range
 * lies outside `doc`, or when nothing is left to hide. The shared fold-end rule for every
 * fold/unfold effect this plugin dispatches (src/fold-restorer.ts, src/open-restore.ts). */
export function foldSpanForLineRange(doc: Text, range: LineRange): { from: number; to: number } | null {
	if (range.startLine < 1 || range.endLine > doc.lines) return null;
	const endLine = lastContentLine(doc, range);
	if (endLine <= range.startLine) return null; // nothing to collapse
	const from = doc.line(range.startLine).to;
	const to = doc.line(endLine).to;
	return from >= to ? null : { from, to };
}

/** Groups `candidates` by their `range.startLine` — the shape `resolveCandidateForLiveRange`
 * expects. A plain helper so both call sites build this map the same way. */
export function groupCandidatesByStartLine(candidates: readonly AnchoredBlock[]): Map<number, AnchoredBlock[]> {
	const byStart = new Map<number, AnchoredBlock[]>();
	for (const candidate of candidates) {
		const list = byStart.get(candidate.range.startLine);
		if (list) list.push(candidate);
		else byStart.set(candidate.range.startLine, [candidate]);
	}
	return byStart;
}
