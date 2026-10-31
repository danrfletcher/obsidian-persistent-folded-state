/**
 * G1, G15, E3 and own-effect tagging (E11), against a real `EditorState`/`EditorView` built over
 * the fixture note (tests/fixtures/fixture-note.md) — not a fake. The store is faked in memory
 * (an in-memory `loadData`/`saveData` pair); `tests/integration/data-json.test.ts` already covers
 * the real-file round trip for `FoldStore` itself.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { editorInfoField } from "../../tests/mocks/obsidian";
import { FoldStore, hashText } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import { OWN_FOLD_ANNOTATION } from "../../src/fold-recorder";
import type { DiagnosticEntry, DiagnosticSink } from "../../src/diagnostic-log";
import type { FileFoldRecord } from "../../src/types";

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fixture-note.md");
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");
const NOTE_PATH = "Fixtures/fixture-note.md";

/** An in-memory stand-in for Obsidian's `loadData`/`saveData`; `readSaved()` lets a test look at
 * what was actually flushed to "disk", distinct from the in-memory map `store.get()` reads. */
function makeStore(): { store: FoldStore; readSaved: () => { files: Record<string, FileFoldRecord> } | null } {
	let stored: { files: Record<string, FileFoldRecord> } | null = null;
	const store = new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data as { files: Record<string, FileFoldRecord> };
		},
	});
	return { store, readSaved: () => stored };
}

function makeView(
	store: FoldStore,
	onSettledNonUserChange?: (path: string, text: string) => void,
	diagnosticLog?: DiagnosticSink,
): EditorView {
	const watcher = createEditorWatcher({ store, onSettledNonUserChange, diagnosticLog, window });
	const state = EditorState.create({
		doc: FIXTURE_TEXT,
		// `codeFolding()` mirrors what real Obsidian always has registered in its own editor
		// extensions (core fold-gutter support) — this plugin's own extension never supplies
		// it; it only reads the live `foldState` such an extension provides (R4/R5).
		extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
	});
	return new EditorView({ state, parent: document.body });
}

/** Line numbers (1-indexed) of one example of each foldable kind in the fixture note. */
const LINES = {
	frontmatter: 1, // "---"
	heading: 10, // "## Tuesday"
	list: 14, // "- Plain list item"
	task: 17, // "- [ ] Draft proposal"
	blockquote: 23, // "> A blockquote"
	callout: 26, // "> [!note] A callout"
	codeBlock: 29, // "```js"
} as const;

function lineStart(view: EditorView, lineNumber: number): number {
	return view.state.doc.line(lineNumber).from;
}

describe("fold recorder integration (real EditorState/EditorView over the fixture note)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it.each(Object.entries(LINES))("G1: folding the %s line adds one entry of that kind to the store", (kind, lineNumber) => {
		const { store } = makeStore();
		const view = makeView(store);
		const from = lineStart(view, lineNumber);

		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		const record = store.get(NOTE_PATH);
		expect(record?.folds).toHaveLength(1);
		// PR-5: the recorder now stores a real Anchor (src/anchors.ts), whose code-block kind
		// is "code" — not PR-2's placeholder FoldDescriptor, whose guess was "code-block".
		expect((record?.folds[0] as { kind: string }).kind).toBe(kind === "codeBlock" ? "code" : kind);
	});

	it("G1: unfolding removes the matching entry; the store flushes it (debounced)", async () => {
		vi.useFakeTimers();
		const { store, readSaved } = makeStore();
		const view = makeView(store);
		const from = lineStart(view, LINES.heading);

		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);

		view.dispatch({ effects: [unfoldEffect.of({ from, to: from + 1 })] });
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(200);
		expect(readSaved()?.files[NOTE_PATH]).toEqual({ contentHash: expect.any(String), folds: [], dormant: [] });
		vi.useRealTimers();
	});

	it("G1: a note with a record carries a content hash (adopted as baseline, not written by a fold)", () => {
		const { store } = makeStore();
		const lines: DiagnosticEntry[] = [];
		const view = makeView(store, undefined, (entry) => lines.push(entry));
		const from = lineStart(view, LINES.heading);

		// Before any fold: the hash is already there, written by the baseline path.
		const adopted = store.get(NOTE_PATH);
		expect(adopted?.contentHash).toBe(hashText(FIXTURE_TEXT));
		expect(adopted?.folds).toEqual([]);
		expect(lines.filter((l) => l.pass === "baseline" && l.outcome === "applied")).toHaveLength(1);

		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		// The fold added its entry and left the hash exactly as the baseline wrote it; it logged
		// no second baseline write.
		const record = store.get(NOTE_PATH);
		expect(record?.folds).toHaveLength(1);
		expect(record?.contentHash).toBe(adopted?.contentHash);
		expect(lines.filter((l) => l.pass === "baseline")).toHaveLength(1);
	});

	it("G15: an external write with an empty map dispatches zero fold/unfold effects and leaves folded ranges unchanged", () => {
		const { store } = makeStore();
		const view = makeView(store);
		const dispatchSpy = vi.spyOn(view, "dispatch");
		const before = foldedRanges(view.state).size;

		// Simulate "the reload shape": a document-changing transaction with no user-event
		// annotation, exactly as an external rewrite would look at the CM6 level.
		view.dispatch({ changes: { from: 0, to: 0, insert: "injected above\n" } });

		// Our own code never calls dispatch — the one call recorded is the external write above.
		expect(dispatchSpy).toHaveBeenCalledTimes(1);
		expect(foldedRanges(view.state).size).toBe(before);
		// G15: `makeView` itself already adopted an empty baseline for this never-before-seen
		// path when the view was constructed (PR-6) — it is no longer left with no entry at
		// all, but the external write above still recorded no fold/unfold of its own.
		expect(store.get(NOTE_PATH)).toEqual({ contentHash: expect.any(String), folds: [], dormant: [] });
	});

	it("E3: a fold made while the settle timer is pending is recorded immediately and survives settling", async () => {
		vi.useFakeTimers();
		const onSettledNonUserChange = vi.fn();
		const { store } = makeStore();
		const view = makeView(store, onSettledNonUserChange);

		// Starts the 150ms settle timer (non-user change).
		view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });

		// A user fold mid-burst, before the timer elapses.
		const from = lineStart(view, LINES.heading);
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(150);
		expect(onSettledNonUserChange).toHaveBeenCalledTimes(1);
		// Nothing in the settle handling touches the folds map.
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);
		vi.useRealTimers();
	});

	it("E3: an unfold made mid-burst removes the entry and it does not come back at settle", async () => {
		vi.useFakeTimers();
		const { store } = makeStore();
		const view = makeView(store);
		const from = lineStart(view, LINES.heading);
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		view.dispatch({ changes: { from: 0, to: 0, insert: "x" } }); // starts the settle timer
		// The insert shifted every later offset by one character; CM6's own fold state remaps
		// through this via each effect's `map` function (StateEffect.define({ map: mapRange })),
		// so the *live* folded position — not the stale one captured before the insert — is what
		// a real unfold (gutter click, fold command) would target.
		const liveFrom = lineStart(view, LINES.heading);
		view.dispatch({ effects: [unfoldEffect.of({ from: liveFrom, to: liveFrom + 1 })] });
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(150);
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(0);
		vi.useRealTimers();
	});

	describe("own-effect tagging (E11)", () => {
		it("a fold effect tagged with OWN_FOLD_ANNOTATION is ignored, not recorded as a user fold", () => {
			const { store } = makeStore();
			const view = makeView(store);
			const from = lineStart(view, LINES.heading);

			view.dispatch({
				effects: [foldEffect.of({ from, to: from + 1 })],
				annotations: OWN_FOLD_ANNOTATION.of(true),
			});

			// G15: baseline adoption at construction already created an empty entry for this
			// path (PR-6) — the tagged fold effect above must still leave `folds` empty, i.e.
			// it was not recorded as a user fold.
			expect(store.get(NOTE_PATH)).toEqual({ contentHash: expect.any(String), folds: [], dormant: [] });
		});

		it("the same effect, untagged, is recorded as a user fold", () => {
			const { store } = makeStore();
			const view = makeView(store);
			const from = lineStart(view, LINES.heading);

			view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

			expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);
		});
	});

	describe("R4: de-duplication and position-based unfold matching", () => {
		it("a user fold does not erase stored anchors that aren't live yet (never-break rule 2)", () => {
			const { store } = makeStore();
			const view = makeView(store);

			// Anchors already on record from before this session — e.g. a restore that
			// hasn't dispatched its fold effects yet (still matching, or still mid-150ms
			// settle), or a G13 fold still deferred because the cursor sat inside it. None of
			// these are "live" in CM6's own fold state right now, but the user folding some
			// unrelated block must never cost them: only the user's own fold/unfold may ever
			// change stored state (never-break rule 2).
			const notYetLive = { kind: "heading", indent: 0, text: "## not yet restored", siblingIndex: 0, parentChain: [] };
			store.set(NOTE_PATH, { contentHash: "stale", folds: [notYetLive], dormant: [] });

			const taskFrom = lineStart(view, LINES.task);
			view.dispatch({ effects: [foldEffect.of({ from: taskFrom, to: taskFrom + 1 })] });

			const folds = store.get(NOTE_PATH)?.folds ?? [];
			expect(folds).toHaveLength(2);
			expect(folds).toContainEqual(notYetLive);
			expect(folds.some((entry) => (entry as { kind: string }).kind === "task")).toBe(true);
		});

		it("a double fold of the same block, then a single unfold, leaves zero entries", () => {
			const { store } = makeStore();
			const view = makeView(store);
			const from = lineStart(view, LINES.heading);

			// Two fold effects over the identical range (e.g. a native restore racing a user
			// fold, or any other double-dispatch) must never produce two stored entries.
			view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });
			view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });
			expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);

			view.dispatch({ effects: [unfoldEffect.of({ from, to: from + 1 })] });
			expect(store.get(NOTE_PATH)?.folds).toHaveLength(0);
		});

		it("editing a folded line's text, then unfolding it, never touches any other stored fold (R4)", () => {
			const { store } = makeStore();
			const view = makeView(store);
			const headingFrom = lineStart(view, LINES.heading);
			const taskFrom = lineStart(view, LINES.task);

			// Two unrelated blocks, folded independently.
			view.dispatch({ effects: [foldEffect.of({ from: headingFrom, to: headingFrom + 1 })] });
			view.dispatch({ effects: [foldEffect.of({ from: taskFrom, to: taskFrom + 1 })] });
			expect(store.get(NOTE_PATH)?.folds).toHaveLength(2);

			// Rewrite the folded heading's own text while it's folded (e.g. the user typing in
			// it, or an external agent rewriting "## Tuesday" -> "## Tuesday v2") — no fold or
			// unfold effect in this transaction, so the stored record isn't touched by it. The
			// edit is an insertion at the line's end rather than a replace of the fold's own
			// anchor span: CM6 itself drops a fold whose exact range was replaced outright
			// (correctly — that content no longer exists), which is a different, unrelated
			// case from the one R4 is about (the fold's range survives; only the line's text
			// changed), so this is the faithful way to reproduce it.
			const headingLine = view.state.doc.line(LINES.heading);
			view.dispatch({ changes: { from: headingLine.to, to: headingLine.to, insert: " v2" } });

			// Both live CM6 fold ranges survive the text edit untouched (still the same mapped
			// positions); unfold the one whose own text drifted (position order puts the
			// earlier-in-the-document heading first).
			const liveFolded: { from: number; to: number }[] = [];
			foldedRanges(view.state).between(0, view.state.doc.length, (rangeFrom, rangeTo) => {
				liveFolded.push({ from: rangeFrom, to: rangeTo });
			});
			expect(liveFolded).toHaveLength(2);
			view.dispatch({ effects: [unfoldEffect.of(liveFolded[0])] });

			// R4: the *other* stored fold — never touched by this transaction at all — must
			// survive. This is the actual guarantee R4 restores: handling one fold/unfold never
			// rewrites (and so never erases) anything the transaction's own effects didn't
			// mention. Whether the drifted entry itself is also removed is a separate, known
			// limitation: once a folded block's own text changes in an earlier, untouched
			// transaction, the recorder (which matches by structural identity, not by CM6's
			// live decoration position) can no longer recognise a later unfold at that position
			// as targeting the same stored anchor — reconciling identity across a text edit is
			// the matcher's job (PR-4's fuzzy tiers), not the recorder's; the stale entry is
			// simply left for the next restore to resolve, the same as any other anchor whose
			// text has drifted since it was last recorded.
			const remaining = store.get(NOTE_PATH)?.folds ?? [];
			expect(remaining.some((entry) => (entry as { kind: string }).kind === "task")).toBe(true);
		});
	});

	describe("R5: fold effects are described in the transaction's post-change coordinates", () => {
		it("a transaction that both inserts text and folds a range describes the post-insert line, not the pre-insert one", () => {
			const { store } = makeStore();
			const view = makeView(store);

			// Mirrors the exact scenario from the review finding: insert a new first line, and
			// in the same transaction fold a range that (only after the insert) falls inside it.
			// Against `tr.startState` this would describe the wrong block (or throw past the
			// old document's end); against `tr.state` (R5's fix) it must describe "NEW LINE"
			// (normalized, per PR-5's anchor-based describeFold: lower-cased, "new line").
			const insert = "NEW LINE\n";
			view.dispatch({
				changes: { from: 0, to: 0, insert },
				effects: [foldEffect.of({ from: 2, to: insert.length - 1 })],
			});

			const record = store.get(NOTE_PATH);
			expect(record?.folds).toHaveLength(1);
			expect((record?.folds[0] as { text: string }).text).toBe("new line");
		});
	});
});

describe("fold recorder: stored entries and effects it does not own", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("a stored entry that is not a well-formed anchor is dropped when the next fold is recorded, and the other stored anchors stay", () => {
		const { store } = makeStore();
		const view = makeView(store);
		const first = lineStart(view, LINES.heading);
		view.dispatch({ effects: [foldEffect.of({ from: first, to: first + 1 })] });
		const kept = store.get(NOTE_PATH)?.folds[0];
		expect(kept).toBeDefined();
		// A raw-text record of the kind the PR-2 store wrote, sitting beside the good anchor.
		store.set(NOTE_PATH, { ...(store.get(NOTE_PATH) as FileFoldRecord), folds: [kept as never, "- Plain list item" as never] });

		const second = lineStart(view, LINES.task);
		view.dispatch({ effects: [foldEffect.of({ from: second, to: second + 1 })] });

		const folds = store.get(NOTE_PATH)?.folds as unknown as Array<{ kind: string } | string>;
		expect(folds).toHaveLength(2);
		expect(folds.every((f) => typeof f !== "string")).toBe(true);
		expect(folds.map((f) => (f as { kind: string }).kind)).toEqual(["heading", "task"]);
	});

	it("an effect that is neither a fold nor an unfold, sent beside a fold, changes nothing in the stored set", () => {
		const { store } = makeStore();
		const view = makeView(store);
		const other = StateEffect.define<number>();
		const from = lineStart(view, LINES.heading);

		view.dispatch({ effects: [other.of(1), foldEffect.of({ from, to: from + 1 }), other.of(2)] });

		const folds = store.get(NOTE_PATH)?.folds as unknown as Array<{ kind: string }>;
		expect(folds).toHaveLength(1);
		expect(folds[0].kind).toBe("heading");
	});
});

/**
 * Warkworth-46 PR-4 (E15): recording a fold removes its anchor from `dormant` and never rewrites an
 * existing `contentHash`. Real `EditorState`/`EditorView` over the fixture note; the set-aside
 * entries are made from the anchor the recorder itself produces for the block, so they are
 * duplicates in the same sense the vault's real ones are.
 */
describe("fold recorder: dormant and contentHash (E15)", () => {
	const STALE_HASH = "not-the-hash-of-this-doc";
	const SINCE = 123_456;

	afterEach(() => {
		document.body.replaceChildren();
	});

	/** Folds and unfolds `lineNumber` once to learn the anchor the recorder stores for it, then
	 * leaves the store holding `contentHash: STALE_HASH`, no folds, and that anchor set aside. */
	function setAside(store: FoldStore, view: EditorView, lineNumbers: number[]): Record<string, unknown>[] {
		const anchors: Record<string, unknown>[] = [];
		for (const lineNumber of lineNumbers) {
			const from = lineStart(view, lineNumber);
			view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });
			anchors.push((store.get(NOTE_PATH)?.folds ?? []).at(-1) as unknown as Record<string, unknown>);
			view.dispatch({ effects: [unfoldEffect.of({ from, to: from + 1 })] });
		}
		store.set(NOTE_PATH, {
			contentHash: STALE_HASH,
			folds: [],
			dormant: anchors.map((a) => ({ ...a, dormantSince: SINCE }) as never),
		});
		return anchors;
	}

	it("a fold removes that anchor from dormant and it appears once in folds", () => {
		const { store } = makeStore();
		const view = makeView(store);
		const [heading] = setAside(store, view, [LINES.heading]);

		const from = lineStart(view, LINES.heading);
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		const record = store.get(NOTE_PATH);
		expect(record?.dormant).toEqual([]);
		expect(record?.folds).toEqual([heading]);
	});

	it("only the folded anchor leaves dormant; another set-aside anchor keeps its own dormantSince and place", () => {
		const { store } = makeStore();
		const view = makeView(store);
		const [heading, task] = setAside(store, view, [LINES.heading, LINES.task]);

		const from = lineStart(view, LINES.task);
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		const record = store.get(NOTE_PATH);
		expect(record?.dormant).toEqual([{ ...heading, dormantSince: SINCE }]);
		expect(record?.folds).toEqual([task]);
	});

	it("contentHash stays the stored one after a fold, on a record whose hash differs from the doc", () => {
		const { store } = makeStore();
		const view = makeView(store);
		setAside(store, view, [LINES.heading]);

		const from = lineStart(view, LINES.task);
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		expect(store.get(NOTE_PATH)?.contentHash).toBe(STALE_HASH);
	});

	it("contentHash stays the stored one after an unfold too, and an unfold leaves dormant untouched", () => {
		const { store } = makeStore();
		const view = makeView(store);
		const [heading] = setAside(store, view, [LINES.heading]);
		const taskFrom = lineStart(view, LINES.task);
		view.dispatch({ effects: [foldEffect.of({ from: taskFrom, to: taskFrom + 1 })] });

		view.dispatch({ effects: [unfoldEffect.of({ from: taskFrom, to: taskFrom + 1 })] });

		const record = store.get(NOTE_PATH);
		expect(record?.contentHash).toBe(STALE_HASH);
		expect(record?.dormant).toEqual([{ ...heading, dormantSince: SINCE }]);
	});

	it("an unfold of an anchor that is set aside leaves it set aside", () => {
		const { store } = makeStore();
		const view = makeView(store);
		const [heading] = setAside(store, view, [LINES.heading]);

		const from = lineStart(view, LINES.heading);
		view.dispatch({ effects: [unfoldEffect.of({ from, to: from + 1 })] });

		expect(store.get(NOTE_PATH)?.dormant).toEqual([{ ...heading, dormantSince: SINCE }]);
		expect(store.get(NOTE_PATH)?.folds).toEqual([]);
	});

	it("a fold on a note with no stored record creates one with a hash of the current text", () => {
		const { store } = makeStore();
		const view = makeView(store);
		store.forget(NOTE_PATH);
		expect(store.get(NOTE_PATH)).toBeUndefined();

		const from = lineStart(view, LINES.heading);
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		expect(store.get(NOTE_PATH)?.contentHash).toBe(hashText(FIXTURE_TEXT));
		expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);
		expect(store.get(NOTE_PATH)?.dormant).toEqual([]);
	});

	it("effects tagged OWN_FOLD_ANNOTATION change nothing: dormant, folds and hash are all as they were", () => {
		const { store } = makeStore();
		const view = makeView(store);
		setAside(store, view, [LINES.heading]);
		const before = JSON.stringify(store.get(NOTE_PATH));

		const from = lineStart(view, LINES.heading);
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })], annotations: OWN_FOLD_ANNOTATION.of(true) });

		expect(JSON.stringify(store.get(NOTE_PATH))).toBe(before);
	});

	it("a transaction with no fold effect (a plain edit) changes nothing", () => {
		const { store } = makeStore();
		const view = makeView(store);
		setAside(store, view, [LINES.heading]);
		const before = JSON.stringify(store.get(NOTE_PATH));

		view.dispatch({ changes: { from: 0, to: 0, insert: "x" } });

		expect(JSON.stringify(store.get(NOTE_PATH))).toBe(before);
	});

	it("an untagged fold effect, as a native restore dispatches it, moves a set-aside anchor out of dormant and keeps the hash", () => {
		const { store } = makeStore();
		const view = makeView(store);
		const [heading, task] = setAside(store, view, [LINES.heading, LINES.task]);

		// Obsidian re-applying its own folds: fold effects, no OWN_FOLD_ANNOTATION, several in one dispatch.
		const h = lineStart(view, LINES.heading);
		const t = lineStart(view, LINES.task);
		view.dispatch({ effects: [foldEffect.of({ from: h, to: h + 1 }), foldEffect.of({ from: t, to: t + 1 })] });

		const record = store.get(NOTE_PATH);
		expect(record?.dormant).toEqual([]);
		expect(record?.folds).toEqual([heading, task]);
		expect(record?.contentHash).toBe(STALE_HASH);
	});

	it("one transaction that folds and then unfolds the same block ends with no folds entry, and the fold step still clears dormant", () => {
		const { store } = makeStore();
		const view = makeView(store);
		setAside(store, view, [LINES.heading]);

		const from = lineStart(view, LINES.heading);
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 }), unfoldEffect.of({ from, to: from + 1 })] });

		const record = store.get(NOTE_PATH);
		expect(record?.folds).toEqual([]);
		expect(record?.dormant).toEqual([]);
	});

	it("one transaction that unfolds and then folds the same block ends with it in folds, once", () => {
		const { store } = makeStore();
		const view = makeView(store);
		const [heading] = setAside(store, view, [LINES.heading]);

		const from = lineStart(view, LINES.heading);
		view.dispatch({ effects: [unfoldEffect.of({ from, to: from + 1 }), foldEffect.of({ from, to: from + 1 })] });

		expect(store.get(NOTE_PATH)?.folds).toEqual([heading]);
		expect(store.get(NOTE_PATH)?.dormant).toEqual([]);
	});

	it("a user fold during a wait on a not-yet-loaded editor records the fold and leaves the stored hash alone", () => {
		const { store } = makeStore();
		// Editor holds only a stub of the note (as at file-open, before the real text arrives).
		const watcher = createEditorWatcher({ store, window });
		const state = EditorState.create({
			doc: "# stub\n\n- [ ] one\n  - body\n",
			extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
		});
		const view = new EditorView({ state, parent: document.body });
		store.set(NOTE_PATH, { contentHash: STALE_HASH, folds: [], dormant: [] });

		const from = view.state.doc.line(3).from;
		view.dispatch({ effects: [foldEffect.of({ from, to: from + 1 })] });

		expect(store.get(NOTE_PATH)?.folds).toHaveLength(1);
		expect(store.get(NOTE_PATH)?.contentHash).toBe(STALE_HASH); // a later pass still sees the old hash
	});
});
