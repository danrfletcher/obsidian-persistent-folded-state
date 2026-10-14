/**
 * Classifies a CM6 transaction for the editor watcher (src/editor-watcher.ts).
 *
 * The distinction that matters is defined once, precisely, in the ticket plan: a "non-user
 * change" is a document change with no user-event annotation — the signature of an external
 * rewrite (an agent, sync tool or git pull) replacing the buffer underneath the editor, and
 * (realistically) of any other plugin's programmatic edit that doesn't bother tagging its own
 * transactions. A "user change" is a document change that *does* carry a `Transaction.userEvent`
 * annotation: CM6's own interactive commands all set one — typing ("input.type"), paste
 * ("input.paste"), undo ("undo") and redo ("redo") are all deliberate actions the user took, even
 * though undo/redo aren't literally fresh keystrokes.
 *
 * R10/T1 (E10, proven live against real Obsidian — see docs/reload-shape.md): Obsidian's own
 * reaction to an external disk write is not a bare, un-annotated document change — it is a
 * transaction annotated `userEvent: "set"` (CM6's own annotation for `EditorView.setValue`/
 * `dispatch({changes, ...}, {userEvent: "set"})`-style whole-buffer replacement, which is exactly
 * what Obsidian's reload does under the hood). Treating every annotated transaction as "user"
 * therefore missed the one case this whole PR exists to catch. "set" is excluded from the user
 * bucket and classified as "non-user" instead — consistent with E11's intent that another
 * plugin's programmatic buffer replacement (which also goes through `setValue`/userEvent "set"
 * and does not bother tagging itself as this plugin's own effect) is a non-user change, not a
 * user one. No real CM6 *interactive* command (typing, paste, undo, redo, a fold command) ever
 * sets `userEvent` to "set" — that annotation is reserved for programmatic whole-buffer sets.
 *
 * A transaction that doesn't change the document at all — a selection-only change, or a
 * transaction that only carries fold/unfold effects (CM6's own fold commands and the fold
 * gutter's click handler dispatch exactly that: `{ effects: [...] }` with no document change and
 * no annotation at all) — is neither. It is reported as "no-change" rather than being folded into
 * either bucket.
 *
 * Judgement call (PR-2, spec silent on the exact split): "no-change" is kept as its own outcome,
 * distinct from "non-user", specifically so the settle-debounce timer (E9) is only ever driven by
 * an actual document rewrite — never by a bare fold/unfold or a cursor move, both of which would
 * otherwise look identical to "a document change with no annotation" if docChanged weren't
 * checked first.
 */
import { Transaction } from "@codemirror/state";

export type TransactionClass = "user" | "non-user" | "no-change";

/** Obsidian's own external-reload annotation (see the file comment above and
 * docs/reload-shape.md's "External write" section, captured live against real Obsidian 1.14.4):
 * a whole-buffer `setValue`-style replacement, not an interactive user action. */
const NON_USER_EVENTS = new Set(["set"]);

export function classifyTransaction(tr: Transaction): TransactionClass {
	if (!tr.docChanged) return "no-change";
	const userEvent = tr.annotation(Transaction.userEvent);
	if (userEvent === undefined) return "non-user";
	return NON_USER_EVENTS.has(userEvent) ? "non-user" : "user";
}
