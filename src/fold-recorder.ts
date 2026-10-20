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
 */
import { Annotation } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import { foldEffect, unfoldEffect } from "@codemirror/language";
import type { StoredAnchor } from "./types";
import type { FoldStore } from "./fold-store";
import { hashText } from "./fold-store";
import { anchorKey, parseAnchor } from "./anchors";
import { describeFold } from "./describe-fold";

/** PR-5 (restoring folds) tags every transaction it dispatches to re-apply a fold with this
 * annotation (see src/fold-restorer.ts), so this recorder never mistakes that re-apply for a
 * fresh user fold (E11: "The plugin tags its own fold effects ... so the recorder never stores them as user
 * folds"). Tagging the whole transaction rather than each individual effect is enough in
 * practice: every fold/unfold effect a restore dispatches arrives in the same transaction it
 * tags, and nothing in this PR ever mixes a restore effect with a genuine user fold in one
 * dispatch. Exported so that future PR can dispatch with `annotations: OWN_FOLD_ANNOTATION.of(true)`. */
export const OWN_FOLD_ANNOTATION = Annotation.define<true>();

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

	for (const effect of tr.effects) {
		if (effect.is(foldEffect)) {
			const anchor = describeFold(tr.state, effect.value);
			folds.set(anchorKey(anchor), anchor as unknown as StoredAnchor);
		} else if (effect.is(unfoldEffect)) {
			const anchor = describeFold(tr.state, effect.value);
			folds.delete(anchorKey(anchor));
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
