/**
 * The click-only classifier (ticket warkworth-21, PR-4, E3): decides whether one change of an
 * embed's fold arrow was Dan's own action, from the input signals seen around it. Only a change
 * it calls "user" may be recorded (never-break rule 2). It is one unit with the recorder in
 * src/embed-fold-recorder.ts, which collects the signals and acts on the answer.
 *
 * Pure: signals in, a verdict out. No DOM, no Obsidian, no timers, no store.
 *
 * What the real-Obsidian probe recorded (docs/embed-probe.md, "Fold toggle: element, events,
 * state") and how it maps onto the signals:
 *  - A real click on the arrow: pointerdown, mousedown, pointerup, mouseup, click, then the
 *    class change that folds. Signals: `click`, `pointerSequence`, `trusted` all true.
 *  - A scripted click (`el.click()` or a dispatched click event) changes the fold too: the probe
 *    recorded "a synthetic click changed it: yes". The probe does not name a signal that tells it
 *    from a real click apart, so this classifier uses two the platform provides: `trusted` (the
 *    event's `isTrusted`, which a script cannot set) and `pointerSequence` (a real click is
 *    preceded by pointerdown on the same arrow; a scripted `click()` has none). Both must hold. This
 *    choice is not itself probed in real Obsidian: the container pass must confirm that a script
 *    click records nothing and a real click does. It is the fallback signal for Dan to confirm.
 *  - Keyboard activation (Enter or Space on the arrow): a trusted key event on the arrow. The
 *    probe recorded no keyboard path, so this is a precaution: if Obsidian ever lets the arrow be
 *    activated by key, a trusted key press is the user, by the same rule as a pointer click.
 *  - Obsidian's render-time toggle (restoring its own memory on open, a re-render after a source
 *    edit): the class changes with no click and no key at all. Never the user.
 *
 * E3: `renderWindow` (an embed render burst is settling) is accepted and deliberately ignored.
 * A fold or unfold by Dan during a re-render wins and is recorded, because the verdict depends
 * only on the input, never on when the render happens. It is in the signal set so a test can
 * prove that ordering is irrelevant.
 */

/** What was seen around one change of an embed's fold arrow. */
export interface FoldToggleSignals {
	/** A click event reached the arrow. */
	click: boolean;
	/** A pointerdown on the same arrow came shortly before that click (the real-click shape). */
	pointerSequence: boolean;
	/** An Enter or Space key press on the arrow activated it. */
	keyActivation: boolean;
	/** The input event was produced by the platform from a person's input (`Event.isTrusted`),
	 * not dispatched by a script. For a key activation this is the key event's flag. */
	trusted: boolean;
	/** An embed render or re-render was in progress. Does not change the verdict (E3). */
	renderWindow: boolean;
}

export type FoldToggleOrigin = "user" | "not-user";

/**
 * "user" only for a trusted pointer click (a click preceded by a pointer sequence) or a trusted
 * key activation. Everything else, including a bare class change with no input, is "not-user".
 */
export function classifyFoldToggle(signals: FoldToggleSignals): FoldToggleOrigin {
	if (!signals.trusted) return "not-user";
	const pointerClick = signals.click && signals.pointerSequence;
	return pointerClick || signals.keyActivation ? "user" : "not-user";
}
