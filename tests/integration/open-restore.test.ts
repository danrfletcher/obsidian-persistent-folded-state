/**
 * PR-7 (G8/E4): a CM6 EditorView over fixture notes opened through the plugin's real
 * `file-open` handler (`src/main.ts`'s `workspace.on("file-open", ...)` -> `restoreOnOpen`), not
 * `restoreOnOpen` called directly. Mocks `app.workspace.activeEditor`/`getAbstractFileByPath`
 * with an in-memory setup (`tests/mocks/obsidian.ts`'s `Workspace`/`MarkdownView`/`Editor`)
 * rather than a real filesystem — this file exercises the actual wiring decision (G8 hash
 * compare, re-match, E4 native-restore replacement), not just `src/open-restore.ts`'s pure
 * decision logic in isolation.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { App, type PluginManifest } from "obsidian";
import {
	Editor as MockEditor,
	MarkdownView as MockMarkdownView,
	TFile as MockTFile,
	Vault as MockVault,
	Workspace as MockWorkspace,
	editorInfoField,
} from "../mocks/obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import { createEditorWatcher } from "../../src/editor-watcher";
import { buildAnchors } from "../../src/anchors";
import { hashText } from "../../src/fold-store";
import type { FileFoldRecord } from "../../src/types";

const NOTE_PATH = "Projects/Quarry/Tasks.md";
const TEXT_V1 = ["## Tuesday", "Some text under Tuesday.", "## Wednesday", "Some text under Wednesday."].join("\n");
// An extra line inserted above "## Tuesday": every heading's own text is unchanged, but every
// line number below it shifts by one — exactly the "equal line count" case isn't guaranteed here
// deliberately, since G8/E4 cares about "the stored anchor key still matches a fresh candidate",
// not about line counts staying put.
const TEXT_V2 = ["(a line inserted above)", "## Tuesday", "Some text under Tuesday.", "## Wednesday", "Some text under Wednesday."].join(
	"\n"
);

const manifest: PluginManifest = {
	id: "persistent-folded-state",
	name: "Persistent Folded State",
	version: "0.1.0",
	minAppVersion: "1.13.0",
	description: "test",
	author: "Dan Fletcher",
	isDesktopOnly: false,
};

// R3(c): equal line count, changed content — TEXT_V2 above deliberately adds a line (its own
// comment says so), so E4's own named edge case ("the line count didn't change but the content
// did") was only covered by the pure unit test (tests/unit/vault-lifecycle.test.ts), never here.
// Swapping the two headings' order keeps the line count at 4 (same as TEXT_V1) while moving
// "## Tuesday" from lines 1-2 to lines 3-4, with both bodies reworded too.
const TEXT_V3 = ["## Wednesday", "Some new text under Wednesday.", "## Tuesday", "Some new text under Tuesday."].join("\n");

function tuesdayAnchorFor(text: string): FileFoldRecord["folds"][number] {
	const candidates = buildAnchors(text);
	const tuesday = candidates.find((c) => c.anchor.kind === "heading" && c.anchor.text === "tuesday");
	if (!tuesday) throw new Error("fixture must contain a Tuesday heading");
	return tuesday.anchor as unknown as FileFoldRecord["folds"][number];
}

function makePlugin(app: App, stored: { value: unknown }): PersistentFoldedStatePlugin {
	const plugin = new PersistentFoldedStatePlugin(app, manifest);
	plugin.loadData = async () => stored.value;
	plugin.saveData = async (data: unknown) => {
		stored.value = data;
	};
	return plugin;
}

function makeView(text: string): EditorView {
	const state = EditorState.create({ doc: text, extensions: [codeFolding()] });
	return new EditorView({ state, parent: document.body });
}

/** Wires a CM6 `EditorView` as the active pane for `path`, the same shape `main.ts`'s
 * `file-open` handler reads (`workspace.activeEditor.editor.cm`), and fires the event. */
function openFile(app: App, path: string, view: EditorView): void {
	const file = new MockTFile(path);
	const markdownView = new MockMarkdownView();
	markdownView.file = file;
	markdownView.editor = new MockEditor(view);
	(app.workspace as unknown as MockWorkspace).setActiveView(markdownView);
	(app.workspace as unknown as MockWorkspace).trigger("file-open", file);
}

function liveFoldedLineRanges(view: EditorView): { startLine: number; endLine: number }[] {
	const ranges: { startLine: number; endLine: number }[] = [];
	foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
		ranges.push({ startLine: view.state.doc.lineAt(from).number, endLine: view.state.doc.lineAt(to).number });
	});
	return ranges.sort((a, b) => a.startLine - b.startLine);
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 300));
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("open-restore via the plugin's file-open handler", () => {
	it("G8 hash unchanged: applies the stored fold verbatim, with no re-match and no store write", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = {
			value: {
				version: 1,
				files: {
					[NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] },
				},
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();
		const beforeEntry = plugin.store.get(NOTE_PATH);

		const view = makeView(TEXT_V1);
		openFile(app, NOTE_PATH, view);
		await settle();

		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 1, endLine: 2 }]); // "## Tuesday" folded
		expect(plugin.store.get(NOTE_PATH)).toBe(beforeEntry); // untouched — no re-match, no write
		expect(view.state.doc.toString()).toBe(TEXT_V1); // F1: only fold state changed, never the text
	});

	it("G8 hash unchanged: never unfolds a fold Obsidian's own native restore already applied", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = {
			value: {
				version: 1,
				files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } },
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		const view = makeView(TEXT_V1);
		// Simulate Obsidian's own native per-session restore already folding "## Wednesday" —
		// something this plugin never stored, and must leave alone when the hash is unchanged.
		const wedFrom = view.state.doc.line(3).to;
		const wedTo = view.state.doc.line(4).to;
		view.dispatch({ effects: foldEffect.of({ from: wedFrom, to: wedTo }) });

		openFile(app, NOTE_PATH, view);
		await settle();

		expect(liveFoldedLineRanges(view)).toEqual([
			{ startLine: 1, endLine: 2 },
			{ startLine: 3, endLine: 4 },
		]);
		expect(view.state.doc.toString()).toBe(TEXT_V1); // F1: only fold state changed, never the text
	});

	it("G8 hash changed + E4: re-matches the stored anchor to its new location and unfolds a stale native fold not in the matched set", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = {
			value: {
				version: 1,
				files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } },
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		// TEXT_V2 has an extra line above "## Tuesday" — the stored hash (from TEXT_V1) no longer
		// matches, so this is the re-match branch.
		const view = makeView(TEXT_V2);
		// Obsidian's native restore reapplied the OLD line-numbered fold (line 1-2, "## Tuesday"'s
		// position in TEXT_V1) to this fresh pane — now a stale offset that actually covers the
		// inserted line and the real "## Tuesday" line, not Tuesday's own content.
		const staleFrom = view.state.doc.line(1).to;
		const staleTo = view.state.doc.line(2).to;
		view.dispatch({ effects: foldEffect.of({ from: staleFrom, to: staleTo }) });

		openFile(app, NOTE_PATH, view);
		await settle();

		// "## Tuesday" is now line 2-3 in TEXT_V2; the matcher re-finds it there by its anchor
		// key (heading text "tuesday"), and the stale line-1 offset is gone.
		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 2, endLine: 3 }]);
		const after = plugin.store.get(NOTE_PATH);
		expect(after?.contentHash).toBe(hashText(TEXT_V2));
		expect(view.state.doc.toString()).toBe(TEXT_V2); // F1: only fold state changed, never the text
	});

	it("G8 hash changed + E4: equal line count, changed content — the stored anchor still re-matches its new location", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = {
			value: {
				version: 1,
				files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } },
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		// TEXT_V3 has exactly as many lines as TEXT_V1 (4) — only the order and wording changed —
		// so the stored hash (from TEXT_V1) still no longer matches: the re-match branch, with no
		// line-count change to give it away.
		expect(TEXT_V3.split("\n").length).toBe(TEXT_V1.split("\n").length);
		const view = makeView(TEXT_V3);
		// Obsidian's native restore reapplied the OLD line-numbered fold (line 1-2, "## Tuesday"'s
		// position in TEXT_V1) to this fresh pane — now a stale offset that actually covers
		// "## Wednesday" and its body, not Tuesday's own content at all.
		const staleFrom = view.state.doc.line(1).to;
		const staleTo = view.state.doc.line(2).to;
		view.dispatch({ effects: foldEffect.of({ from: staleFrom, to: staleTo }) });

		openFile(app, NOTE_PATH, view);
		await settle();

		// "## Tuesday" is now lines 3-4 in TEXT_V3; the matcher re-finds it there by anchor key
		// (heading text "tuesday"), and the stale lines-1-2 offset (now "## Wednesday") is gone.
		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 3, endLine: 4 }]);
		const after = plugin.store.get(NOTE_PATH);
		expect(after?.contentHash).toBe(hashText(TEXT_V3));
		expect(view.state.doc.toString()).toBe(TEXT_V3); // F1: only fold state changed, never the text
	});

	it("T1: a native restore that arrives after file-open's own synchronous handlers run is still corrected, and the spurious anchor it would otherwise plant is cleaned up", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = {
			value: {
				version: 1,
				files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } },
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		// Same TEXT_V3 reorder as the test above (equal line count, "## Tuesday" moved to
		// lines 3-4), but this time nothing is folded before file-open at all: real Obsidian's
		// own native restore for this exact scenario has been observed, live, to land only
		// *after* file-open's own synchronous handlers already ran (T1), not before. Simulated
		// here as an untagged transaction dispatched a few ms into the open — through the
		// plugin's own `createEditorWatcher` extension, the same one a real pane runs, so the
		// spurious-anchor side effect (src/fold-recorder.ts recording it as a fresh user fold)
		// is exercised for real, not assumed away.
		const watcher = createEditorWatcher({ store: plugin.store, window });
		const state = EditorState.create({
			doc: TEXT_V3,
			extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
		});
		const view = new EditorView({ state, parent: document.body });

		openFile(app, NOTE_PATH, view);
		// Gives restoreOnOpen's own (microtask-fast, nothing to chunk here) initial match and
		// dispatch time to finish correctly folding "## Tuesday" before the late arrival lands.
		await new Promise((resolve) => setTimeout(resolve, 10));

		const staleFrom = view.state.doc.line(1).to;
		const staleTo = view.state.doc.line(2).to;
		// Deliberately untagged (no OWN_FOLD_ANNOTATION) — this is what a late, genuinely
		// native restore transaction looks like to src/fold-recorder.ts.
		view.dispatch({ effects: foldEffect.of({ from: staleFrom, to: staleTo }) });

		await settle();

		// scheduleNativeRestoreGuard's next check (src/open-restore.ts) notices the live state
		// no longer agrees with the matched set and corrects it: "## Tuesday" (lines 3-4) folded,
		// the stale "## Wednesday" offset (lines 1-2) gone.
		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 3, endLine: 4 }]);

		// Without the T1 fix, the untagged late transaction above gets recorded by
		// src/fold-recorder.ts as a fresh user fold of "## Wednesday"; cleanupSpuriousNativeFolds
		// (src/open-restore.ts) removes exactly that entry instead of leaving it to linger in
		// data.json as a legitimate anchor nothing will ever correctly apply again.
		const after = plugin.store.get(NOTE_PATH);
		expect(after?.folds).toHaveLength(1);
		expect((after?.folds[0] as unknown as { text: string }).text).toBe("tuesday");
		expect(view.state.doc.toString()).toBe(TEXT_V3); // F1: only fold state changed, never the text
	}, 10000);

	it("T8: scheduleNativeRestoreGuard re-resolves the live EditorView fresh at each check (resolveView), and its onLayoutReady-triggered check corrects a native restore that lands only once Obsidian's own layout-ready event fires, not just at the two fixed delays", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = {
			value: {
				version: 1,
				files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } },
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		// Same TEXT_V3 reorder as the T1 test above: equal line count, "## Tuesday" moved to
		// lines 3-4. The pane that was active at file-open time (viewA) gets restoreOnOpen's
		// own correct initial dispatch; nothing ever folds anything stale on it directly.
		const viewA = makeView(TEXT_V3);
		openFile(app, NOTE_PATH, viewA);
		await settle();
		expect(liveFoldedLineRanges(viewA)).toEqual([{ startLine: 3, endLine: 4 }]);

		// Simulate real Obsidian swapping the pane's own editor for a different EditorView
		// instance showing the same file (T8's own theory for why the old, fixed-delay-only
		// guard was found never correcting anything live against a real relaunch: the one
		// `view` reference it closed over at file-open time had gone stale by the time any
		// check actually ran). The workspace's active editor now resolves to viewB, not the
		// original viewA.
		const viewB = makeView(TEXT_V3);
		const replacementPane = new MockMarkdownView();
		replacementPane.file = new MockTFile(NOTE_PATH);
		replacementPane.editor = new MockEditor(viewB);
		(app.workspace as unknown as MockWorkspace).setActiveView(replacementPane);

		// The late native restore lands on viewB (the replacement), as an untagged
		// transaction — never on viewA, which nothing in this scenario ever touches again.
		const staleFrom = viewB.state.doc.line(1).to;
		const staleTo = viewB.state.doc.line(2).to;
		viewB.dispatch({ effects: foldEffect.of({ from: staleFrom, to: staleTo }) });
		expect(liveFoldedLineRanges(viewB)).toEqual([{ startLine: 1, endLine: 2 }]); // stale, uncorrected so far

		// Obsidian's own "layout is actually ready" event — what scheduleNativeRestoreGuard's
		// onLayoutReady-triggered check is tied to. It was registered the moment restoreOnOpen
		// ran above, queued (not yet fired) since the mock workspace starts with layout not
		// ready — exactly like a real relaunch, where layout only becomes ready partway
		// through startup, potentially well after file-open already fired for a restored pane.
		(app.workspace as unknown as MockWorkspace).triggerLayoutReady();

		// Without T8's fix, this check would still be looking at the stale viewA reference
		// (already correct, so a no-op) and viewB's stale fold would never be touched. With
		// resolveView re-resolving the *current* active editor, the check corrects viewB
		// instead.
		expect(liveFoldedLineRanges(viewB)).toEqual([{ startLine: 3, endLine: 4 }]);
		// viewA, never touched again, is untouched by this correction.
		expect(liveFoldedLineRanges(viewA)).toEqual([{ startLine: 3, endLine: 4 }]);
	}, 10000);

	it("R8: a matched block with the cursor already inside it at open stays unfolded (G13) through the whole native-restore-guard window, with no fold effect dispatched around the cursor", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = {
			value: {
				version: 1,
				files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } },
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		// TEXT_V3: "## Tuesday" is now lines 3-4. Put the cursor inside that block (line 4,
		// Tuesday's own body) before file-open ever fires — G13's "already inside" case.
		const view = makeView(TEXT_V3);
		const cursorPos = view.state.doc.line(4).from;
		view.dispatch({ selection: { anchor: cursorPos } });

		openFile(app, NOTE_PATH, view);

		// Deferred at open (G13): nothing folded yet.
		expect(liveFoldedLineRanges(view)).toEqual([]);

		// R8's own bug folded this anyway, around the cursor, the moment the native-restore
		// guard's onLayoutReady-triggered check ran — because that check reused `matchedRanges`
		// (which deliberately includes G13-deferred ranges) to decide what to fold. Firing
		// onLayoutReady immediately, *and* letting the two fixed-delay checks run too, exercises
		// every one of the guard's checks against this same cursor position.
		(app.workspace as unknown as MockWorkspace).triggerLayoutReady();
		expect(liveFoldedLineRanges(view)).toEqual([]); // still unfolded right after the immediate check
		await settle();
		expect(liveFoldedLineRanges(view)).toEqual([]); // and after the 50ms/300ms checks too
		expect(view.state.doc.toString()).toBe(TEXT_V3); // F1
	}, 10000);

	it("R8: the guard never refolds a matched block the user unfolds inside its window", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = {
			value: {
				version: 1,
				files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } },
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		// Same wiring as the T1/T8 tests above: the real createEditorWatcher extension, so a
		// genuinely untagged (no OWN_FOLD_ANNOTATION) unfold dispatched below is recorded by
		// src/fold-recorder.ts exactly the way a real user unfold would be.
		const watcher = createEditorWatcher({ store: plugin.store, window });
		const state = EditorState.create({
			doc: TEXT_V3,
			extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
		});
		const view = new EditorView({ state, parent: document.body });

		openFile(app, NOTE_PATH, view);
		// restoreOnOpen's own initial dispatch folds "## Tuesday" (lines 3-4) synchronously —
		// give it a moment to settle before the user acts, same as the T1 test above.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 3, endLine: 4 }]);

		// The user manually unfolds it, well inside the guard's own window — untagged, exactly
		// like a real click on the fold indicator.
		const from = view.state.doc.line(3).to;
		const to = view.state.doc.line(4).to;
		view.dispatch({ effects: unfoldEffect.of({ from, to }) });
		expect(liveFoldedLineRanges(view)).toEqual([]);

		await settle();

		// R8's own bug re-folded this on the guard's very next check, because a target the
		// guard had never explicitly tracked as "live, then not" was simply refolded again.
		expect(liveFoldedLineRanges(view)).toEqual([]);
		expect(view.state.doc.toString()).toBe(TEXT_V3); // F1
	}, 10000);

	it("R8: the guard never unfolds, or deletes the stored anchor for, a block the user folds inside its window that the plugin never matched", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = {
			value: {
				version: 1,
				files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } },
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		const watcher = createEditorWatcher({ store: plugin.store, window });
		const state = EditorState.create({
			doc: TEXT_V3,
			extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
		});
		const view = new EditorView({ state, parent: document.body });

		openFile(app, NOTE_PATH, view);
		// Let the initial dispatch, and the guard's first (50ms) check, both run and find
		// nothing stale — this is the guard's one real chance to correct a late native-restore
		// arrival (see scheduleNativeRestoreGuard's own doc comment for why the unfold side only
		// ever acts once per open: CM6 gives no way to tell a late native restore apart from a
		// genuine user fold of something the plugin never matched).
		await new Promise((resolve) => setTimeout(resolve, 70));
		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 3, endLine: 4 }]); // "## Tuesday" only

		// The user folds "## Wednesday" (lines 1-2) — a real, legitimate fold of a block the
		// plugin has no stored anchor for at all, well inside the guard's own 300ms window.
		const from = view.state.doc.line(1).to;
		const to = view.state.doc.line(2).to;
		view.dispatch({ effects: foldEffect.of({ from, to }) });
		expect(liveFoldedLineRanges(view)).toEqual([
			{ startLine: 1, endLine: 2 },
			{ startLine: 3, endLine: 4 },
		]);

		// Past the guard's remaining (300ms) check.
		await new Promise((resolve) => setTimeout(resolve, 260));

		// R8's own bug unfolded this on the very next check (it wasn't "known live at open" and
		// wasn't in the matched/protected set either) and deleted the anchor fold-recorder had
		// just planted for it.
		expect(liveFoldedLineRanges(view)).toEqual([
			{ startLine: 1, endLine: 2 },
			{ startLine: 3, endLine: 4 },
		]);
		const after = plugin.store.get(NOTE_PATH);
		expect((after?.folds as unknown as { text: string }[]).some((f) => f.text === "wednesday")).toBe(true);
		expect(view.state.doc.toString()).toBe(TEXT_V3); // F1
	}, 10000);

	it(
		"T19/T20/T22: a native restore that replaces the pane's whole fold state (unfolding the matched target and folding a stale offset, in the same transaction) well after the guard's first check already found nothing stale is still corrected, and the spurious anchor it plants is cleaned up",
		async () => {
			const app = new App();
			(app.vault as unknown as MockVault).setExists(NOTE_PATH);
			const stored = {
				value: {
					version: 1,
					files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } },
				},
			};
			const plugin = makePlugin(app, stored);
			// T19: real production delays (NATIVE_RESTORE_GUARD_DELAYS_MS) run out to 16s so a
			// slow, real relaunch's native restore has time to arrive — shrunk here so the test
			// runs in milliseconds. The first check (10ms) still finds nothing stale, the same
			// one chance the "never unfolds..." test above exercises, well before the late
			// native restore below lands; only a *later* check (40ms) can catch it.
			plugin.guardDelaysMs = [10, 40];
			await plugin.onload();

			// Same wiring as the T1/T8 tests above: the real createEditorWatcher extension, so
			// the spurious-anchor side effect (src/fold-recorder.ts recording the stale fold as
			// a fresh user fold) is exercised for real.
			const watcher = createEditorWatcher({ store: plugin.store, window });
			const state = EditorState.create({
				doc: TEXT_V3,
				extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
			});
			const view = new EditorView({ state, parent: document.body });

			openFile(app, NOTE_PATH, view);
			// Past the 10ms check, which finds "## Tuesday" (lines 3-4) correctly live and
			// nothing else — the guard's simple one-shot decision is already spent here,
			// finding nothing to correct.
			await new Promise((resolve) => setTimeout(resolve, 25));
			expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 3, endLine: 4 }]);

			// Real Obsidian has been observed, live, replacing a pane's whole fold state well
			// after this guard's first check already ran: the plugin's own correctly-matched
			// fold is undone and a stale offset from the file's old (pre-edit) line numbering
			// is applied instead, both in one untagged transaction.
			const staleFrom = view.state.doc.line(1).to;
			const staleTo = view.state.doc.line(2).to;
			const tuesdayFrom = view.state.doc.line(3).to;
			const tuesdayTo = view.state.doc.line(4).to;
			view.dispatch({
				effects: [unfoldEffect.of({ from: tuesdayFrom, to: tuesdayTo }), foldEffect.of({ from: staleFrom, to: staleTo })],
			});
			expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 1, endLine: 2 }]); // stale, uncorrected so far

			// Past the 40ms check — the correlated "target missing + new stale fold" signal
			// (nativeChurn) corrects it even though the simple one-shot already decided.
			await new Promise((resolve) => setTimeout(resolve, 60));

			expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 3, endLine: 4 }]);
			const after = plugin.store.get(NOTE_PATH);
			expect(after?.folds).toHaveLength(1);
			expect((after?.folds[0] as unknown as { text: string }).text).toBe("tuesday");
			expect(view.state.doc.toString()).toBe(TEXT_V3); // F1: only fold state changed, never the text
		},
		10000
	);

	it("G8 hash changed: several stored folds that match nothing all go dormant, leaving the note fully unfolded, without throwing", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		// "task" anchors: TEXT_V1 has no task items at all, so these can never match any
		// candidate regardless of text similarity (deterministically "none", not a borderline
		// fuzzy-threshold call).
		const alienFolds: FileFoldRecord["folds"] = [
			{ kind: "task", indent: 0, text: "buy milk", siblingIndex: 0, parentChain: [] },
			{ kind: "task", indent: 0, text: "walk the dog", siblingIndex: 1, parentChain: [] },
		];
		const stored = {
			value: {
				version: 1,
				files: { [NOTE_PATH]: { contentHash: "stale-hash-forces-rematch", folds: alienFolds, dormant: [] } },
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		const view = makeView(TEXT_V1);
		expect(() => openFile(app, NOTE_PATH, view)).not.toThrow();
		await settle();

		expect(liveFoldedLineRanges(view)).toEqual([]); // fully unfolded — nothing matched, nothing to fold
		expect(view.state.doc.toString()).toBe(TEXT_V1); // F1
		const after = plugin.store.get(NOTE_PATH);
		expect(after?.folds).toEqual([]);
		expect(after?.dormant).toHaveLength(2); // both unmatched anchors demoted to dormant, not dropped
	});

	it("(b) an empty file, a file with no foldable blocks, and a 500-fold file all open through file-open without error", async () => {
		const EMPTY_PATH = "Empty.md";
		const PLAIN_PATH = "Plain.md";
		const LARGE_PATH = "Large.md";
		const PLAIN_TEXT = "Just a plain paragraph.\nAnother plain line, no headings or tasks at all.";
		const LARGE_HEADING_COUNT = 500;
		const largeLines: string[] = [];
		const largeFolds: FileFoldRecord["folds"] = [];
		for (let i = 1; i <= LARGE_HEADING_COUNT; i++) {
			largeLines.push(`## Heading ${i}`, `body for ${i}`);
			largeFolds.push({ kind: "heading", indent: 0, text: `heading ${i}`, siblingIndex: i - 1, parentChain: [] });
		}
		const LARGE_TEXT = largeLines.join("\n");

		const app = new App();
		for (const path of [EMPTY_PATH, PLAIN_PATH, LARGE_PATH]) (app.vault as unknown as MockVault).setExists(path);
		const stored = {
			value: {
				version: 1,
				files: {
					// Hash deliberately stale so each of these exercises the re-match branch, not
					// just the verbatim-apply shortcut.
					[EMPTY_PATH]: { contentHash: "stale", folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] },
					[PLAIN_PATH]: { contentHash: "stale", folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] },
					[LARGE_PATH]: { contentHash: hashText(LARGE_TEXT), folds: largeFolds, dormant: [] },
				},
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		const emptyView = makeView("");
		const plainView = makeView(PLAIN_TEXT);
		const largeView = makeView(LARGE_TEXT);

		expect(() => openFile(app, EMPTY_PATH, emptyView)).not.toThrow();
		expect(() => openFile(app, PLAIN_PATH, plainView)).not.toThrow();
		expect(() => openFile(app, LARGE_PATH, largeView)).not.toThrow();
		await settle();

		expect(liveFoldedLineRanges(emptyView)).toEqual([]);
		expect(emptyView.state.doc.toString()).toBe("");
		expect(liveFoldedLineRanges(plainView)).toEqual([]);
		expect(plainView.state.doc.toString()).toBe(PLAIN_TEXT);

		// The 500-fold file: hash unchanged, so applyStoredFoldsVerbatim runs directly — every
		// one of the 500 stored headings folds, up to and including the cap (MAX_FOLDS).
		const largeFolded = liveFoldedLineRanges(largeView);
		expect(largeFolded.length).toBe(LARGE_HEADING_COUNT);
		expect(largeView.state.doc.toString()).toBe(LARGE_TEXT);
	}, 10000);

	it("a file with no stored entry is left entirely alone (no throw, no store write)", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = { value: { version: 1, files: {} } };
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		const view = makeView(TEXT_V1);
		expect(() => openFile(app, NOTE_PATH, view)).not.toThrow();
		await settle();

		expect(liveFoldedLineRanges(view)).toEqual([]);
		expect(plugin.store.get(NOTE_PATH)).toBeUndefined();
	});

	it("G11, a second pane opened right after the first: both panes end up with the same folds", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = {
			value: {
				version: 1,
				files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } },
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		const firstPane = makeView(TEXT_V1);
		openFile(app, NOTE_PATH, firstPane);
		const secondPane = makeView(TEXT_V1);
		openFile(app, NOTE_PATH, secondPane);
		await settle();

		const expected = [{ startLine: 1, endLine: 2 }];
		expect(liveFoldedLineRanges(firstPane)).toEqual(expected);
		expect(liveFoldedLineRanges(secondPane)).toEqual(expected);
	});

	it("no active markdown editor for the opened file: does nothing, does not throw", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const stored = {
			value: {
				version: 1,
				files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } },
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		// No setActiveView call at all — activeEditor stays null.
		expect(() => (app.workspace as unknown as MockWorkspace).trigger("file-open", new MockTFile(NOTE_PATH))).not.toThrow();
		await settle();

		expect(plugin.store.get(NOTE_PATH)).toEqual({ contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] });
	});

	it("file-open fires for null (nothing active): does nothing, does not throw", async () => {
		const app = new App();
		const plugin = makePlugin(app, { value: { version: 1, files: {} } });
		await plugin.onload();

		expect(() => (app.workspace as unknown as MockWorkspace).trigger("file-open", null)).not.toThrow();
		await settle();
	});
});
