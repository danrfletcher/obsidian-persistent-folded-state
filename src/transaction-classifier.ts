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

export function classifyTransaction(tr: Transaction): TransactionClass {
	if (!tr.docChanged) return "no-change";
	return tr.annotation(Transaction.userEvent) !== undefined ? "user" : "non-user";
}
