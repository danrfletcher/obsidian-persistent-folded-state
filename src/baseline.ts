/**
 * First-open baseline adoption (PR-6, E5/G15). When a Markdown file is opened and the store has
 * no entry for its path at all, this builds that entry from what Obsidian already shows: every
 * block CM6 currently has folded, turned into a PR-3 anchor, plus the content hash of the text as
 * opened — changing nothing in the editor. There is no fold or unfold effect and no transaction
 * of any kind here: the caller (src/editor-watcher.ts, src/fold-restorer.ts) only ever calls
 * `FoldStore.set` with this function's own output, never `view.dispatch`.
 *
 * Reads folds via `src/live-folds.ts`'s `liveFoldedLineRanges`, which wraps CM6's own
 * `foldedRanges` (`@codemirror/language`) — never Obsidian's own separate fold-state store (F9).
 * `state` and `text` are expected to describe the same document (`state.doc.toString() === text`)
 * at every real call site: `text` alone decides the content hash and the PR-3 candidate set a
 * live fold is matched against; `state` alone decides which ranges are actually folded right now.
 * `liveFoldedLineRanges` normalizes a fold ending at EOF to the same line `buildAnchors` would
 * give that block (T1), so the exact rangeKey lookup below actually finds it. T22: a live fold
 * made by directly clicking its own fold indicator (never re-rendered since) can also land
 * short of its candidate's `endLine` by a run of trailing blank separator lines `buildAnchors`
 * swallows into the block's own range — `resolveCandidateForLiveRange` (src/live-folds.ts)
 * falls back to matching that case too, once the exact lookup has already failed.
 *
 * E5: a live-folded range that doesn't land exactly on one of `buildAnchors(text)`'s own block
 * ranges (e.g. a selection fold CM6 allows that doesn't correspond to any one foldable block) is
 * skipped rather than stored half-formed — the rest of the baseline is still adopted.
 *
 * E6: a baseline never adopts more than the PR-4 matcher's own `MAX_FOLDS` cap's worth of
 * anchors, even on a first open with an enormous number of already-folded blocks, and the lookup
 * from a live range to its matching candidate groups candidates by `startLine` up front (O(live
 * folds + candidates), never O(live folds * candidates)), so this never meaningfully blocks
 * typing (E6).
 */
import type { EditorState } from "@codemirror/state";
import { buildAnchors, type Anchor } from "./anchors";
import { hashText } from "./fold-store";
import { MAX_FOLDS } from "./matcher";
import { groupCandidatesByStartLine, liveFoldedLineRanges, resolveCandidateForLiveRange } from "./live-folds";

export interface Baseline {
	contentHash: string;
	anchors: Anchor[];
}

/** Builds a first-open baseline (E5/G15) from `state`'s live fold state and `text`'s own
 * candidate blocks. Never throws; a document with no live folds at all still returns a valid
 * (empty-anchors) baseline — G15's "stored as an empty baseline entry". */
export function buildBaseline(state: EditorState, text: string): Baseline {
	const contentHash = hashText(text);
	const liveFolds = liveFoldedLineRanges(state);
	if (liveFolds.length === 0) return { contentHash, anchors: [] };

	const candidates = buildAnchors(text);
	const candidatesByStart = groupCandidatesByStartLine(candidates);

	const anchors: Anchor[] = [];
	for (const range of liveFolds) {
		if (anchors.length >= MAX_FOLDS) break; // E6: respects the PR-4 cap even on first open
		const candidate = resolveCandidateForLiveRange(state, range, candidatesByStart);
		if (!candidate) continue; // E5: a range the PR-3 builder can't produce is skipped, not half-stored
		anchors.push(candidate.anchor);
	}
	return { contentHash, anchors };
}
