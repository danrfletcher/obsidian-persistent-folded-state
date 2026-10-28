/**
 * The remaining named edge cases that aren't already covered by restore-cm6/-panes/-cursor/
 * -large/-golden-path: a pane that's switched to a different file between the change and the
 * settle, an empty file / a map entry the matcher can't place, and idempotent re-apply (a
 * fold that's already live isn't re-dispatched) proven against the real CM6 pipeline, not just
 * src/restore-plan.ts's own unit tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges } from "@codemirror/language";
import { MemoryAdapter, editorInfoField } from "../mocks/obsidian";
import { FoldStore, hashText } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import { restoreSettledChange } from "../../src/fold-restorer";
import { DiagnosticLogWriter } from "../../src/diagnostic-log-writer";
import { DIAGNOSTIC_LOG_FIELDS, logLines, type DiagnosticEntry } from "../../src/diagnostic-log";
import type { FileFoldRecord } from "../../src/types";
import { makeGuardRig, type GuardRig } from "../guard-rig";

const NOTE_PATH = "Tasks.md";
const OTHER_PATH = "Other.md";
const BEFORE = ["## Tuesday", "body line", "## Another"].join("\n");
const TUESDAY_ANCHOR = { kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] };

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

function makeView(store: FoldStore, doc: string, filePath: string | null, cursorAt = 0): EditorView {
	const watcher = createEditorWatcher({ store, window });
	const state = EditorState.create({
		doc,
		selection: { anchor: cursorAt },
		extensions: [
			codeFolding(),
			watcher,
			editorInfoField.init(() => ({ file: filePath ? { path: filePath, extension: "md" } : null })),
		],
	});
	return new EditorView({ state, parent: document.body });
}

function liveFoldedRanges(view: EditorView): { from: number; to: number }[] {
	const ranges: { from: number; to: number }[] = [];
	foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
		ranges.push({ from, to });
	});
	return ranges;
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 300));
}

describe("restore edge cases: pane switched to a different file between the change and the settle", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("is dropped without throwing: the view's active path no longer matches the settled path", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });

		// A single mutable "current file" the mock editorInfoField reads, standing in for the
		// pane being switched to a different open file after the change but before the settle.
		let currentPath: string | null = NOTE_PATH;
		const watcher = createEditorWatcher({ store, window });
		const state = EditorState.create({
			doc: BEFORE,
			selection: { anchor: 0 },
			extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: currentPath ? { path: currentPath, extension: "md" } : null }))],
		});
		const view = new EditorView({ state, parent: document.body });

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
		});

		currentPath = OTHER_PATH; // the pane now shows a different file, before the 150ms settle fires

		await expect(settle()).resolves.toBeUndefined();
		expect(liveFoldedRanges(view)).toEqual([]); // nothing was dispatched for the old path
	});

	it("is dropped without throwing: the view was destroyed before the settle fired", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const view = makeView(store, BEFORE, NOTE_PATH);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
		});
		view.destroy();

		await expect(settle()).resolves.toBeUndefined();
	});
});

describe("restore edge cases: empty file, no folds in the map, and a 'no match' map entry", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("an empty file with an empty map: no effect dispatched, nothing throws", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [], dormant: [] } });
		const view = makeView(store, "", NOTE_PATH);
		const dispatchSpy = vi.spyOn(view, "dispatch");

		view.dispatch({
			changes: { from: 0, to: 0, insert: "" },
			annotations: Transaction.userEvent.of("set"),
		});

		await expect(settle()).resolves.toBeUndefined();
		expect(dispatchSpy).toHaveBeenCalledTimes(1); // only the explicit dispatch above
		expect(liveFoldedRanges(view)).toEqual([]);
	});

	it("a map entry the matcher can't place (no-candidate): no effect dispatched, nothing throws", async () => {
		// A stored anchor that nothing in the new text could plausibly be: different kind,
		// different text entirely, with no same-kind candidate anywhere in the document at all.
		const unplaceable = { kind: "callout", indent: 0, text: "something that will never appear", siblingIndex: 0, parentChain: [] };
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [unplaceable], dormant: [] } });
		const view = makeView(store, BEFORE, NOTE_PATH);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
		});

		await expect(settle()).resolves.toBeUndefined();
		expect(liveFoldedRanges(view)).toEqual([]);
	});
});

describe("restore edge cases: idempotent re-apply against the real CM6 pipeline", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("a block already folded live is not re-dispatched by a second settled restore for unrelated text elsewhere", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: "x", folds: [TUESDAY_ANCHOR], dormant: [] } });
		const cursorAt = BEFORE.indexOf("## Another");
		// Cursor parked inside "## Another" (line 3), clearly outside Tuesday's own range
		// (lines 1-2), so G13 doesn't defer the fold this test is about. Set explicitly on each
		// dispatch too: a whole-buffer replace otherwise maps the old selection to the start of
		// the new content by default, not to the same text at the same offset.
		const view = makeView(store, BEFORE, NOTE_PATH, cursorAt);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: BEFORE },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: cursorAt },
		});
		await settle();
		const foldedAfterFirst = liveFoldedRanges(view);
		expect(foldedAfterFirst).toHaveLength(1);

		// A second, unrelated external rewrite (appends a line at the very end, well outside
		// Tuesday's own already-closed range) — the live Tuesday fold must survive unchanged,
		// not be re-added as a duplicate or disturbed.
		const secondText = view.state.doc.toString() + "\nmore content at the end";
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: secondText },
			annotations: Transaction.userEvent.of("set"),
			selection: { anchor: cursorAt },
		});
		await settle();

		expect(liveFoldedRanges(view)).toEqual(foldedAfterFirst);
	});
});

// --- The diagnostic log's `settled` lines (warkworth-46 PR-1, GP6, F4, E16) -------------------

describe("diagnostic log: restoreSettledChange logs a `settled` line when it changes stored data", () => {
	const DIR = ".obsidian/plugins/persistent-folded-state";
	const LOG_PATH = `${DIR}/diagnostic-log.jsonl`;
	// An extra line above "## Tuesday" changes the text (and so its hash) but not the heading.
	const AFTER = ["(a line inserted above)", "## Tuesday", "body line", "## Another"].join("\n");
	const UNPLACEABLE = { kind: "heading", indent: 0, text: "zzz qqq www completely different", siblingIndex: 0, parentChain: [] };
	const MARKER = "SETTLED-MARKER-77c1";

	afterEach(() => {
		document.body.replaceChildren();
	});

	function logTo(adapter: MemoryAdapter): DiagnosticLogWriter {
		return new DiagnosticLogWriter(adapter, DIR, { now: () => new Date("2026-10-28T10:00:00.000Z"), warn: () => {} });
	}

	function entriesOf(adapter: MemoryAdapter): Record<string, unknown>[] {
		return logLines(adapter.files.get(LOG_PATH) ?? "").map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	function watchedView(store: FoldStore, doc: string, log: DiagnosticLogWriter): EditorView {
		const watcher = createEditorWatcher({ store, window, diagnosticLog: (entry) => log.log(entry) });
		const state = EditorState.create({
			doc,
			selection: { anchor: 0 },
			extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
		});
		return new EditorView({ state, parent: document.body });
	}

	function rewrite(view: EditorView, text: string): void {
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: Transaction.userEvent.of("set") });
	}

	it("an external rewrite that re-matches one fold and sets one aside logs one line with the counts before and after", async () => {
		const adapter = new MemoryAdapter();
		const log = logTo(adapter);
		const store = await makeStore({
			[NOTE_PATH]: { contentHash: hashText(BEFORE), folds: [TUESDAY_ANCHOR, UNPLACEABLE], dormant: [] },
		});
		const view = watchedView(store, BEFORE, log);

		rewrite(view, AFTER);
		await settle();
		await log.drain();

		const lines = entriesOf(adapter);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			path: NOTE_PATH,
			pass: "settled",
			editorLen: AFTER.length,
			diskLen: -1,
			foldsBefore: 2,
			dormantBefore: 0,
			foldsAfter: 1,
			dormantAfter: 1,
			outcome: "rematched",
		});
		expect(Object.keys(lines[0])).toEqual([...DIAGNOSTIC_LOG_FIELDS]);
		// The counts are what the store really holds after the pass.
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);
		expect(store.get(NOTE_PATH)?.dormant).toHaveLength(1);
	});

	it("the produced line holds no note text, heading or anchor text", async () => {
		const adapter = new MemoryAdapter();
		const log = logTo(adapter);
		const body = ["## Tuesday", `${MARKER} body line`, "## Another"].join("\n");
		const edited = `(inserted)\n${body}`;
		const store = await makeStore({
			[NOTE_PATH]: { contentHash: hashText(body), folds: [TUESDAY_ANCHOR, UNPLACEABLE], dormant: [] },
		});
		const view = watchedView(store, body, log);

		rewrite(view, edited);
		await settle();
		await log.drain();

		const raw = adapter.files.get(LOG_PATH) as string;
		expect(raw).not.toBe("");
		for (const secret of [MARKER, "body line", "tuesday", "Tuesday", "zzz qqq", "Another", "inserted"]) expect(raw).not.toContain(secret);
		for (const line of entriesOf(adapter)) {
			expect(Object.keys(line)).toEqual([...DIAGNOSTIC_LOG_FIELDS]);
			for (const banned of ["text", "heading", "anchor", "content"]) expect(Object.keys(line)).not.toContain(banned);
		}
	});

	it("a pass that changes nothing stored logs nothing", async () => {
		const adapter = new MemoryAdapter();
		const log = logTo(adapter);
		const store = await makeStore({ [NOTE_PATH]: { contentHash: hashText(BEFORE), folds: [TUESDAY_ANCHOR], dormant: [] } });
		const view = watchedView(store, BEFORE, log);

		rewrite(view, BEFORE); // the same text again: same hash, same folds, same set-aside list
		await settle();
		await log.drain();

		expect(adapter.calls).toEqual([]);
		expect(entriesOf(adapter)).toEqual([]);
	});

	it("a superseded run logs nothing, and neither does a run whose path no longer matches", async () => {
		const seen: DiagnosticEntry[] = [];
		const record = { contentHash: hashText(BEFORE), folds: [TUESDAY_ANCHOR], dormant: [] };
		const run = async (opts: { superseded: boolean; activePath: string | null }): Promise<void> => {
			const store = await makeStore({ [NOTE_PATH]: structuredClone(record) });
			const view = watchedView(store, BEFORE, logTo(new MemoryAdapter()));
			await restoreSettledChange(view, NOTE_PATH, AFTER, {
				store,
				getActivePath: () => opts.activePath,
				isSuperseded: () => opts.superseded,
				diagnosticLog: (entry) => seen.push(entry),
			});
			expect(store.get(NOTE_PATH)?.contentHash).toBe(hashText(BEFORE)); // nothing was stored either
		};

		await run({ superseded: true, activePath: NOTE_PATH });
		await run({ superseded: false, activePath: OTHER_PATH });
		await run({ superseded: false, activePath: null });
		expect(seen).toEqual([]);

		// And the same call, not superseded and on the right path, does log: the test is not vacuous.
		const store = await makeStore({ [NOTE_PATH]: structuredClone(record) });
		const view = watchedView(store, BEFORE, logTo(new MemoryAdapter()));
		await restoreSettledChange(view, NOTE_PATH, AFTER, {
			store,
			getActivePath: () => NOTE_PATH,
			diagnosticLog: (entry) => seen.push(entry),
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ pass: "settled", outcome: "rematched", foldsBefore: 1, foldsAfter: 1 });
	});

	it.each([
		{ label: "a rejecting adapter", setup: (a: MemoryAdapter) => void (a.failWith = new Error("disk full")) },
		{ label: "a synchronously throwing adapter", setup: (a: MemoryAdapter) => void (a.throwSync = true) },
		{ label: "a never-resolving adapter", setup: (a: MemoryAdapter) => void (a.hang = true) },
	])("E16: $label leaves the pass's folds and the store exactly as when logging works", async ({ setup }) => {
		const outcomeWith = async (breakAdapter: boolean) => {
			const adapter = new MemoryAdapter();
			if (breakAdapter) setup(adapter);
			const log = logTo(adapter);
			const store = await makeStore({
				[NOTE_PATH]: { contentHash: hashText(BEFORE), folds: [TUESDAY_ANCHOR, UNPLACEABLE], dormant: [] },
			});
			const view = watchedView(store, BEFORE, log);
			rewrite(view, AFTER);
			await settle();
			return { folded: liveFoldedRanges(view), record: structuredClone(store.get(NOTE_PATH)) };
		};
		const working = await outcomeWith(false);
		const broken = await outcomeWith(true);
		expect(working.folded).toHaveLength(1);
		// `dormantSince` is a wall-clock stamp: compare everything else exactly.
		const strip = (r: typeof working.record) => ({ ...r, dormant: r?.dormant.map((d) => ({ ...d, dormantSince: 0 })) });
		expect(broken.folded).toEqual(working.folded);
		expect(strip(broken.record)).toEqual(strip(working.record));
	});
});

describe("PR-3: the settled pass waits for the pane to hold the note's real text (E3, E1, last text wins)", () => {
	// Heading text only changes the lines around it, so the stored "tuesday" anchor re-matches.
	const FULL = ["(a line inserted above)", "## Tuesday", "SETTLED-GUARD-MARKER body line", "## Another"].join("\n");
	const OLD = ["## Tuesday", "SETTLED-GUARD-MARKER body line", "## Another"].join("\n");
	const UNPLACEABLE = { kind: "heading", indent: 0, text: "zzz qqq www completely different", siblingIndex: 0, parentChain: [] };

	afterEach(() => {
		document.body.replaceChildren();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function guardedView(rig: GuardRig, store: FoldStore, doc: string): EditorView {
		const watcher = createEditorWatcher({ store, ...rig.watcherDeps });
		const state = EditorState.create({
			doc,
			selection: { anchor: 0 },
			extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
		});
		return new EditorView({ state, parent: document.body });
	}

	function set(view: EditorView, text: string): void {
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: Transaction.userEvent.of("set") });
	}

	async function seeded(): Promise<{ store: FoldStore; setSpy: ReturnType<typeof vi.spyOn> }> {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: hashText(OLD), folds: [TUESDAY_ANCHOR, UNPLACEABLE], dormant: [] } });
		return { store, setSpy: vi.spyOn(store, "set") };
	}

	it("E3: an empty `set` then the full `set` inside the 150 ms window: only the full text is matched, dormant gets only the unmatched fold, the hash is the file's", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, FULL);
		const { store, setSpy } = await seeded();
		const view = guardedView(rig, store, OLD);
		await vi.advanceTimersByTimeAsync(0);

		set(view, "");
		await vi.advanceTimersByTimeAsync(50);
		set(view, FULL);
		await vi.advanceTimersByTimeAsync(400);

		const lines = await rig.lines();
		expect(lines.map((l) => [l.pass, l.outcome])).toEqual([["settled", "rematched"]]); // one pass, no wait, no refusal
		expect(lines[0]).toMatchObject({ editorLen: FULL.length, diskLen: FULL.length, foldsBefore: 2, foldsAfter: 1, dormantBefore: 0, dormantAfter: 1 });
		expect(store.get(NOTE_PATH)?.contentHash).toBe(hashText(FULL));
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(1); // the Tuesday fold re-matched ...
		expect(store.get(NOTE_PATH)?.dormant).toHaveLength(1); // ... and only the genuinely unplaceable one was set aside
		expect(liveFoldedRanges(view)).toHaveLength(1);
		// Every store write was made for the full text, never for "".
		for (const call of setSpy.mock.calls) expect((call[1] as FileFoldRecord).contentHash).not.toBe(hashText(""));
	});

	it("an empty settled text that does reach the pass (after the debounce) is refused: nothing matched, nothing stored, one refused-empty line", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, FULL);
		const { store, setSpy } = await seeded();
		const before = structuredClone(store.get(NOTE_PATH));
		const view = guardedView(rig, store, OLD);
		await vi.advanceTimersByTimeAsync(0);

		set(view, ""); // the pane is emptied by a reload; the full text has not arrived yet
		await vi.advanceTimersByTimeAsync(400); // the debounce fires with ""

		expect(setSpy).not.toHaveBeenCalled();
		expect(store.get(NOTE_PATH)).toEqual(before); // folds, dormant and hash untouched
		const lines = await rig.lines();
		expect(lines.map((l) => [l.pass, l.outcome])).toEqual([["settled", "refused-empty"]]);
		expect(lines[0]).toMatchObject({ editorLen: 0, diskLen: FULL.length, foldsBefore: 2, foldsAfter: 2, dormantBefore: 0, dormantAfter: 0 });
		expect(rig.gate.isHolding(view)).toBe(true); // it waits, it does not give up

		// The text lands: the pass runs, once, on the real text.
		set(view, FULL);
		await vi.advanceTimersByTimeAsync(400);
		const after = await rig.lines();
		expect(after.map((l) => [l.pass, l.outcome])).toEqual([
			["settled", "refused-empty"],
			["settled", "rematched"],
		]);
		expect(store.get(NOTE_PATH)?.contentHash).toBe(hashText(FULL));
		expect(store.get(NOTE_PATH)?.dormant).toHaveLength(1);
	});

	it("restoreSettledChange called directly with \"\" and the guard on: returns [] and never calls store.set", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, FULL);
		const { store, setSpy } = await seeded();
		const view = guardedView(rig, store, "");
		await vi.advanceTimersByTimeAsync(0);
		setSpy.mockClear();

		const result = await restoreSettledChange(view, NOTE_PATH, "", {
			store,
			getActivePath: () => NOTE_PATH,
			loadGuard: { gate: rig.gate, makeIo: () => rig.watcherDeps.loadGuard!.makeIo(view, NOTE_PATH), rerun: () => {} },
		});
		expect(result).toEqual([]);
		expect(setSpy).not.toHaveBeenCalled();
		rig.gate.cancelAll();
	});

	it("several triggers queue behind one wait; when the text lands the pass runs once and the last settled text wins", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, FULL);
		const { store } = await seeded();
		const view = guardedView(rig, store, OLD);
		await vi.advanceTimersByTimeAsync(0);

		set(view, ""); // three separate settles, each reaching the pass while the pane is not loaded
		await vi.advanceTimersByTimeAsync(300);
		set(view, FULL.slice(0, 20));
		await vi.advanceTimersByTimeAsync(300);
		set(view, FULL.slice(0, 40));
		await vi.advanceTimersByTimeAsync(300);
		expect(store.get(NOTE_PATH)?.contentHash).toBe(hashText(OLD)); // still untouched

		set(view, FULL);
		await vi.advanceTimersByTimeAsync(1000);

		const lines = await rig.lines();
		const outcomes = lines.map((l) => l.outcome);
		expect(outcomes.filter((o) => o === "rematched")).toHaveLength(1); // once, not once per trigger
		expect(outcomes.filter((o) => o === "refused-empty" || o === "waiting")).toHaveLength(1); // one wait, one line for it
		expect(lines[lines.length - 1]).toMatchObject({ editorLen: FULL.length, outcome: "rematched" });
		expect(store.get(NOTE_PATH)?.contentHash).toBe(hashText(FULL));
	});

	it("the log holds no note text, heading or anchor text", async () => {
		vi.useFakeTimers();
		const rig = makeGuardRig();
		rig.vault.setContent(NOTE_PATH, FULL);
		const { store } = await seeded();
		const view = guardedView(rig, store, OLD);
		await vi.advanceTimersByTimeAsync(0);
		set(view, "");
		await vi.advanceTimersByTimeAsync(300);
		set(view, FULL);
		await vi.advanceTimersByTimeAsync(1000);

		const raw = await rig.raw();
		expect(raw).not.toBe("");
		for (const secret of ["SETTLED-GUARD-MARKER", "body line", "Tuesday", "tuesday", "Another", "zzz qqq", "inserted"]) expect(raw).not.toContain(secret);
	});

	it("without a loadGuard the pass runs on the text it is given, as before", async () => {
		const store = await makeStore({ [NOTE_PATH]: { contentHash: hashText(OLD), folds: [TUESDAY_ANCHOR], dormant: [] } });
		const view = makeView(store, OLD, NOTE_PATH);
		set(view, FULL);
		await settle();
		expect(store.get(NOTE_PATH)?.contentHash).toBe(hashText(FULL));
	});
});
