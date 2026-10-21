/**
 * The seam PR-2 left for this (src/fold-recorder.ts's one call site). PR-5 replaces its old
 * line-local guess (raw text + a rough kind + indent, no sibling index, no parent chain) with
 * PR-3's real anchor builder (src/anchors.ts): every fold recorded from now on stores a real
 * `Anchor` — kind, indent, normalized text, sibling index and parent chain — not raw line text.
 *
 * `describeFold`'s own signature is unchanged (`(state, range) -> descriptor`), so
 * src/fold-recorder.ts needed no change at all for this swap, exactly as its own file comment
 * predicted. Internally this now runs `buildAnchors` over the transaction's current document
 * and picks out the one block whose range starts on the folded line — `range.from`'s line is
 * always a block's own first line for any real fold/unfold effect, so that line number is a
 * unique key into `buildAnchors`' output.
 *
 * A record built the old way (no `siblingIndex`/`parentChain`) fails `parseAnchor` and is
 * discarded on load (`src/fold-store.ts`'s sanitiser) rather than ever being matched against —
 * the data is per-device and at most a few minutes old, so losing it is an accepted, one-time
 * cost of this PR landing, not something this file needs to migrate.
 */
import type { EditorState } from "@codemirror/state";
import { buildAnchors, type Anchor, type AnchoredBlock } from "./anchors";

/** Describes the fold/unfold effect at `range` as a real `Anchor` (PR-3), built fresh from
 * `state`'s current document. `range.to` is CM6's own bookkeeping for where the fold closes and
 * isn't needed here (same as the PR-2 placeholder this replaces) — only `range.from`'s line
 * matters. Never throws: a `range.from` that doesn't land on any `buildAnchors` segment start
 * (shouldn't happen for a real fold/unfold effect, since every foldable position is itself a
 * segment start) falls back to describing that line alone as a bare, unparented "other" anchor
 * rather than losing the record entirely.
 *
 * R7 (PR-5): `blocks` is `buildAnchors(state.doc.toString())`. Building it walks the whole
 * document, so a caller describing several folds against one `state` (the recorder, once per
 * fold/unfold effect in a transaction) builds it once and passes it in, instead of re-parsing
 * the note for every fold. Omitted, it is built here. */
export function describeFold(
	state: EditorState,
	range: { from: number; to: number },
	blocks: readonly AnchoredBlock[] = buildAnchors(state.doc.toString()),
): Anchor {
	const line = state.doc.lineAt(range.from);
	const match = blocks.find((block) => block.range.startLine === line.number);
	if (match) return match.anchor;

	return { kind: "other", indent: 0, text: line.text.trim().toLowerCase(), siblingIndex: 0, parentChain: [] };
}
