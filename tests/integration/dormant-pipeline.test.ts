/**
 * Spec rules for the dormant/baseline pipeline that no other test drives end to end (PR-6 R5),
 * all against the real watcher, store and CM6 view:
 *  (a) the settled-change "no entry" baseline branch — a never-seen file opened in a reused pane;
 *  (b) a dormant anchor 599,999 ms old is still retried (the boundary, through the pipeline);
 *  (c) E9 — rapid writes inside one settle window run one restore, so one dormant retry.
 * (d), the G6 "user folded the same block while the retry ran" case, is covered by the R1 and
 * T3/R6 tests in dormant-restore.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore, hashText } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import { OWN_FOLD_ANNOTATION } from "../../src/fold-recorder";
import { buildAnchors, anchorKey, type Anchor } from "../../src/anchors";
import type { FileFoldRecord } from "../../src/types";

const NOTE_PATH = "Notes/A.md";
const NEW_PATH = "Notes/Never seen.md";
const TEXT_WITH_TUESDAY = "Notes\n\n## Tuesday\n- [ ] Draft proposal\n";
const TEXT_UNRELATED = "Notes\n\n## Zzz Qqq Www Completely Different Heading\n- [ ] Something else entirely\n";

async function makeStore(seed: Record<string, FileFoldRecord>, now: () => number = () => 0): Promise<FoldStore> {
	let stored: unknown = { version: 1, files: seed };
	const store = new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data;
		},
		now,
	});
	await store.load();
	return store;
}

function makeView(store: FoldStore, info: { file: { path: string; extension: string } }, now: () => number, doc: string): EditorView {
	const watcher = createEditorWatcher({ store, window, now });
	const state = EditorState.create({
		doc,
		selection: { anchor: 0 },
		extensions: [codeFolding(), watcher, editorInfoField.init(() => info)],
	});
	return new EditorView({ state, parent: document.body });
}

const set = (view: EditorView, text: string): void =>
	view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: Transaction.userEvent.of("set") });

const folded = (view: EditorView): number => {
	let n = 0;
	foldedRanges(view.state).between(0, view.state.doc.length, () => void n++);
	return n;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const settle = (): Promise<void> => sleep(300);

const tuesdayAnchor = (): Anchor => buildAnchors(TEXT_WITH_TUESDAY).find((b) => b.anchor.text === "tuesday")!.anchor;

describe("dormant/baseline pipeline (PR-6 R5)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("(a) a settled change on a file the store has never seen adopts the live folds as the baseline and dispatches nothing", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [], dormant: [] } });
		const info = { file: { path: NOTE_PATH, extension: "md" } };
		const view = makeView(store, info, () => 0, "Notes\n");

		// The reused pane now shows a note the plugin has never recorded.
		info.file = { path: NEW_PATH, extension: "md" };
		expect(store.get(NEW_PATH)).toBeUndefined();
		set(view, TEXT_WITH_TUESDAY);
		const tuesday = tuesdayAnchor();
		const firstLineEnd = TEXT_WITH_TUESDAY.indexOf("\n## Tuesday") + "\n## Tuesday".length;
		view.dispatch({
			effects: foldEffect.of({ from: firstLineEnd, to: TEXT_WITH_TUESDAY.length - 1 }),
			annotations: OWN_FOLD_ANNOTATION.of(true), // not recorded as a user fold: only the baseline can create the entry
		});
		expect(store.get(NEW_PATH)).toBeUndefined();

		let dispatched = 0;
		const real = view.dispatch.bind(view);
		view.dispatch = ((...args: unknown[]) => {
			dispatched++;
			return (real as (...a: unknown[]) => void)(...args);
		}) as typeof view.dispatch;
		await settle();

		const record = store.get(NEW_PATH);
		expect(record).toBeDefined();
		expect(record!.contentHash).toBe(hashText(TEXT_WITH_TUESDAY));
		expect(record!.folds.map((f) => anchorKey(f as unknown as Anchor))).toEqual([anchorKey(tuesday)]);
		expect(record!.dormant).toEqual([]);
		expect(dispatched).toBe(0); // adopted, never re-applied
		expect(folded(view)).toBe(1);
	});

	it("(b) a dormant anchor 599,999 ms old is still retried through the pipeline (600,000 is the first forgotten)", async () => {
		let clock = 0;
		const store = await makeStore(
			{
				[NOTE_PATH]: {
					contentHash: hashText(TEXT_UNRELATED),
					folds: [],
					dormant: [{ ...tuesdayAnchor(), dormantSince: 0 }] as unknown as Record<string, unknown>[],
				},
			},
			() => clock,
		);
		const view = makeView(store, { file: { path: NOTE_PATH, extension: "md" } }, () => clock, TEXT_UNRELATED);

		clock = 599_999;
		set(view, TEXT_WITH_TUESDAY);
		await settle();

		expect(folded(view)).toBe(1); // retried and refolded
		expect(store.get(NOTE_PATH)?.dormant).toEqual([]);
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);
	});

	it("(c) E9: two rapid writes inside one settle window run one restore — one dormant retry, with the anchor's original dormantSince intact", async () => {
		let nowCalls = 0;
		const store = await makeStore({
			[NOTE_PATH]: {
				contentHash: hashText(TEXT_UNRELATED),
				folds: [],
				dormant: [{ ...tuesdayAnchor(), dormantSince: 5 }] as unknown as Record<string, unknown>[],
			},
		});
		// The watcher reads its clock once per restore run, so the call count is the run count.
		const view = makeView(store, { file: { path: NOTE_PATH, extension: "md" } }, () => (nowCalls++, 10), TEXT_UNRELATED);

		set(view, "Notes\n\n## Another unrelated heading altogether\n");
		await sleep(40);
		set(view, "Notes\n\n## Yet another unrelated heading\n"); // restarts the 150ms settle
		await settle();

		expect(nowCalls).toBe(1);
		const dormant = store.get(NOTE_PATH)?.dormant ?? [];
		expect(dormant).toHaveLength(1);
		expect((dormant[0] as unknown as { dormantSince: number }).dormantSince).toBe(5);
	});

	it("R10: a settled external change to a note with no folds and nothing dormant still refreshes the stored contentHash", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: hashText(TEXT_UNRELATED), folds: [], dormant: [] } });
		const view = makeView(store, { file: { path: NOTE_PATH, extension: "md" } }, () => 0, TEXT_UNRELATED);

		set(view, TEXT_WITH_TUESDAY);
		await settle();

		expect(store.get(NOTE_PATH)).toEqual({ contentHash: hashText(TEXT_WITH_TUESDAY), folds: [], dormant: [] });
	});

	it("R12 (PR-6): the user folding the matched block while the match runs leaves one stored anchor for it, not two", async () => {
		const TEXT_RENAMED = "Notes\n\n## Tuesdays\n- [ ] Draft proposal\n";
		const store = await makeStore({
			[NOTE_PATH]: {
				contentHash: hashText(TEXT_UNRELATED),
				folds: [],
				dormant: [{ ...tuesdayAnchor(), dormantSince: 0 }] as unknown as Record<string, unknown>[],
			},
		});
		// Hold the matcher's first yield open so the user can act in the middle of the match.
		let release: () => void = () => {};
		let yields = 0;
		const yieldToHost = (): Promise<void> => {
			yields++;
			return yields === 1 ? new Promise<void>((resolve) => void (release = resolve)) : Promise.resolve();
		};
		const info = { file: { path: NOTE_PATH, extension: "md" } };
		const watcher = createEditorWatcher({ store, window, now: () => 1, matcherOptions: { chunkSize: 1, yieldToHost } });
		const view = new EditorView({
			state: EditorState.create({
				doc: TEXT_UNRELATED,
				selection: { anchor: 0 },
				extensions: [codeFolding(), watcher, editorInfoField.init(() => info)],
			}),
			parent: document.body,
		});

		set(view, TEXT_RENAMED);
		await sleep(250);
		expect(yields).toBe(1); // the match is in flight

		// The user folds the "## Tuesdays" block now: the recorder stores the anchor for the text as it reads.
		const headingEnd = TEXT_RENAMED.indexOf("\n- [ ]");
		view.dispatch({ effects: foldEffect.of({ from: headingEnd, to: TEXT_RENAMED.length - 1 }) });
		expect(store.get(NOTE_PATH)?.folds.map((f) => (f as unknown as Anchor).text)).toEqual(["tuesdays"]);

		release();
		await sleep(100);

		const record = store.get(NOTE_PATH)!;
		expect(record.folds.map((f) => (f as unknown as Anchor).text)).toEqual(["tuesdays"]); // not also "tuesday"
		expect(record.dormant).toEqual([]);
		expect(folded(view)).toBe(1);

		// So one unfold forgets the block entirely.
		let live: { from: number; to: number } | null = null;
		foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => void (live = { from, to }));
		view.dispatch({ effects: unfoldEffect.of(live!) });
		expect(store.get(NOTE_PATH)?.folds).toEqual([]);
	});
});
