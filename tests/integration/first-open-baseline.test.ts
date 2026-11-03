/**
 * E5/G15 (first-open baseline), run against the real CM6 pipeline: a brand-new `EditorView`
 * constructed with folds already baked into its initial `EditorState` (via `state.update()`,
 * never `view.dispatch`), so the `ViewPlugin`'s own constructor-time check
 * (src/editor-watcher.ts) sees them before any transaction happens at all.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { makeGuardRig, type GuardRig } from "../guard-rig";
import { FoldStore, hashText } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import { restoreSettledChange } from "../../src/fold-restorer";
import { buildAnchors, anchorKey, type Anchor } from "../../src/anchors";
import type { DiagnosticEntry } from "../../src/diagnostic-log";

const NOTE_PATH = "Projects/Quarry/Tasks.md";
const TEXT = "## Tuesday\n- [ ] Draft proposal\n  - [ ] Sub task\n- [ ] Send invoices\n";

async function makeStore(): Promise<FoldStore> {
	let stored: unknown = { version: 1, files: {} };
	const store = new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data;
		},
	});
	await store.load();
	return store;
}

/** End of line `n` to end of line `n` in `text` (1-indexed), i.e. a single-line span — used to
 * build the "end of first line -> end of last line" fold range src/fold-restorer.ts's own
 * `foldEffectFor` convention uses, from PR-3 anchor line numbers. */
function lineEnd(text: string, n: number): number {
	const lines = text.split("\n");
	let offset = 0;
	for (let i = 0; i < n - 1; i++) offset += lines[i].length + 1;
	return offset + lines[n - 1].length;
}

/** Builds an `EditorView` whose *initial* state already has `foldedRanges` applied via
 * `state.update()` — a pure state transform, no view, no transaction ever dispatched to a view
 * — then attaches the real editor watcher. A `dispatch` spy on the resulting view proves the
 * watcher's own first-open baseline path never calls `view.dispatch` itself. */
function makeViewWithLiveFolds(
	store: FoldStore,
	foldRanges: { from: number; to: number }[],
): { view: EditorView; dispatchSpy: ReturnType<typeof vi.fn> } {
	const watcher = createEditorWatcher({ store, window });
	let state = EditorState.create({
		doc: TEXT,
		extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
	});
	if (foldRanges.length > 0) {
		const tr = state.update({ effects: foldRanges.map((r) => foldEffect.of(r)) });
		state = tr.state;
	}
	const view = new EditorView({ state, parent: document.body });
	const dispatchSpy = vi.spyOn(view, "dispatch");
	return { view, dispatchSpy };
}

describe("first-open baseline (E5/G15)", () => {
	afterEach(() => {
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it("adopts two already-folded blocks as the baseline, dispatches nothing, and a second open does not re-baseline", async () => {
		const blocks = buildAnchors(TEXT);
		const tuesday = blocks.find((b) => b.anchor.kind === "heading" && b.anchor.text === "tuesday");
		const draftProposal = blocks.find((b) => b.anchor.kind === "task" && b.anchor.text === "draft proposal");
		expect(tuesday).toBeDefined();
		expect(draftProposal).toBeDefined();

		const tuesdayRange = { from: lineEnd(TEXT, tuesday!.range.startLine), to: lineEnd(TEXT, tuesday!.range.endLine) };
		const draftRange = { from: lineEnd(TEXT, draftProposal!.range.startLine), to: lineEnd(TEXT, draftProposal!.range.endLine) };

		const store = await makeStore();
		expect(store.get(NOTE_PATH)).toBeUndefined();

		const { view, dispatchSpy } = makeViewWithLiveFolds(store, [tuesdayRange, draftRange]);

		// G15/E5: baseline adoption happens synchronously in the ViewPlugin constructor — no
		// microtask/timer wait needed, and it never dispatches.
		expect(dispatchSpy).not.toHaveBeenCalled();

		const record = store.get(NOTE_PATH);
		expect(record).toBeDefined();
		expect(record?.contentHash).toBe(hashText(TEXT));
		const storedKeys = (record?.folds ?? []).map((raw) => anchorKey(raw as unknown as Anchor)).sort();
		expect(storedKeys).toEqual([anchorKey(tuesday!.anchor), anchorKey(draftProposal!.anchor)].sort());
		expect(record?.dormant).toEqual([]);

		// A second "open" (a second ViewPlugin instance for the same path, e.g. a second pane)
		// must not re-baseline: the store already has an entry.
		const beforeSecondOpen = store.get(NOTE_PATH);
		const second = makeViewWithLiveFolds(store, []); // no live folds this time
		expect(store.get(NOTE_PATH)).toEqual(beforeSecondOpen);

		view.destroy();
		second.view.destroy();
	});

	it("a file opened with zero live folds is stored as an empty baseline entry (G15), not left with no entry at all", async () => {
		const store = await makeStore();
		const { view, dispatchSpy } = makeViewWithLiveFolds(store, []);

		expect(dispatchSpy).not.toHaveBeenCalled();
		expect(store.get(NOTE_PATH)).toEqual({ contentHash: hashText(TEXT), folds: [], dormant: [] });

		view.destroy();
	});

	it("T20: a live fold applied via a state reset (setState) that recordFoldEffects can't observe is still merged in by the grace recheck", async () => {
		// setState — unlike dispatch — never fires an `update()` call at all for an
		// already-attached ViewPlugin (verified separately: `EditorView.updateListener`
		// never sees it), so `src/fold-recorder.ts`'s own `recordFoldEffects` — which only
		// ever runs from inside `update()` — can never observe a fold applied this way. This
		// isolates the grace recheck this fix adds (src/editor-watcher.ts's
		// `scheduleFirstOpenGraceRecheck`, which re-reads `view.state` directly rather than
		// listening for transactions) from that pre-existing, unrelated safety net, and
		// stands in for whatever real-Obsidian mechanism T20 describes applying a fold the
		// constructor's own synchronous read missed without ever dispatching a transaction
		// our own `update()` would see.
		vi.useFakeTimers();
		try {
			const blocks = buildAnchors(TEXT);
			const tuesday = blocks.find((b) => b.anchor.kind === "heading" && b.anchor.text === "tuesday");
			const draftProposal = blocks.find((b) => b.anchor.kind === "task" && b.anchor.text === "draft proposal");
			expect(tuesday).toBeDefined();
			expect(draftProposal).toBeDefined();

			const draftRange = {
				from: lineEnd(TEXT, draftProposal!.range.startLine),
				to: lineEnd(TEXT, draftProposal!.range.endLine),
			};
			const tuesdayRange = { from: lineEnd(TEXT, tuesday!.range.startLine), to: lineEnd(TEXT, tuesday!.range.endLine) };

			const store = await makeStore();
			const watcher = createEditorWatcher({ store, window, firstOpenGraceMs: 150 });
			const extensions = [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))];

			// Only ONE of the two live folds is visible at the moment the ViewPlugin's
			// constructor runs.
			const state1 = EditorState.create({ doc: TEXT, extensions }).update({ effects: foldEffect.of(tuesdayRange) }).state;
			const view = new EditorView({ state: state1, parent: document.body });

			// The constructor's synchronous read only ever saw `tuesdayRange`.
			const immediatelyAfterOpen = store.get(NOTE_PATH);
			expect(immediatelyAfterOpen).toBeDefined();
			expect((immediatelyAfterOpen?.folds ?? []).length).toBe(1);

			// The second fold lands moments later via a full state reset (setState), well
			// inside the grace window — not a dispatch, so `recordFoldEffects` never runs.
			const state2 = EditorState.create({
				doc: state1.doc,
				selection: state1.selection,
				extensions,
			}).update({ effects: [foldEffect.of(tuesdayRange), foldEffect.of(draftRange)] }).state;
			await vi.advanceTimersByTimeAsync(10);
			view.setState(state2);

			await vi.advanceTimersByTimeAsync(200);

			const record = store.get(NOTE_PATH);
			expect(record?.contentHash).toBe(hashText(TEXT));
			const storedKeys = (record?.folds ?? []).map((raw) => anchorKey(raw as unknown as Anchor)).sort();
			expect(storedKeys).toEqual([anchorKey(tuesday!.anchor), anchorKey(draftProposal!.anchor)].sort());

			view.destroy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("R14: a disposed flag shared through deps stops the grace-recheck timer from writing to the store once the plugin has unloaded", async () => {
		vi.useFakeTimers();
		try {
			const blocks = buildAnchors(TEXT);
			const tuesday = blocks.find((b) => b.anchor.kind === "heading" && b.anchor.text === "tuesday");
			const draftProposal = blocks.find((b) => b.anchor.kind === "task" && b.anchor.text === "draft proposal");
			expect(tuesday).toBeDefined();
			expect(draftProposal).toBeDefined();

			const draftRange = {
				from: lineEnd(TEXT, draftProposal!.range.startLine),
				to: lineEnd(TEXT, draftProposal!.range.endLine),
			};
			const tuesdayRange = { from: lineEnd(TEXT, tuesday!.range.startLine), to: lineEnd(TEXT, tuesday!.range.endLine) };

			const store = await makeStore();
			const setSpy = vi.spyOn(store, "set");
			const disposed = { current: false };
			const watcher = createEditorWatcher({ store, window, firstOpenGraceMs: 150, disposed });
			const extensions = [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))];

			// Only ONE of the two live folds is visible at construction time — exactly the
			// T20 case the grace recheck exists to catch.
			const state1 = EditorState.create({ doc: TEXT, extensions }).update({ effects: foldEffect.of(tuesdayRange) }).state;
			const view = new EditorView({ state: state1, parent: document.body });

			expect(setSpy).toHaveBeenCalledTimes(1); // the synchronous baseline adoption only

			// The second fold lands moments later via setState, exactly as the T20 test above —
			// this would, if the timer ran its normal merge, pick it up. But main.ts's
			// `onunload()` has set the shared `disposed` flag in between (simulating the plugin
			// being disabled inside the grace window), so R14 says the timer must become a
			// no-op instead.
			const state2 = EditorState.create({
				doc: state1.doc,
				selection: state1.selection,
				extensions,
			}).update({ effects: [foldEffect.of(tuesdayRange), foldEffect.of(draftRange)] }).state;
			await vi.advanceTimersByTimeAsync(10);
			view.setState(state2);
			disposed.current = true;

			await vi.advanceTimersByTimeAsync(200);

			// No further write happened: the stored record still only has the one anchor the
			// synchronous constructor-time read captured.
			expect(setSpy).toHaveBeenCalledTimes(1);
			const record = store.get(NOTE_PATH);
			const storedKeys = (record?.folds ?? []).map((raw) => anchorKey(raw as unknown as Anchor)).sort();
			expect(storedKeys).toEqual([anchorKey(tuesday!.anchor)]);

			view.destroy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("R14: a pane that navigates to a different file with identical text before the grace recheck fires never merges into the original file's entry", async () => {
		vi.useFakeTimers();
		try {
			const OTHER_PATH = "Projects/Quarry/Other.md";
			const blocks = buildAnchors(TEXT);
			const tuesday = blocks.find((b) => b.anchor.kind === "heading" && b.anchor.text === "tuesday");
			const draftProposal = blocks.find((b) => b.anchor.kind === "task" && b.anchor.text === "draft proposal");
			expect(tuesday).toBeDefined();
			expect(draftProposal).toBeDefined();

			const draftRange = {
				from: lineEnd(TEXT, draftProposal!.range.startLine),
				to: lineEnd(TEXT, draftProposal!.range.endLine),
			};
			const tuesdayRange = { from: lineEnd(TEXT, tuesday!.range.startLine), to: lineEnd(TEXT, tuesday!.range.endLine) };

			const store = await makeStore();
			const watcher = createEditorWatcher({ store, window, firstOpenGraceMs: 150 });
			const extensionsForNote = [
				codeFolding(),
				watcher,
				editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } })),
			];

			const state1 = EditorState.create({ doc: TEXT, extensions: extensionsForNote }).update({
				effects: foldEffect.of(tuesdayRange),
			}).state;
			const view = new EditorView({ state: state1, parent: document.body });

			const immediatelyAfterOpen = store.get(NOTE_PATH);
			expect((immediatelyAfterOpen?.folds ?? []).length).toBe(1);

			// Obsidian reuses this same pane for a *different* note, OTHER_PATH, whose text
			// happens to be identical to TEXT (e.g. two notes seeded from the same template),
			// with the second fold also live — all within the grace window. This must not be
			// mistaken for "the same file, now with another fold captured".
			const extensionsForOther = [
				codeFolding(),
				watcher,
				editorInfoField.init(() => ({ file: { path: OTHER_PATH, extension: "md" } })),
			];
			const state2 = EditorState.create({
				doc: state1.doc,
				selection: state1.selection,
				extensions: extensionsForOther,
			}).update({ effects: [foldEffect.of(tuesdayRange), foldEffect.of(draftRange)] }).state;
			await vi.advanceTimersByTimeAsync(10);
			view.setState(state2);

			await vi.advanceTimersByTimeAsync(200);

			// NOTE_PATH's own entry is untouched by the stale recheck — still just the one
			// anchor from the original synchronous read, not merged with the second fold that
			// was only ever live for OTHER_PATH.
			const record = store.get(NOTE_PATH);
			const storedKeys = (record?.folds ?? []).map((raw) => anchorKey(raw as unknown as Anchor)).sort();
			expect(storedKeys).toEqual([anchorKey(tuesday!.anchor)]);

			view.destroy();
		} finally {
			vi.useRealTimers();
		}
	});

	it("T22: a live fold narrower than its candidate by a trailing blank separator line is still merged by the grace recheck", async () => {
		// A click-folded list item only ever covers its own content — it has no notion of the
		// blank separator line `buildAnchors`' closeFramesAbove swallows into the block's own
		// candidate range when a blank line sits between it and its next sibling (T22). This is
		// the real-Obsidian shape tests/fixtures/tasks-before.md's "Plain list item" (lines 14-15
		// live vs 14-16 candidate) exercised against the real container.
		const TEXT_T22 = "## Tuesday\n\n- Plain list item\n	- A nested list item\n\n- [ ] Draft proposal\n	- [ ] Sub task\n";
		vi.useFakeTimers();
		try {
			const blocks = buildAnchors(TEXT_T22);
			const listItem = blocks.find((b) => b.anchor.kind === "list" && b.anchor.text === "plain list item");
			const draftProposal = blocks.find((b) => b.anchor.kind === "task" && b.anchor.text === "draft proposal");
			expect(listItem).toBeDefined();
			expect(draftProposal).toBeDefined();
			expect(listItem!.range).toEqual({ startLine: 3, endLine: 5 }); // swallows the blank line (4->5)

			const draftRange = {
				from: lineEnd(TEXT_T22, draftProposal!.range.startLine),
				to: lineEnd(TEXT_T22, draftProposal!.range.endLine),
			};
			// What CM6 actually reports for a direct click-fold on the list item: through its
			// nested child's own line (4), not the trailing blank separator (5).
			const narrowListRange = { from: lineEnd(TEXT_T22, listItem!.range.startLine), to: lineEnd(TEXT_T22, 4) };

			const store = await makeStore();
			const watcher = createEditorWatcher({ store, window, firstOpenGraceMs: 150 });
			const extensions = [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))];

			// Only the task's fold is visible at the moment the ViewPlugin's constructor runs.
			const state1 = EditorState.create({ doc: TEXT_T22, extensions }).update({ effects: foldEffect.of(draftRange) }).state;
			const view = new EditorView({ state: state1, parent: document.body });

			const immediatelyAfterOpen = store.get(NOTE_PATH);
			expect((immediatelyAfterOpen?.folds ?? []).length).toBe(1);

			// The list item's (narrower) fold lands moments later via a full state reset, well
			// inside the grace window.
			const state2 = EditorState.create({
				doc: state1.doc,
				selection: state1.selection,
				extensions,
			}).update({ effects: [foldEffect.of(narrowListRange), foldEffect.of(draftRange)] }).state;
			await vi.advanceTimersByTimeAsync(10);
			view.setState(state2);

			await vi.advanceTimersByTimeAsync(200);

			const record = store.get(NOTE_PATH);
			expect(record?.contentHash).toBe(hashText(TEXT_T22));
			const storedKeys = (record?.folds ?? []).map((raw) => anchorKey(raw as unknown as Anchor)).sort();
			expect(storedKeys).toEqual([anchorKey(draftProposal!.anchor), anchorKey(listItem!.anchor)].sort());

			view.destroy();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("first-open baseline writes are logged (PR-1 R1)", () => {
	afterEach(() => {
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it("the watcher's own baseline (no load guard) logs one `baseline` / `applied` line with the counts it stored", async () => {
		const blocks = buildAnchors(TEXT);
		const tuesday = blocks.find((b) => b.anchor.kind === "heading" && b.anchor.text === "tuesday")!;
		const range = { from: lineEnd(TEXT, tuesday.range.startLine), to: lineEnd(TEXT, tuesday.range.endLine) };
		const store = await makeStore();
		const seen: DiagnosticEntry[] = [];
		const watcher = createEditorWatcher({ store, window, diagnosticLog: (entry) => seen.push(entry) });
		const state = EditorState.create({
			doc: TEXT,
			extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
		}).update({ effects: [foldEffect.of(range)] }).state;
		const view = new EditorView({ state, parent: document.body });

		expect(seen).toEqual([
			{ path: NOTE_PATH, pass: "baseline", editorLen: TEXT.length, diskLen: -1, foldsBefore: 0, dormantBefore: 0, foldsAfter: 1, dormantAfter: 0, outcome: "applied" },
		]);
		// A second pane for the same note adopts nothing and logs nothing.
		new EditorView({ state, parent: document.body });
		expect(seen).toHaveLength(1);
		view.destroy();
	});

	it("an empty-editor baseline (no load guard, the E18 shape) is logged with editorLen 0", async () => {
		const store = await makeStore();
		const seen: DiagnosticEntry[] = [];
		const watcher = createEditorWatcher({ store, window, diagnosticLog: (entry) => seen.push(entry) });
		const state = EditorState.create({
			doc: "",
			extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
		});
		new EditorView({ state, parent: document.body });
		expect(seen.map((e) => [e.pass, e.outcome, e.editorLen])).toEqual([["baseline", "applied", 0]]);
	});

	it("restoreSettledChange's no-entry branch logs the baseline it writes, with the disk length from the guard", async () => {
		const store = await makeStore();
		const seen: DiagnosticEntry[] = [];
		const view = new EditorView({
			state: EditorState.create({ doc: TEXT, extensions: [codeFolding()] }),
			parent: document.body,
		});
		await restoreSettledChange(view, NOTE_PATH, TEXT, { store, getActivePath: () => NOTE_PATH, diagnosticLog: (entry) => seen.push(entry) });
		expect(store.get(NOTE_PATH)).toEqual({ contentHash: hashText(TEXT), folds: [], dormant: [] });
		expect(seen).toEqual([
			{ path: NOTE_PATH, pass: "baseline", editorLen: TEXT.length, diskLen: -1, foldsBefore: 0, dormantBefore: 0, foldsAfter: 0, dormantAfter: 0, outcome: "applied" },
		]);
	});

	it("restoreSettledChange's no-entry branch behind the guard logs the real disk length", async () => {
		vi.useFakeTimers();
		try {
			const rig = makeGuardRig();
			rig.vault.setContent(NOTE_PATH, TEXT);
			const store = await makeStore();
			const view = new EditorView({
				state: EditorState.create({ doc: TEXT, extensions: [codeFolding(), editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))] }),
				parent: document.body,
			});
			await restoreSettledChange(view, NOTE_PATH, TEXT, {
				store,
				getActivePath: () => NOTE_PATH,
				diagnosticLog: rig.watcherDeps.diagnosticLog,
				loadGuard: {
					gate: rig.gate,
					makeIo: () => ({ ...rig.watcherDeps.loadGuard!.makeIo(view, NOTE_PATH), paneFilePath: () => NOTE_PATH }),
					rerun: () => {},
				},
			});
			const lines = await rig.lines();
			expect(lines.map((l) => [l.pass, l.outcome])).toEqual([["baseline", "applied"]]);
			expect(lines[0]).toMatchObject({ editorLen: TEXT.length, diskLen: TEXT.length });
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("first-open baseline behind the load guard (PR-3, E18)", () => {
	const MARKER_TEXT = "## Tuesday\n- [ ] BASELINE-GUARD-MARKER draft\n  - [ ] Sub task\n";

	afterEach(() => {
		document.body.replaceChildren();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** A `window` whose timers are real but recorded, so a test can tell whether a timer was scheduled. */
	function recordingWindow(): { win: Window; scheduled: number[] } {
		const scheduled: number[] = [];
		const win = {
			setTimeout: (fn: () => void, ms?: number) => {
				scheduled.push(ms ?? 0);
				return window.setTimeout(fn, ms);
			},
			clearTimeout: (handle?: number) => window.clearTimeout(handle),
		} as unknown as Window;
		return { win, scheduled };
	}

	function guardedView(rig: GuardRig, store: FoldStore, doc: string, win: Window, firstOpenGraceMs = 150): EditorView {
		const watcher = createEditorWatcher({ store, ...rig.watcherDeps, window: win, firstOpenGraceMs });
		const state = EditorState.create({
			doc,
			extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
		});
		return new EditorView({ state, parent: document.body });
	}

	const GRACE_MS = 777; // distinctive, so it can be told from every other timer in the watcher

	it("E18: an empty editor over a non-empty file adopts no baseline, stores nothing, schedules no grace recheck; the real text then gets one", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, MARKER_TEXT);
		const store = await makeStore();
		const setSpy = vi.spyOn(store, "set");
		const { win, scheduled } = recordingWindow();
		const view = guardedView(rig, store, "", win, GRACE_MS);

		await vi.advanceTimersByTimeAsync(2000);
		expect(setSpy).not.toHaveBeenCalled();
		expect(store.get(NOTE_PATH)).toBeUndefined(); // no hashText("") entry
		expect(scheduled).not.toContain(GRACE_MS);
		expect(rig.gate.isHolding(view)).toBe(true);
		let lines = await rig.lines();
		expect(lines.map((l) => [l.pass, l.outcome])).toEqual([["baseline", "refused-empty"]]);
		expect(lines[0]).toMatchObject({ path: NOTE_PATH, editorLen: 0, diskLen: MARKER_TEXT.length, foldsBefore: 0, foldsAfter: 0 });

		// The real text lands.
		view.dispatch({ changes: { from: 0, to: 0, insert: MARKER_TEXT }, annotations: Transaction.userEvent.of("set") });
		await vi.advanceTimersByTimeAsync(0);
		expect(store.get(NOTE_PATH)).toEqual({ contentHash: hashText(MARKER_TEXT), folds: [], dormant: [] });
		expect(scheduled).toContain(GRACE_MS); // scheduled only after a real-text baseline
		lines = await rig.lines();
		expect(lines.map((l) => [l.pass, l.outcome])).toEqual([
			["baseline", "refused-empty"],
			["baseline", "applied"],
		]);
		await vi.advanceTimersByTimeAsync(2000);
		expect(store.get(NOTE_PATH)?.contentHash).toBe(hashText(MARKER_TEXT)); // the settled pass that follows finds nothing to change
		view.destroy();
	});

	it("E18: text that does not match the disk (a half-loaded pane) adopts no baseline either", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, MARKER_TEXT);
		const store = await makeStore();
		const setSpy = vi.spyOn(store, "set");
		const { win, scheduled } = recordingWindow();
		const view = guardedView(rig, store, MARKER_TEXT.slice(0, 15), win, GRACE_MS);
		await vi.advanceTimersByTimeAsync(2000);
		expect(setSpy).not.toHaveBeenCalled();
		expect(scheduled).not.toContain(GRACE_MS);
		expect((await rig.lines()).map((l) => [l.pass, l.outcome])).toEqual([["baseline", "waiting"]]);
		view.destroy();
	});

	it("a pane that already holds the disk text gets its baseline after the one disk read, and the grace recheck is scheduled", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, MARKER_TEXT);
		const store = await makeStore();
		const { win, scheduled } = recordingWindow();
		const view = guardedView(rig, store, MARKER_TEXT, win, GRACE_MS);
		await vi.advanceTimersByTimeAsync(0);
		expect(store.get(NOTE_PATH)).toEqual({ contentHash: hashText(MARKER_TEXT), folds: [], dormant: [] });
		expect(scheduled).toContain(GRACE_MS);
		// Nothing waited, but the baseline is a write to stored data, so it is logged (PR-1 R1).
		const lines = await rig.lines();
		expect(lines.map((l) => [l.pass, l.outcome])).toEqual([["baseline", "applied"]]);
		expect(lines[0]).toMatchObject({ path: NOTE_PATH, editorLen: MARKER_TEXT.length, diskLen: MARKER_TEXT.length, foldsBefore: 0, dormantBefore: 0, foldsAfter: 0, dormantAfter: 0 });
		view.destroy();
	});

	it("E6: a file that really is empty gets a baseline from the empty editor (a real change), with no grace recheck to run", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, "");
		const store = await makeStore();
		const { win, scheduled } = recordingWindow();
		const view = guardedView(rig, store, "", win, GRACE_MS);
		await vi.advanceTimersByTimeAsync(0);
		expect(store.get(NOTE_PATH)).toEqual({ contentHash: hashText(""), folds: [], dormant: [] });
		expect(scheduled).not.toContain(GRACE_MS); // an empty text has nothing to merge against
		// PR-1 R1: an empty-editor baseline is the E18 failure mode, so this one is always in the log.
		const lines = await rig.lines();
		expect(lines.map((l) => [l.pass, l.outcome])).toEqual([["baseline", "applied"]]);
		expect(lines[0]).toMatchObject({ editorLen: 0, diskLen: 0 });
		view.destroy();
	});

	it("E18 (no-entry branch of restoreSettledChange): an empty pane over a non-empty file creates no entry; once the text is real, whichever pass runs first wins and the other is a no-op", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, MARKER_TEXT);
		const store = await makeStore();
		const setSpy = vi.spyOn(store, "set");
		const { win } = recordingWindow();
		const view = guardedView(rig, store, "", win);
		await vi.advanceTimersByTimeAsync(0);

		// The settled pass is asked about the empty text directly: no `buildBaseline`, no entry.
		const result = await restoreSettledChange(view, NOTE_PATH, "", {
			store,
			getActivePath: () => NOTE_PATH,
			loadGuard: { gate: rig.gate, makeIo: () => rig.watcherDeps.loadGuard!.makeIo(view, NOTE_PATH), rerun: () => {} },
		});
		expect(result).toEqual([]);
		expect(setSpy).not.toHaveBeenCalled();

		view.dispatch({ changes: { from: 0, to: 0, insert: MARKER_TEXT }, annotations: Transaction.userEvent.of("set") });
		await vi.advanceTimersByTimeAsync(2000);
		const stored = store.get(NOTE_PATH);
		expect(stored?.contentHash).toBe(hashText(MARKER_TEXT));
		expect(stored?.dormant).toEqual([]);
		// Every write was for the real text.
		for (const call of setSpy.mock.calls) expect((call[1] as { contentHash: string }).contentHash).toBe(hashText(MARKER_TEXT));
		view.destroy();
	});

	it("E8: the user typing into a pane that never loaded ends the baseline wait; an emptied pane is still refused", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, MARKER_TEXT);
		const store = await makeStore();
		const { win } = recordingWindow();
		const view = guardedView(rig, store, "", win);
		await vi.advanceTimersByTimeAsync(0);
		view.dispatch({ changes: { from: 0, to: 0, insert: "x" }, annotations: Transaction.userEvent.of("input.type") });
		await vi.advanceTimersByTimeAsync(0);
		expect(store.get(NOTE_PATH)).toEqual({ contentHash: hashText("x"), folds: [], dormant: [] }); // from then on the pane's own text is used
		view.destroy();

		const rig2 = makeGuardRig();
		rig2.vault.setContent(NOTE_PATH, MARKER_TEXT);
		const store2 = await makeStore();
		const view2 = guardedView(rig2, store2, "", win);
		await vi.advanceTimersByTimeAsync(0);
		view2.dispatch({ changes: { from: 0, to: 0, insert: "x" }, annotations: Transaction.userEvent.of("input.type") });
		view2.dispatch({ changes: { from: 0, to: 1, insert: "" }, annotations: Transaction.userEvent.of("delete.backward") });
		await vi.advanceTimersByTimeAsync(0);
		expect(store2.get(NOTE_PATH)).toBeUndefined(); // never a baseline from ""
		expect((await rig2.lines()).map((l) => l.outcome)).toContain("refused-empty");
		view2.destroy();
	});

	it("E12: a disk read that fails adopts no baseline and writes one read-failed line", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, MARKER_TEXT);
		rig.vault.failReadsOf(NOTE_PATH);
		const store = await makeStore();
		const setSpy = vi.spyOn(store, "set");
		const { win } = recordingWindow();
		const view = guardedView(rig, store, MARKER_TEXT, win);
		await vi.advanceTimersByTimeAsync(2000);
		expect(setSpy).not.toHaveBeenCalled();
		expect((await rig.lines()).map((l) => [l.pass, l.outcome])).toEqual([["baseline", "read-failed"]]);
		view.destroy();
	});

	it("the log holds no note text", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, MARKER_TEXT);
		const store = await makeStore();
		const { win } = recordingWindow();
		const view = guardedView(rig, store, "", win);
		await vi.advanceTimersByTimeAsync(0);
		view.dispatch({ changes: { from: 0, to: 0, insert: MARKER_TEXT }, annotations: Transaction.userEvent.of("set") });
		await vi.advanceTimersByTimeAsync(2000);
		const raw = await rig.raw();
		expect(raw).not.toBe("");
		for (const secret of ["BASELINE-GUARD-MARKER", "Tuesday", "Sub task", "draft"]) expect(raw).not.toContain(secret);
		view.destroy();
	});
});
