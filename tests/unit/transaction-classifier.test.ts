/**
 * E11's table: every transaction shape the classifier (src/transaction-classifier.ts) must tell
 * apart. Built directly against real `@codemirror/state`, not a hand-rolled stand-in, so the
 * `Transaction.userEvent` annotation and `docChanged` behave exactly as CM6 itself defines them.
 */
import { describe, expect, it } from "vitest";
import { Annotation, EditorState, Transaction } from "@codemirror/state";
import { foldEffect } from "@codemirror/language";
import { classifyTransaction } from "../../src/transaction-classifier";

function baseState(doc = "one\ntwo\nthree"): EditorState {
	return EditorState.create({ doc });
}

describe("classifyTransaction: E11 table", () => {
	it("typing (input.type) is a user change", () => {
		const state = baseState();
		const tr = state.update({
			changes: { from: 0, to: 0, insert: "x" },
			annotations: Transaction.userEvent.of("input.type"),
		});
		expect(classifyTransaction(tr)).toBe("user");
	});

	it("undo is a user change", () => {
		const state = baseState();
		const tr = state.update({
			changes: { from: 0, to: 3, insert: "ONE" },
			annotations: Transaction.userEvent.of("undo"),
		});
		expect(classifyTransaction(tr)).toBe("user");
	});

	it("redo is a user change", () => {
		const state = baseState();
		const tr = state.update({
			changes: { from: 0, to: 3, insert: "ONE" },
			annotations: Transaction.userEvent.of("redo"),
		});
		expect(classifyTransaction(tr)).toBe("user");
	});

	it("paste (input.paste) is a user change", () => {
		const state = baseState();
		const tr = state.update({
			changes: { from: 0, to: 0, insert: "pasted text" },
			annotations: Transaction.userEvent.of("input.paste"),
		});
		expect(classifyTransaction(tr)).toBe("user");
	});

	it("a programmatic dispatch with no annotation at all is a non-user change", () => {
		const state = baseState();
		const tr = state.update({ changes: { from: 0, to: 3, insert: "ONE" } });
		expect(classifyTransaction(tr)).toBe("non-user");
	});

	it("an edit by another plugin that doesn't tag its own transaction is a non-user change", () => {
		// Realistic worst case: a cooperating plugin would tag its own edits, but most
		// third-party code that rewrites the buffer programmatically does not bother — from the
		// classifier's point of view this is indistinguishable from (and handled the same as)
		// an external reload, which is exactly the point: the plugin cannot tell them apart at
		// the CM6 transaction level, and it is safe to treat both the same way (E9/E10).
		const state = baseState();
		const tr = state.update({ changes: { from: 0, to: 0, insert: "injected by another plugin" } });
		expect(classifyTransaction(tr)).toBe("non-user");
	});

	it("a transaction with only a selection change is no-change, not non-user", () => {
		const state = baseState();
		const tr = state.update({ selection: { anchor: 1 } });
		expect(tr.docChanged).toBe(false);
		expect(classifyTransaction(tr)).toBe("no-change");
	});

	it("a fold-effect-only transaction (CM6's own fold commands) is no-change, not non-user", () => {
		// This is exactly what CM6's built-in foldCode/foldGutter dispatch: effects only, no
		// document change, no annotation. If this weren't excluded by the docChanged check it
		// would be misclassified as "non-user" and would wrongly retrigger the settle timer.
		const state = baseState();
		const tr = state.update({ effects: [foldEffect.of({ from: 0, to: 3 })] });
		expect(tr.docChanged).toBe(false);
		expect(classifyTransaction(tr)).toBe("no-change");
	});

	it("annotation edge case: a userEvent annotation with an unrecognised custom value is still a user change", () => {
		const state = baseState();
		const tr = state.update({
			changes: { from: 0, to: 0, insert: "x" },
			annotations: Transaction.userEvent.of("some-other-plugin.custom-event"),
		});
		expect(classifyTransaction(tr)).toBe("user");
	});

	it("annotation edge case: other annotations present but no userEvent is still non-user", () => {
		const addInfo = Annotation.define<string>();
		const state = baseState();
		const tr = state.update({
			changes: { from: 0, to: 0, insert: "x" },
			annotations: addInfo.of("some metadata"),
		});
		expect(tr.annotation(Transaction.userEvent)).toBeUndefined();
		expect(classifyTransaction(tr)).toBe("non-user");
	});
});
