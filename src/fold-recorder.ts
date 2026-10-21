/**
 * Turns a user's own fold/unfold effects into FoldStore updates (G1). The ticket plan calls out
 * "do not split fold recording from the user-event tagging" (E11): recording an effect and
 * deciding whether it's even the user's to record are one decision, made together, right here.
 *
 * The one seam: `describeFold` (src/describe-fold.ts) turns a folded range into the opaque
 * descriptor that's actually stored. PR-5 swaps that file's contents for the PR-3 anchor
 * builder; nothing in this file needs to change when that happens.
 *
 * Runs on every transaction a fold-effect-carrying editor view sees, regardless of whether that
 * same transaction also changed the document (E3: a fold/unfold made during an external
 * rewrite's settle window is recorded immediately, not deferred until anything "settles") and
 * regardless of the transaction's classification under src/transaction-classifier.ts (which only
 * concerns the settle-debounce timer, not fold recording).
 *
 * R4: only the fold/unfold effects actually present *in this transaction* change stored state —
 * never-break rule 2, "only the user's own fold or unfold changes stored state". Earlier this
 * rewrote the entire stored `folds` list from CM6's own live fold set on every fold/unfold,
 * which is wrong whenever the live set is momentarily incomplete relative to what's stored: a
 * restore still mid-match (its fold effects not dispatched yet), a G13 fold still deferred
 * (cursor inside the block), or a reload that has cleared the live folds before the restore
 * runs. A user fold/unfold landing during any of those windows would silently drop every other
 * stored anchor. Instead, each effect is applied individually against the *existing* stored
 * list, keyed by `anchorKey` (one map entry per structural identity): a `foldEffect` upserts its
 * anchor, an `unfoldEffect` removes it, and every anchor the transaction's own effects don't
 * mention is carried over untouched. Effects are applied in `tr.effects`' own order so a
 * transaction that happens to both fold and unfold the same block (CM6 itself processes its
 * `foldState` effects in order — see @codemirror/language) lands on the same final answer CM6's
 * own live fold set would.
 *
 * R5: every effect's `{from, to}` is already in `tr.state`'s post-change coordinates (CM6's own
 * `foldState.update()` maps existing ranges through `tr.changes` *before* reading this
 * transaction's own effects, and a freshly dispatched effect is specified against the resulting
 * document already — see @codemirror/language's `foldState`), so describing each one against
 * `tr.state` (not `tr.startState`) is both correct and necessary: for a transaction that folds a
 * range and changes the document in the same dispatch, `tr.startState.doc.lineAt(...)` would
 * either name the wrong block or throw past the old document's end.
 *
 * R8 (PR-5): an unfold (or re-fold) of a block whose stored entry is out of date must still find
 * that entry. A restore that matched a block fuzzily or through a sibling shift leaves the stored
 * anchor describing the block as it *used to* read, and `describeFold` builds the anchor fresh
 * from the current text, so the two keys differ and a plain `anchorKey` delete would miss. The
 * fix is `resolveStaleEntryKey`: when no stored entry has the block's exact key, a stored entry
 * that no current block accounts for (it describes nothing in the document as it is now) and
 * that is plainly this block under an earlier reading (same text and ancestry, or same position
 * and a similar enough text) is the one removed/replaced. Anything a current block still
 * accounts for is never touched, so folding one of two identical-text blocks cannot claim the
 * other's entry. (src/fold-restorer.ts also re-keys entries to the matched block's current
 * anchor after every restore, so this is the fallback for the cases a restore did not touch:
 * the user's own edits shifting a folded block.)
 *
 * R7 (PR-5): the note's anchors are built once per transaction and shared by every effect in it.
 *
 * R12 (PR-2): this only re-snapshots on a transaction that carries a fold/unfold effect. When a
 * document change silently drops or moves a live fold, CM6 emits no unfold effect, so the
 * stored list can lag the live fold set after an external rewrite until the next fold or
 * unfold. Anything that reads the store right after such a rewrite (restore, open-restore)
 * should expect that.
 */
import { Annotation } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import { foldEffect, unfoldEffect } from "@codemirror/language";
import type { StoredAnchor } from "./types";
import type { FoldStore } from "./fold-store";
import { hashText } from "./fold-store";
import { anchorKey, buildAnchors, parseAnchor, type Anchor, type AnchoredBlock } from "./anchors";
import { POSITIONAL_THRESHOLD } from "./matcher";
import { similarity } from "./similarity";
import { describeFold } from "./describe-fold";

/** PR-5 (restoring folds) tags every transaction it dispatches to re-apply a fold with this
 * annotation (see src/fold-restorer.ts), so this recorder never mistakes that re-apply for a
 * fresh user fold (E11: "The plugin tags its own fold effects ... so the recorder never stores them as user
 * folds"). Tagging the whole transaction rather than each individual effect is enough in
 * practice: every fold/unfold effect a restore dispatches arrives in the same transaction it
 * tags, and nothing in this PR ever mixes a restore effect with a genuine user fold in one
 * dispatch. Exported so that future PR can dispatch with `annotations: OWN_FOLD_ANNOTATION.of(true)`. */
export const OWN_FOLD_ANNOTATION = Annotation.define<true>();

function chainKey(anchor: Anchor): string {
	return JSON.stringify(anchor.parentChain.map((ref) => [ref.kind, ref.text]));
}

/** R8 (PR-5): the key of the stored entry that is `anchor`'s block under an earlier reading, or
 * `null` when there is none (or it isn't unambiguous). Only entries no current block accounts
 * for are eligible — see the file comment. Two passes, strongest evidence first: identical kind,
 * text and ancestry (the block merely moved: indent/sibling index shifted); else identical kind,
 * ancestry, sibling index and indent with a text similar enough to be the same block reworded
 * (the matcher's own positional bar). A tie in either pass resolves to `null`. */
function resolveStaleEntryKey(
	entries: ReadonlyMap<string, StoredAnchor>,
	anchor: Anchor,
	blocks: readonly AnchoredBlock[],
): string | null {
	const accounted = new Set(blocks.map((block) => anchorKey(block.anchor)));
	const stale: { key: string; entry: Anchor }[] = [];
	for (const [key, raw] of entries) {
		const entry = parseAnchor(raw);
		if (entry && !accounted.has(key) && entry.kind === anchor.kind) stale.push({ key, entry });
	}
	const chain = chainKey(anchor);
	const sameChain = stale.filter((s) => chainKey(s.entry) === chain);

	const sameText = sameChain.filter((s) => s.entry.text === anchor.text);
	if (sameText.length === 1) return sameText[0].key;
	if (sameText.length > 1) return null;

	// An entry whose exact text still reads in another block of the same ancestry is that
	// block's (it merely shifted); it must not be claimed by a block that is only similar.
	const textsStillPresent = new Set(
		blocks.filter((block) => block.anchor.kind === anchor.kind && chainKey(block.anchor) === chain).map((block) => block.anchor.text),
	);
	let best: { key: string; score: number } | null = null;
	let tied = false;
	for (const s of sameChain) {
		if (textsStillPresent.has(s.entry.text)) continue;
		if (s.entry.siblingIndex !== anchor.siblingIndex || s.entry.indent !== anchor.indent) continue;
		const score = similarity(s.entry.text, anchor.text);
		if (score < POSITIONAL_THRESHOLD) continue;
		if (best === null || score > best.score + 1e-9) {
			best = { key: s.key, score };
			tied = false;
		} else if (Math.abs(score - best.score) <= 1e-9) {
			tied = true;
		}
	}
	return best !== null && !tied ? best.key : null;
}

/** Processes one transaction's fold/unfold effects for `path`, updating `store` in place. A
 * no-op — reads nothing, writes nothing — for a transaction carrying no fold/unfold effects at
 * all, or one tagged with `OWN_FOLD_ANNOTATION` (not the user's own action — E11). When a
 * fold/unfold effect is present, each one is applied individually against the existing stored
 * list, keyed by `anchorKey` — see the file comment (R4) for why that, rather than rewriting the
 * whole list from CM6's live fold set, is what keeps this to only the user's own change. A
 * stored entry that isn't a well-formed `Anchor` (a PR-2-era raw-text record) has no key to
 * carry over and is dropped here, the same as the store's own load-time sanitiser already does. */
export function recordFoldEffects(store: FoldStore, path: string, tr: Transaction): void {
	if (tr.annotation(OWN_FOLD_ANNOTATION)) return;

	const hasFoldOrUnfold = tr.effects.some((effect) => effect.is(foldEffect) || effect.is(unfoldEffect));
	if (!hasFoldOrUnfold) return;

	const existing = store.get(path);
	const folds = new Map<string, StoredAnchor>();
	for (const raw of existing?.folds ?? []) {
		const anchor = parseAnchor(raw);
		if (anchor) folds.set(anchorKey(anchor), raw);
	}

	// R7 (PR-5): one parse of the note per transaction, shared by every effect below.
	const blocks = buildAnchors(tr.state.doc.toString());
	for (const effect of tr.effects) {
		if (effect.is(foldEffect)) {
			const anchor = describeFold(tr.state, effect.value, blocks);
			const key = anchorKey(anchor);
			// R8: re-folding a block whose entry is stale replaces it rather than adding a second.
			if (!folds.has(key)) {
				const staleKey = resolveStaleEntryKey(folds, anchor, blocks);
				if (staleKey !== null) folds.delete(staleKey);
			}
			folds.set(key, anchor as unknown as StoredAnchor);
		} else if (effect.is(unfoldEffect)) {
			const anchor = describeFold(tr.state, effect.value, blocks);
			const key = anchorKey(anchor);
			const removeKey = folds.has(key) ? key : resolveStaleEntryKey(folds, anchor, blocks);
			if (removeKey !== null) folds.delete(removeKey);
		}
	}

	// Each recorded fold or unfold also stores the note's current content hash, so a later PR
	// (PR-7) can tell whether the file changed while Obsidian was closed.
	store.set(path, {
		contentHash: hashText(tr.state.doc.toString()),
		folds: Array.from(folds.values()),
		dormant: existing?.dormant ?? [],
	});
}
