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
 * R4/R5: rather than hand-tracking a push/splice list against `tr.startState`, the recorded set
 * is derived straight from CM6's own live fold state, `foldedRanges(tr.state)`, whenever a
 * fold/unfold effect is seen. Two things fall out of that for free:
 *  - R4 (de-duplication): `foldState`'s own `update()` (@codemirror/language) already refuses to
 *    add a fold effect over a range that's already folded (`foldExists(...)` guards the push),
 *    and an unfold effect filters the matching range straight out of the live set. Deriving from
 *    that set after the transaction means a double fold of the same block can never produce two
 *    stored entries, and an unfold always removes exactly the live entry it targets — never a
 *    stale duplicate or the wrong one.
 *  - R5 (post-change coordinates): `foldState.update()` maps every existing folded range through
 *    `tr.changes` *before* adding any new ones from this transaction's effects, so by the time
 *    `foldedRanges(tr.state)` is read, every range — new or carried over — is already in
 *    `tr.state`'s post-change coordinates. Describing each one against `tr.state` (not
 *    `tr.startState`) is therefore both correct and necessary: for a transaction that folds a
 *    range and changes the document in the same dispatch, `tr.startState.doc.lineAt(...)` would
 *    either name the wrong block or throw past the old document's end.
 */
import { Annotation } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import { foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import type { StoredAnchor } from "./types";
import type { FoldStore } from "./fold-store";
import { hashText } from "./fold-store";
import { describeFold } from "./describe-fold";

/** A later PR (restoring folds, PR-5) tags every transaction it dispatches to re-apply a fold
 * with this annotation, so this recorder never mistakes that re-apply for a fresh user fold
 * (E11: "The plugin tags its own fold effects ... so the recorder never stores them as user
 * folds"). Tagging the whole transaction rather than each individual effect is enough in
 * practice: every fold/unfold effect a restore dispatches arrives in the same transaction it
 * tags, and nothing in this PR ever mixes a restore effect with a genuine user fold in one
 * dispatch. Exported so that future PR can dispatch with `annotations: OWN_FOLD_ANNOTATION.of(true)`. */
export const OWN_FOLD_ANNOTATION = Annotation.define<true>();

/** Processes one transaction's fold/unfold effects for `path`, updating `store` in place. A
 * no-op — reads nothing, writes nothing — for a transaction carrying no fold/unfold effects at
 * all, or one tagged with `OWN_FOLD_ANNOTATION` (not the user's own action — E11). When a
 * fold/unfold effect is present, the entire stored `folds` list is replaced with a fresh
 * description of CM6's own live fold set (`foldedRanges(tr.state)`) — see the file comment for
 * why that, rather than incremental push/splice bookkeeping, is what gives G1/G15/R4/R5 their
 * guarantees. */
export function recordFoldEffects(store: FoldStore, path: string, tr: Transaction): void {
	if (tr.annotation(OWN_FOLD_ANNOTATION)) return;

	const hasFoldOrUnfold = tr.effects.some((effect) => effect.is(foldEffect) || effect.is(unfoldEffect));
	if (!hasFoldOrUnfold) return;

	const folds: StoredAnchor[] = [];
	foldedRanges(tr.state).between(0, tr.state.doc.length, (from, to) => {
		folds.push(describeFold(tr.state, { from, to }) as unknown as StoredAnchor);
	});

	// Each recorded fold or unfold also stores the note's current content hash, so a later PR
	// (PR-7) can tell whether the file changed while Obsidian was closed.
	const existing = store.get(path);
	store.set(path, { contentHash: hashText(tr.state.doc.toString()), folds, dormant: existing?.dormant ?? [] });
}
