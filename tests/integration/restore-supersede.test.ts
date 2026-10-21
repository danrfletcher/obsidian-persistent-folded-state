/**
 * R9 (PR-5): a restore run that a newer non-user change has superseded resolves to an empty
 * deferred list. It must not overwrite the newer run's own G13 deferred targets when it happens
 * to resolve last (an E6-sized match can take longer than the 150ms settle).
 */
import { afterEach, describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";

const NOTE_PATH = "Tasks.md";
const BEFORE = ["## Quarterly planning review alpha", "body line", "## Other", "more"].join("\n");
const AFTER_1 = ["## Quarterly planning review alphx", "body line", "## Other", "more"].join("\n");
const AFTER_2 = ["## Quarterly planning review alphz", "body line", "## Other", "more"].join("\n");
const ANCHOR = { kind: "heading", indent: 0, text: "quarterly planning review alpha", siblingIndex: 0, parentChain: [] };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("R9: a superseded restore run cannot wipe the newer run's deferred targets", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("the older run resolving last leaves the newer run's G13 deferral intact, so the fold still lands once the cursor leaves", async () => {
		let stored: unknown = { version: 1, files: { [NOTE_PATH]: { contentHash: "x", folds: [ANCHOR], dormant: [] } } };
		const store = new FoldStore({ loadData: async () => stored, saveData: async (d) => void (stored = d) });
		await store.load();

		// The matcher yields after every comparison; the very first yield (run 1's) is held open
		// until the test releases it, every later one resolves at once.
		let releaseFirst: () => void = () => {};
		let yields = 0;
		const yieldToHost = (): Promise<void> => {
			yields++;
			return yields === 1 ? new Promise<void>((resolve) => void (releaseFirst = resolve)) : Promise.resolve();
		};

		const watcher = createEditorWatcher({ store, window, matcherOptions: { chunkSize: 1, yieldToHost } });
		const info = { file: { path: NOTE_PATH, extension: "md" } };
		const cursorInBody = BEFORE.indexOf("body line") + 2;
		const view = new EditorView({
			state: EditorState.create({
				doc: BEFORE,
				selection: { anchor: cursorInBody },
				extensions: [codeFolding(), watcher, editorInfoField.init(() => info)],
			}),
			parent: document.body,
		});
		const folded = (): number => {
			let n = 0;
			foldedRanges(view.state).between(0, view.state.doc.length, () => void n++);
			return n;
		};
		const rewrite = (text: string): void =>
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: text },
				annotations: Transaction.userEvent.of("set"),
				selection: { anchor: text.indexOf("body line") + 2 }, // cursor inside the heading's body
			});

		rewrite(AFTER_1);
		await sleep(250); // run 1 settles and is now parked inside its first yield
		expect(yields).toBe(1);
		rewrite(AFTER_2);
		await sleep(250); // run 2 settles and finishes: cursor inside => deferred, not folded
		expect(folded()).toBe(0);

		releaseFirst(); // run 1 resolves last, superseded, with []
		await sleep(50);

		// Cursor leaves the block: the deferred fold (run 2's) must still be there to apply.
		view.dispatch({ selection: { anchor: view.state.doc.length } });
		await sleep(50);
		expect(folded()).toBe(1);
	});
});
