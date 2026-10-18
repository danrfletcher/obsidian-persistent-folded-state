/**
 * E6: a 600-fold document — more than `MAX_FOLDS` (500) — still restores correctly up to the
 * cap, the matcher's chunked yielding actually happens (not just a paper no-op default), and a
 * keystroke dispatched mid-match is handled immediately rather than blocked behind it. Real
 * `EditorState`/`EditorView` through the plugin's own extension, same shape as
 * tests/integration/restore-cm6.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import type { FileFoldRecord } from "../../src/types";

const NOTE_PATH = "Large.md";
const HEADING_COUNT = 600;

function headingLines(suffix: string): string[] {
	const lines: string[] = [];
	for (let i = 1; i <= HEADING_COUNT; i++) {
		lines.push(`## Heading ${i} ${suffix}`, `body for ${i}`);
	}
	return lines;
}

const BEFORE = headingLines("original").join("\n");
// Every heading is reworded (forces the positional tier, not the no-comparison exact tier) but
// stays at the same sibling index/indent, so each one still has exactly one eligible candidate.
const AFTER = headingLines("renamed").join("\n");

function storedAnchorsSeed(): Record<string, unknown>[] {
	const anchors: Record<string, unknown>[] = [];
	for (let i = 1; i <= HEADING_COUNT; i++) {
		anchors.push({ kind: "heading", indent: 0, text: `heading ${i} original`, siblingIndex: i - 1, parentChain: [] });
	}
	return anchors;
}

async function makeStore(seed: Record<string, FileFoldRecord>): Promise<FoldStore> {
	let stored: unknown = { version: 1, files: seed };
	const store = new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data;
		},
	});
	await store.load();
	return store;
}

function makeView(store: FoldStore, doc: string, matcherOptions?: Parameters<typeof createEditorWatcher>[0]["matcherOptions"]): EditorView {
	const watcher = createEditorWatcher({ store, window, matcherOptions });
	const state = EditorState.create({
		doc,
		selection: { anchor: 0 },
		extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
	});
	return new EditorView({ state, parent: document.body });
}

function liveFoldedLineRanges(view: EditorView): { startLine: number; endLine: number }[] {
	const ranges: { startLine: number; endLine: number }[] = [];
	foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
		ranges.push({ startLine: view.state.doc.lineAt(from).number, endLine: view.state.doc.lineAt(to).number });
	});
	return ranges;
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 500));
}

describe("restore-large (E6): a 600-fold document", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("folds up to the 500-anchor cap and yields between chunks while doing it", async () => {
		const seed: Record<string, FileFoldRecord> = { [NOTE_PATH]: { contentHash: "x", folds: storedAnchorsSeed(), dormant: [] } };
		const store = await makeStore(seed);

		let yieldCount = 0;
		const view = makeView(store, BEFORE, {
			yieldToHost: () => {
				yieldCount++;
				return new Promise((resolve) => window.setTimeout(resolve, 0));
			},
		});

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: AFTER },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: 0 }, // line 1, inside heading 1's own range; moved below once folded
		});

		await settle();

		const folded = liveFoldedLineRanges(view);
		// At most 500 folds (E6's cap); every one of them is one of the first 500 headings
		// (cappedCount processes stored anchors in order), never the 501st-600th.
		expect(folded.length).toBeLessThanOrEqual(500);
		expect(folded.length).toBeGreaterThan(0);
		for (const range of folded) {
			const headingNumber = Math.ceil(range.startLine / 2);
			expect(headingNumber).toBeLessThanOrEqual(500);
		}
		// Yielding actually happened — not just the pure module's own no-op default — proving
		// E6's "run in yielded chunks" is wired to a real scheduler here, not only specified.
		expect(yieldCount).toBeGreaterThan(0);
	}, 10000);

	it("a keystroke dispatched mid-match is applied immediately, not blocked behind the chunked loop", async () => {
		const seed: Record<string, FileFoldRecord> = { [NOTE_PATH]: { contentHash: "x", folds: storedAnchorsSeed(), dormant: [] } };
		const store = await makeStore(seed);

		let keystrokeDispatched = false;
		let keystrokeAppliedImmediately = false;
		const view = makeView(store, BEFORE, {
			yieldToHost: () => {
				if (!keystrokeDispatched) {
					keystrokeDispatched = true;
					// Simulates the user typing while the match is still chunking through the
					// large anchor set — a real dispatch to the same view, not a stub.
					view.dispatch({ changes: { from: 0, to: 0, insert: "X" }, annotations: Transaction.userEvent.of("input.type") });
					keystrokeAppliedImmediately = view.state.doc.toString().startsWith("X");
				}
				return new Promise((resolve) => window.setTimeout(resolve, 0));
			},
		});

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: AFTER },
			annotations: Transaction.userEvent.of("set"),
		});

		await settle();

		expect(keystrokeDispatched).toBe(true); // sanity: the mid-match hook actually ran
		expect(keystrokeAppliedImmediately).toBe(true);
		// The keystroke changed the document after the text the match was run against was
		// captured, so that (now-stale) match correctly dispatches nothing at all (E9: a newer
		// settle — for the post-keystroke text — is what should run instead, not this one).
		expect(liveFoldedLineRanges(view)).toEqual([]);
	}, 10000);
});
