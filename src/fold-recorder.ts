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
 */
import { Annotation } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import { foldEffect, unfoldEffect } from "@codemirror/language";
import type { StoredAnchor } from "./types";
import type { FoldStore } from "./fold-store";
import { hashText } from "./fold-store";
import { describeFold, type FoldDescriptor } from "./describe-fold";

/** A later PR (restoring folds, PR-5) tags every transaction it dispatches to re-apply a fold
 * with this annotation, so this recorder never mistakes that re-apply for a fresh user fold
 * (E11: "The plugin tags its own fold effects ... so the recorder never stores them as user
 * folds"). Tagging the whole transaction rather than each individual effect is enough in
 * practice: every fold/unfold effect a restore dispatches arrives in the same transaction it
 * tags, and nothing in this PR ever mixes a restore effect with a genuine user fold in one
 * dispatch. Exported so that future PR can dispatch with `annotations: OWN_FOLD_ANNOTATION.of(true)`. */
export const OWN_FOLD_ANNOTATION = Annotation.define<true>();

function sameDescriptor(descriptor: FoldDescriptor, stored: StoredAnchor): boolean {
	return stored.text === descriptor.text && stored.kind === descriptor.kind && stored.indent === descriptor.indent;
}

/** Processes one transaction's fold/unfold effects for `path`, updating `store` in place. A
 * no-op — reads nothing, writes nothing — for a transaction carrying no fold/unfold effects at
 * all, or one tagged with `OWN_FOLD_ANNOTATION` (not the user's own action — E11). Effects are
 * applied in the order CM6 reports them, against `tr.startState` (fold/unfold transactions never
 * also change the document, so the pre- and post-transaction text are identical either way). */
export function recordFoldEffects(store: FoldStore, path: string, tr: Transaction): void {
	if (tr.annotation(OWN_FOLD_ANNOTATION)) return;

	const existing = store.get(path);
	const folds: StoredAnchor[] = existing ? [...existing.folds] : [];
	const dormant: StoredAnchor[] = existing ? existing.dormant : [];
	let touched = false;

	for (const effect of tr.effects) {
		if (effect.is(foldEffect)) {
			// G1: a fold adds an entry to the map. `FoldDescriptor` is a plain, JSON-safe object
			// (text/kind/indent); `StoredAnchor` is deliberately typed as an opaque
			// `Record<string, unknown>` by PR-1 so it has no index signature to match against —
			// the cast is just satisfying that intentional opacity, not discarding type safety.
			folds.push(describeFold(tr.startState, effect.value) as unknown as StoredAnchor);
			touched = true;
		} else if (effect.is(unfoldEffect)) {
			// G1: an unfold removes it. Identical folded lines (duplicate headings, repeated
			// task text) are matched in array order; pairing them by sibling index is PR-3/4's
			// job, not this PR's.
			const descriptor = describeFold(tr.startState, effect.value);
			const index = folds.findIndex((stored) => sameDescriptor(descriptor, stored));
			if (index !== -1) folds.splice(index, 1);
			touched = true;
		}
	}

	if (!touched) return;

	// Each recorded fold or unfold also stores the note's current content hash, so a later PR
	// (PR-7) can tell whether the file changed while Obsidian was closed.
	store.set(path, { contentHash: hashText(tr.state.doc.toString()), folds, dormant });
}
