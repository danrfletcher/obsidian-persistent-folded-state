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
 */
import { foldedRanges } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { LineRange } from "./anchors";

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
