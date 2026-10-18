/**
 * First-open baseline adoption (PR-6, E5/G15). When a Markdown file is opened and the store has
 * no entry for its path at all, this builds that entry from what Obsidian already shows: every
 * block CM6 currently has folded, turned into a PR-3 anchor, plus the content hash of the text as
 * opened — changing nothing in the editor. There is no fold or unfold effect and no transaction
 * of any kind here: the caller (src/editor-watcher.ts, src/fold-restorer.ts) only ever calls
 * `FoldStore.set` with this function's own output, never `view.dispatch`.
 *
 * Reads folds from CM6's own `foldedRanges` (`@codemirror/language`) — never Obsidian's own
 * separate fold-state store (F9). `state` and `text` are expected to describe the same document
 * (`state.doc.toString() === text`) at every real call site: `text` alone decides the content
 * hash and the PR-3 candidate set a live fold is matched against; `state` alone decides which
 * ranges are actually folded right now.
 *
 * E5: a live-folded range that doesn't land exactly on one of `buildAnchors(text)`'s own block
 * ranges (e.g. a selection fold CM6 allows that doesn't correspond to any one foldable block) is
 * skipped rather than stored half-formed — the rest of the baseline is still adopted.
 *
 * E6: a baseline never adopts more than the PR-4 matcher's own `MAX_FOLDS` cap's worth of
 * anchors, even on a first open with an enormous number of already-folded blocks, and the lookup
 * from a live range to its matching candidate is a single `Map` pass (O(live folds + candidates),
 * never O(live folds * candidates)), so this never meaningfully blocks typing (E6).
 */
import { foldedRanges } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { buildAnchors, type Anchor, type AnchoredBlock, type LineRange } from "./anchors";
import { hashText } from "./fold-store";
import { MAX_FOLDS } from "./matcher";

export interface Baseline {
	contentHash: string;
	anchors: Anchor[];
}

/** Every range CM6 currently shows as folded in `state`, as 1-indexed inclusive line numbers —
 * the same `{from,to}` → line-number conversion `src/fold-restorer.ts`'s `currentFoldedLineRanges`
 * uses, so a live range here lines up exactly with an `AnchoredBlock.range` from `buildAnchors`. */
function liveFoldedLineRanges(state: EditorState): LineRange[] {
	const ranges: LineRange[] = [];
	foldedRanges(state).between(0, state.doc.length, (from, to) => {
		ranges.push({ startLine: state.doc.lineAt(from).number, endLine: state.doc.lineAt(to).number });
	});
	return ranges;
}

function rangeKey(range: LineRange): string {
	return `${range.startLine}:${range.endLine}`;
}

/** Builds a first-open baseline (E5/G15) from `state`'s live fold state and `text`'s own
 * candidate blocks. Never throws; a document with no live folds at all still returns a valid
 * (empty-anchors) baseline — G15's "stored as an empty baseline entry". */
export function buildBaseline(state: EditorState, text: string): Baseline {
	const contentHash = hashText(text);
	const liveFolds = liveFoldedLineRanges(state);
	if (liveFolds.length === 0) return { contentHash, anchors: [] };

	const candidates = buildAnchors(text);
	const byRange = new Map<string, AnchoredBlock>();
	for (const candidate of candidates) byRange.set(rangeKey(candidate.range), candidate);

	const anchors: Anchor[] = [];
	for (const range of liveFolds) {
		if (anchors.length >= MAX_FOLDS) break; // E6: respects the PR-4 cap even on first open
		const candidate = byRange.get(rangeKey(range));
		if (!candidate) continue; // E5: a range the PR-3 builder can't produce is skipped, not half-stored
		anchors.push(candidate.anchor);
	}
	return { contentHash, anchors };
}
