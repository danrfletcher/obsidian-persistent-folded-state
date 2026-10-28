/**
 * PR-7 (G8/E4): a CM6 EditorView over fixture notes opened through the plugin's real
 * `file-open` handler (`src/main.ts`'s `workspace.on("file-open", ...)` -> `restoreOnOpen`), not
 * `restoreOnOpen` called directly. Mocks `app.workspace.activeEditor`/`getAbstractFileByPath`
 * with an in-memory setup (`tests/mocks/obsidian.ts`'s `Workspace`/`MarkdownView`/`Editor`)
 * rather than a real filesystem — this file exercises the actual wiring decision (G8 hash
 * compare, re-match, E4 native-restore replacement), not just `src/open-restore.ts`'s pure
 * decision logic in isolation.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState, type Extension } from "@codemirror/state";
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
import { FoldStore, hashText } from "../../src/fold-store";
import { restoreOnOpen } from "../../src/open-restore";
import { addDormant, MAX_DORMANT_AGE_MS } from "../../src/dormant";
import { LOAD_WAIT_GIVE_UP_MS } from "../../src/load-wait";
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
 * `file-open` handler reads (`workspace.activeEditor.editor.cm`), and fires the event.
 *
 * Warkworth-46 PR-2: the open pass now compares the editor with the note's text on disk
 * (`vault.adapter.read`), so the mock vault needs that text. `diskText` sets it; without it, a note
 * the test has not given any text is taken to be on disk exactly as the view shows it, which is the
 * "fully loaded pane" every case here was written for. */
function openFile(app: App, path: string, view: EditorView, diskText?: string): MockMarkdownView {
	const vault = app.vault as unknown as MockVault;
	if (diskText !== undefined) vault.setContent(path, diskText);
	else if (!vault.hasContent(path)) vault.setContent(path, view.state.doc.toString());
	const file = new MockTFile(path);
	const markdownView = new MockMarkdownView();
	markdownView.file = file;
	markdownView.editor = new MockEditor(view);
	const workspace = app.workspace as unknown as MockWorkspace;
	workspace.addLeaf(markdownView);
	workspace.setActiveView(markdownView);
	workspace.trigger("file-open", file);
	return markdownView;
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

// --- The diagnostic log's `open` lines (warkworth-46 PR-1, GP6, F4, E16) ----------------------

describe("diagnostic log: restoreOnOpen logs one `open` line per pass", () => {
	const LOG_PATH = ".obsidian/plugins/persistent-folded-state/diagnostic-log.jsonl";
	const MARKER = "OPEN-MARKER-5d2e";

	async function openWithLog(
		text: string,
		record: FileFoldRecord,
		breakAdapter?: (adapter: MockVault["adapter"]) => void,
	) {
		const app = new App();
		const vault = app.vault as unknown as MockVault;
		vault.setExists(NOTE_PATH);
		breakAdapter?.(vault.adapter);
		const plugin = makePlugin(app, { value: { version: 1, files: { [NOTE_PATH]: record } } });
		await plugin.onload();
		const view = makeView(text);
		openFile(app, NOTE_PATH, view);
		await settle();
		// A never-resolving adapter never drains: the pass has finished either way, so don't wait on it.
		await Promise.race([plugin.diagnosticLog?.drain(), new Promise((resolve) => setTimeout(resolve, 20))]);
		const lines = logLinesOf(vault.adapter.files.get(LOG_PATH));
		return { plugin, view, lines, vault };
	}

	function logLinesOf(raw: string | undefined): Record<string, unknown>[] {
		return (raw ?? "")
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	}

	it("verbatim path (hash unchanged): one `applied` line, counts from the store before and after", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { view, lines } = await openWithLog(TEXT_V1, record);

		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 1, endLine: 2 }]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			path: NOTE_PATH,
			pass: "open",
			editorLen: TEXT_V1.length,
			diskLen: TEXT_V1.length,
			foldsBefore: 1,
			dormantBefore: 0,
			foldsAfter: 1,
			dormantAfter: 0,
			outcome: "applied",
		});
		expect(typeof lines[0].t).toBe("string");
		expect(new Date(lines[0].t as string).toISOString()).toBe(lines[0].t);
	});

	it("re-match path (hash changed): one `rematched` line with the counts after the store write", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { plugin, view, lines } = await openWithLog(TEXT_V2, record);

		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 2, endLine: 3 }]);
		expect(plugin.store.get(NOTE_PATH)?.contentHash).toBe(hashText(TEXT_V2));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			pass: "open",
			outcome: "rematched",
			editorLen: TEXT_V2.length,
			diskLen: TEXT_V2.length,
			foldsBefore: 1,
			dormantBefore: 0,
			foldsAfter: 1,
			dormantAfter: 0,
		});
	});

	it("re-match path with a fold that no longer matches: the set-aside count goes up", async () => {
		const gone = { kind: "heading", indent: 0, text: "zzz qqq www completely different", siblingIndex: 0, parentChain: [] };
		const record = {
			contentHash: hashText(TEXT_V1),
			folds: [tuesdayAnchorFor(TEXT_V1), gone as unknown as FileFoldRecord["folds"][number]],
			dormant: [],
		};
		const { lines } = await openWithLog(TEXT_V2, record);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ outcome: "rematched", foldsBefore: 2, dormantBefore: 0, foldsAfter: 1, dormantAfter: 1 });
	});

	it("reopening logs one more line each time", async () => {
		const app = new App();
		const vault = app.vault as unknown as MockVault;
		vault.setExists(NOTE_PATH);
		const plugin = makePlugin(app, {
			value: { version: 1, files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } } },
		});
		await plugin.onload();
		for (let i = 0; i < 3; i++) {
			openFile(app, NOTE_PATH, makeView(TEXT_V1));
			await settle();
		}
		await plugin.diagnosticLog?.drain();
		expect(logLinesOf(vault.adapter.files.get(LOG_PATH))).toHaveLength(3);
	});

	it("the note's text never reaches the log", async () => {
		const text = `## Tuesday\n${MARKER} under Tuesday.\n## Wednesday\nMore.`;
		const record = { contentHash: hashText(text), folds: [tuesdayAnchorFor(text)], dormant: [] };
		const { vault, lines } = await openWithLog(text, record);
		expect(lines).toHaveLength(1);
		const raw = vault.adapter.files.get(LOG_PATH) as string;
		for (const secret of [MARKER, "Tuesday", "tuesday", "Wednesday", "More."]) expect(raw).not.toContain(secret);
		expect(Object.keys(lines[0])).toEqual([
			"t", "path", "pass", "editorLen", "diskLen", "foldsBefore", "dormantBefore", "foldsAfter", "dormantAfter", "outcome",
		]);
	});

	it.each([
		{ label: "a rejecting adapter", fail: (a: MockVault["adapter"]) => void (a.failWith = new Error("disk full")) },
		{ label: "a synchronously throwing adapter", fail: (a: MockVault["adapter"]) => void (a.throwSync = true) },
		{ label: "a never-resolving adapter", fail: (a: MockVault["adapter"]) => void (a.hang = true) },
	])("E16: $label leaves the verbatim and re-match passes unchanged", async ({ fail }) => {
		const verbatim = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const good = await openWithLog(TEXT_V1, verbatim);
		const bad = await openWithLog(TEXT_V1, verbatim, fail);
		expect(liveFoldedLineRanges(bad.view)).toEqual(liveFoldedLineRanges(good.view));
		expect(bad.plugin.store.get(NOTE_PATH)).toEqual(good.plugin.store.get(NOTE_PATH));
		expect(bad.lines).toEqual([]); // nothing reached the file, and nothing broke

		const changed = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const goodMatch = await openWithLog(TEXT_V2, changed);
		const badMatch = await openWithLog(TEXT_V2, changed, fail);
		expect(liveFoldedLineRanges(badMatch.view)).toEqual(liveFoldedLineRanges(goodMatch.view));
		expect(badMatch.plugin.store.get(NOTE_PATH)).toEqual(goodMatch.plugin.store.get(NOTE_PATH));
		expect(badMatch.view.state.doc.toString()).toBe(TEXT_V2);
	});
});

// --- Warkworth-46 PR-2: the open pass waits for the editor to hold the note's real text ------------
//
// A real CM6 `EditorView` is built with an EMPTY document, file-open is triggered, and the full text
// lands later in an ordinary `view.dispatch({ changes })`, the shape proven live in Dan's vault
// (the pane is empty at file-open; the text arrives about 35 ms later).

describe("open-restore waits for the real text (warkworth-46 PR-2)", () => {
	const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
	const BIG_PATH = "Competitive Coding Fundamentals/Competitive Coding Fundamentals.md";
	const BIG_LF = readFileSync(join(FIXTURES, "competitive-coding-140.md"), "utf8");
	const BIG_CRLF = readFileSync(join(FIXTURES, "competitive-coding-140-crlf.md"), "utf8");
	const LOG_PATH = ".obsidian/plugins/persistent-folded-state/diagnostic-log.jsonl";
	const MARKER = "WAIT-MARKER-91c4";
	const OTHER_PATH = "Projects/Quarry/Other.md";
	const THREE = ["## Alpha", "alpha body", "## Beta", "beta body", "## Gamma", "gamma body"].join("\n");

	/** Every foldable lesson task in the 140-fold fixture, as a stored anchor. */
	function lessonAnchors(text: string): FileFoldRecord["folds"] {
		return buildAnchors(text)
			.filter((c) => c.anchor.kind === "task" && c.range.endLine > c.range.startLine)
			.map((c) => c.anchor as unknown as FileFoldRecord["folds"][number]);
	}

	function headingAnchor(text: string, heading: string): FileFoldRecord["folds"][number] {
		const found = buildAnchors(text).find((c) => c.anchor.kind === "heading" && c.anchor.text === heading);
		if (!found) throw new Error(`no heading ${heading}`);
		return found.anchor as unknown as FileFoldRecord["folds"][number];
	}

	async function boot(files: Record<string, FileFoldRecord>) {
		const app = new App();
		const vault = app.vault as unknown as MockVault;
		for (const path of Object.keys(files)) vault.setExists(path);
		const stored = { value: { version: 1, files } as unknown };
		const plugin = makePlugin(app, stored);
		await plugin.onload();
		const setSpy = vi.spyOn(plugin.store, "set");
		return { app, vault, stored, plugin, setSpy };
	}

	/** A view over `text` that counts the transactions carrying a fold or unfold effect. */
	function observedView(text: string, extensions: Extension[] = []) {
		let foldTransactions = 0;
		const state = EditorState.create({
			doc: text,
			extensions: [
				codeFolding(),
				EditorView.updateListener.of((update) => {
					for (const tr of update.transactions) {
						if (tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect))) foldTransactions++;
					}
				}),
				...extensions,
			],
		});
		const view = new EditorView({ state, parent: document.body });
		return { view, foldTransactions: () => foldTransactions };
	}

	/** The text arrives in a later transaction, the way Obsidian delivers it. */
	function land(view: EditorView, text: string): void {
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
	}

	const pause = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

	async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
		const start = Date.now();
		while (!condition()) {
			if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
			await pause(10);
		}
	}

	async function logOf(plugin: PersistentFoldedStatePlugin, vault: MockVault): Promise<Record<string, unknown>[]> {
		await plugin.diagnosticLog?.drain();
		return (vault.adapter.files.get(LOG_PATH) ?? "")
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	}

	const outcomes = (lines: Record<string, unknown>[]): unknown[] => lines.map((l) => l.outcome);

	afterEach(() => {
		vi.useRealTimers();
	});

	it("fixtures: the 140-fold note has 140 foldable lessons and its CRLF copy is the same note", () => {
		expect(lessonAnchors(BIG_LF)).toHaveLength(140);
		expect(BIG_LF).not.toContain("\r");
		expect(BIG_CRLF).toContain("\r\n");
		expect(BIG_CRLF.replace(/\r\n/g, "\n")).toBe(BIG_LF);
		expect(hashText(BIG_CRLF)).toBe(hashText(BIG_LF));
	});

	it("GP1: closing the note and opening others leaves the store exactly as it was", async () => {
		const bigRecord = { contentHash: hashText(BIG_LF), folds: lessonAnchors(BIG_LF), dormant: [] };
		const otherRecord = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, stored, plugin, setSpy } = await boot({ [BIG_PATH]: bigRecord, [OTHER_PATH]: otherRecord });
		const before = JSON.stringify(stored.value);
		const bigEntry = plugin.store.get(BIG_PATH);

		const big = makeView(BIG_LF);
		openFile(app, BIG_PATH, big);
		await until(() => liveFoldedLineRanges(big).length === 140);
		big.destroy(); // closing the note
		const other = makeView(TEXT_V1);
		openFile(app, OTHER_PATH, other);
		openFile(app, "Projects/Quarry/NoEntry.md", makeView("No folds stored for this one.\n"));
		await pause(50);
		await plugin.store.flush();

		expect(setSpy).not.toHaveBeenCalled();
		expect(JSON.stringify(stored.value)).toBe(before);
		expect(plugin.store.get(BIG_PATH)).toBe(bigEntry);
		expect(plugin.store.get(BIG_PATH)?.folds).toHaveLength(140);
	});

	it("GP2: file-open on an empty editor, the 140-fold text lands later: every fold shows, nothing is set aside, the hash is the real one", async () => {
		const record = { contentHash: hashText(BIG_LF), folds: lessonAnchors(BIG_LF), dormant: [] };
		const { app, vault, plugin, setSpy } = await boot({ [BIG_PATH]: record });
		const entry = plugin.store.get(BIG_PATH);

		const { view, foldTransactions } = observedView("");
		openFile(app, BIG_PATH, view, BIG_LF);
		await pause(50);

		// While the editor is empty: nothing happened.
		expect(setSpy).not.toHaveBeenCalled();
		expect(foldTransactions()).toBe(0);
		expect(plugin.store.get(BIG_PATH)).toBe(entry);

		land(view, BIG_LF);
		await until(() => liveFoldedLineRanges(view).length === 140);

		const after = plugin.store.get(BIG_PATH);
		expect(after?.folds).toHaveLength(140);
		expect(after?.dormant).toHaveLength(0);
		expect(after?.contentHash).toBe(hashText(BIG_LF));
		expect(setSpy).not.toHaveBeenCalled(); // hash unchanged: stored folds applied verbatim
		expect(view.state.doc.toString()).toBe(BIG_LF);

		const lines = await logOf(plugin, vault);
		expect(outcomes(lines)).toEqual(["waiting", "applied"]);
		expect(lines.every((l) => l.pass === "open" && l.path === BIG_PATH)).toBe(true);
		expect(lines[0]).toMatchObject({ editorLen: 0, diskLen: BIG_LF.length, foldsBefore: 140, foldsAfter: 140 });
		expect(lines[1]).toMatchObject({ editorLen: BIG_LF.length, diskLen: BIG_LF.length, foldsBefore: 140, dormantAfter: 0 });
	});

	it("GP2 x10: reopening ten times in a row never drops a fold or leaves anything set aside", async () => {
		const record = { contentHash: hashText(BIG_LF), folds: lessonAnchors(BIG_LF), dormant: [] };
		const { app, vault, plugin, setSpy } = await boot({ [BIG_PATH]: record });
		for (let i = 0; i < 10; i++) {
			const { view } = observedView("");
			openFile(app, BIG_PATH, view, BIG_LF);
			await pause(5);
			land(view, BIG_LF);
			await until(() => liveFoldedLineRanges(view).length === 140);
			expect(plugin.store.get(BIG_PATH)?.dormant).toHaveLength(0);
			expect(plugin.store.get(BIG_PATH)?.folds).toHaveLength(140);
			view.destroy();
		}
		expect(setSpy).not.toHaveBeenCalled();
		const lines = await logOf(plugin, vault);
		expect(lines.filter((l) => l.outcome === "refused-empty" || l.outcome === "gave-up")).toEqual([]);
		expect(lines.filter((l) => l.outcome === "applied")).toHaveLength(10);
	});

	it("E1: an empty editor over a non-empty file runs no pass and never calls store.set; the pass runs once the text matches", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, plugin, setSpy } = await boot({ [NOTE_PATH]: record });
		const entry = plugin.store.get(NOTE_PATH);

		const { view, foldTransactions } = observedView("");
		openFile(app, NOTE_PATH, view, TEXT_V1);
		await pause(60);
		expect(setSpy).not.toHaveBeenCalled();
		expect(foldTransactions()).toBe(0);
		expect(liveFoldedLineRanges(view)).toEqual([]);

		land(view, TEXT_V1);
		await until(() => liveFoldedLineRanges(view).length === 1);
		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 1, endLine: 2 }]);
		expect(plugin.store.get(NOTE_PATH)).toBe(entry); // verbatim: no re-match, no write
		expect(setSpy).not.toHaveBeenCalled();
	});

	it.each([
		{ label: "a prefix of the file", partial: TEXT_V1.slice(0, 14) },
		{ label: "same length but different text", partial: TEXT_V1.replace("Tuesday", "Tuesdaz") },
		{ label: "the full text with one character missing", partial: TEXT_V1.slice(0, -1) },
		{ label: "the full text with one character missing in the middle", partial: TEXT_V1.slice(0, 5) + TEXT_V1.slice(6) },
	])("E4: a half-loaded editor ($label) is not loaded: no pass, no store write, until the real text lands", async ({ partial }) => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, plugin, setSpy } = await boot({ [NOTE_PATH]: record });
		const entry = plugin.store.get(NOTE_PATH);

		const { view, foldTransactions } = observedView("");
		openFile(app, NOTE_PATH, view, TEXT_V1);
		await pause(20);
		land(view, partial);
		await pause(60);
		expect(foldTransactions()).toBe(0);
		expect(setSpy).not.toHaveBeenCalled();
		expect(plugin.store.get(NOTE_PATH)).toBe(entry);

		land(view, TEXT_V1);
		await until(() => liveFoldedLineRanges(view).length === 1);
		expect(setSpy).not.toHaveBeenCalled();
		expect(plugin.store.get(NOTE_PATH)).toBe(entry);
	});

	it("E5: a reused pane still showing the previous note's text does not match the new note's folds against it", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, plugin, setSpy } = await boot({ [NOTE_PATH]: record });
		const entry = plugin.store.get(NOTE_PATH);
		const OLD_NOTE = "## Tuesday\nThis is the PREVIOUS note's Tuesday.\n## Elsewhere\nOther text.";

		const { view, foldTransactions } = observedView(OLD_NOTE);
		openFile(app, NOTE_PATH, view, TEXT_V1);
		await pause(80);
		expect(foldTransactions()).toBe(0);
		expect(liveFoldedLineRanges(view)).toEqual([]);
		expect(setSpy).not.toHaveBeenCalled();
		expect(plugin.store.get(NOTE_PATH)).toBe(entry);

		land(view, TEXT_V1);
		await until(() => liveFoldedLineRanges(view).length === 1);
		expect(setSpy).not.toHaveBeenCalled();
	});

	it("E5: the right text in a pane that still shows another file is not loaded until the pane shows this file", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, plugin, setSpy } = await boot({ [NOTE_PATH]: record });
		const { view, foldTransactions } = observedView(TEXT_V1);
		const pane = openFile(app, NOTE_PATH, view, TEXT_V1);
		pane.file = new MockTFile("Projects/Quarry/Previous.md"); // the leaf's file is not this note yet
		await pause(80);
		expect(foldTransactions()).toBe(0);
		expect(setSpy).not.toHaveBeenCalled();

		pane.file = new MockTFile(NOTE_PATH);
		await until(() => liveFoldedLineRanges(view).length === 1, 3000);
		expect(plugin.store.get(NOTE_PATH)?.folds).toHaveLength(1);
	});

	it("E9: a CRLF note on disk with LF text in the editor counts as loaded; unchanged hash applies the folds verbatim", async () => {
		const record = { contentHash: hashText(BIG_CRLF), folds: lessonAnchors(BIG_LF), dormant: [] };
		const { app, vault, plugin, setSpy } = await boot({ [BIG_PATH]: record });
		const entry = plugin.store.get(BIG_PATH);

		const { view } = observedView(BIG_LF); // LF in the editor
		openFile(app, BIG_PATH, view, BIG_CRLF); // CRLF on disk
		await until(() => liveFoldedLineRanges(view).length === 140);

		expect(plugin.store.get(BIG_PATH)).toBe(entry);
		expect(setSpy).not.toHaveBeenCalled(); // no re-match
		const lines = await logOf(plugin, vault);
		expect(outcomes(lines)).toEqual(["applied"]);
		expect(lines[0]).toMatchObject({ editorLen: BIG_LF.length, diskLen: BIG_CRLF.length });
	});

	it("E10: 30 s without the text matching: one `gave-up` line, nothing set aside, hash not rewritten, no fold effect dispatched", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, vault, plugin, setSpy } = await boot({ [NOTE_PATH]: record });
		const entry = plugin.store.get(NOTE_PATH);
		const { view, foldTransactions } = observedView("");
		vi.useFakeTimers();

		openFile(app, NOTE_PATH, view, TEXT_V1);
		await vi.advanceTimersByTimeAsync(LOAD_WAIT_GIVE_UP_MS - 1);
		expect((await logOf(plugin, vault)).map((l) => l.outcome)).toEqual(["waiting"]);

		await vi.advanceTimersByTimeAsync(1);
		const lines = await logOf(plugin, vault);
		expect(lines.filter((l) => l.outcome === "gave-up")).toHaveLength(1);
		expect(lines.find((l) => l.outcome === "gave-up")).toMatchObject({
			path: NOTE_PATH,
			pass: "open",
			editorLen: 0,
			diskLen: TEXT_V1.length,
			foldsBefore: 1,
			dormantBefore: 0,
			foldsAfter: 1,
			dormantAfter: 0,
		});
		expect(setSpy).not.toHaveBeenCalled();
		expect(plugin.store.get(NOTE_PATH)).toBe(entry);
		expect(plugin.store.get(NOTE_PATH)?.contentHash).toBe(hashText(TEXT_V1));
		expect(foldTransactions()).toBe(0);

		// Given up means given up: text arriving afterwards starts no pass.
		land(view, TEXT_V1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(foldTransactions()).toBe(0);
		expect(setSpy).not.toHaveBeenCalled();
		expect((await logOf(plugin, vault)).filter((l) => l.outcome === "gave-up")).toHaveLength(1);
	});

	it("E11: a fold and an unfold made by hand during the wait are recorded as today and win over the later pass", async () => {
		const record = {
			contentHash: hashText(THREE),
			folds: [headingAnchor(THREE, "alpha"), headingAnchor(THREE, "beta"), headingAnchor(THREE, "gamma")],
			dormant: [],
		};
		const { app, plugin } = await boot({ [NOTE_PATH]: record });
		const prefix = THREE.split("\n").slice(0, 4).join("\n"); // Alpha and Beta have arrived; Gamma has not
		const watcher = createEditorWatcher({ store: plugin.store, window });
		const { view } = observedView(prefix, [watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))]);
		openFile(app, NOTE_PATH, view, THREE);
		await pause(40);

		// Dan folds "Beta" (lines 3-4) and unfolds "Alpha" (lines 1-2) by hand, untagged like a gutter click.
		view.dispatch({ effects: foldEffect.of({ from: view.state.doc.line(3).to, to: view.state.doc.line(4).to }) });
		view.dispatch({ effects: unfoldEffect.of({ from: view.state.doc.line(1).to, to: view.state.doc.line(2).to }) });
		const during = plugin.store.get(NOTE_PATH);
		const keys = (during?.folds as unknown as { text: string }[]).map((f) => f.text);
		expect(keys).toContain("beta"); // recorded
		expect(keys).not.toContain("alpha"); // his unfold recorded

		land(view, THREE);
		await until(() => liveFoldedLineRanges(view).length === 2);
		await pause(400); // past the settle pass the watcher also runs on the landed text

		const folded = liveFoldedLineRanges(view);
		expect(folded).toEqual([
			{ startLine: 3, endLine: 4 }, // Beta, the one he folded: still folded
			{ startLine: 5, endLine: 6 }, // Gamma, the stored fold the pass restored
		]); // Alpha, the one he opened: not refolded
		const after = plugin.store.get(NOTE_PATH);
		const texts = (after?.folds as unknown as { text: string }[]).map((f) => f.text).sort();
		expect(texts).toEqual(["beta", "gamma"]);
		expect(after?.dormant).toHaveLength(0);
		expect(after?.contentHash).toBe(hashText(THREE));
	});

	it("E12: adapter.read rejects: nothing in the store changes, no pass runs, one `read-failed` line", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, vault, plugin, setSpy } = await boot({ [NOTE_PATH]: record });
		const entry = plugin.store.get(NOTE_PATH);
		vault.setContent(NOTE_PATH, TEXT_V1);
		vault.failReadsOf(NOTE_PATH);
		const { view, foldTransactions } = observedView("");

		openFile(app, NOTE_PATH, view);
		await pause(60);
		land(view, TEXT_V1);
		await pause(60);

		expect(setSpy).not.toHaveBeenCalled();
		expect(plugin.store.get(NOTE_PATH)).toBe(entry);
		expect(foldTransactions()).toBe(0);
		const lines = await logOf(plugin, vault);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ path: NOTE_PATH, pass: "open", outcome: "read-failed", editorLen: 0, diskLen: -1 });
	});

	it("E12: the file goes missing mid-wait (a modify event whose re-read fails): one `read-failed` line, no pass", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, vault, plugin, setSpy } = await boot({ [NOTE_PATH]: record });
		const entry = plugin.store.get(NOTE_PATH);
		const { view, foldTransactions } = observedView("");
		openFile(app, NOTE_PATH, view, TEXT_V1);
		await pause(30);

		vault.removeContent(NOTE_PATH);
		vault.trigger("modify", new MockTFile(NOTE_PATH));
		await pause(30);
		land(view, TEXT_V1);
		await pause(60);

		expect(setSpy).not.toHaveBeenCalled();
		expect(plugin.store.get(NOTE_PATH)).toBe(entry);
		expect(foldTransactions()).toBe(0);
		expect(outcomes(await logOf(plugin, vault))).toEqual(["waiting", "read-failed"]);
	});

	it("E12: the file is deleted mid-wait: the wait ends as read-failed and no pass runs", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, vault, plugin } = await boot({ [NOTE_PATH]: record });
		const { view, foldTransactions } = observedView("");
		openFile(app, NOTE_PATH, view, TEXT_V1);
		await pause(30);

		vault.removeContent(NOTE_PATH);
		vault.trigger("delete", new MockTFile(NOTE_PATH));
		await pause(30);
		land(view, TEXT_V1);
		await pause(60);

		expect(foldTransactions()).toBe(0);
		expect(outcomes(await logOf(plugin, vault))).toEqual(["waiting", "read-failed"]);
	});

	it("E12: a note renamed away mid-wait ends the wait as read-failed too", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, vault, plugin } = await boot({ [NOTE_PATH]: record });
		const { view, foldTransactions } = observedView("");
		openFile(app, NOTE_PATH, view, TEXT_V1);
		await pause(30);

		vault.trigger("rename", new MockTFile("Projects/Quarry/Renamed.md"), NOTE_PATH);
		await pause(30);
		land(view, TEXT_V1);
		await pause(60);

		expect(foldTransactions()).toBe(0);
		expect(outcomes(await logOf(plugin, vault))).toEqual(["waiting", "read-failed"]);
	});

	describe("E13: data already holding the empty-text hash with the folds set aside", () => {
		const fresh = (): FileFoldRecord["dormant"] =>
			lessonAnchors(BIG_LF).reduce<FileFoldRecord["dormant"]>(
				(list, anchor) => addDormant(list, anchor as never, Date.now() - 5 * 60_000),
				[],
			);

		it("gets one real-text pass once loaded: the set-aside folds come back as folds and the hash becomes the real one", async () => {
			const record = { contentHash: hashText(""), folds: [], dormant: fresh() };
			expect(record.dormant).toHaveLength(140);
			const { app, plugin, setSpy } = await boot({ [BIG_PATH]: record });
			const { view } = observedView("");
			openFile(app, BIG_PATH, view, BIG_LF);
			await pause(50);
			expect(setSpy).not.toHaveBeenCalled(); // still waiting: untouched

			land(view, BIG_LF);
			await until(() => plugin.store.get(BIG_PATH)?.contentHash === hashText(BIG_LF));
			await until(() => liveFoldedLineRanges(view).length === 140);
			const after = plugin.store.get(BIG_PATH);
			expect(after?.folds).toHaveLength(140);
			expect(after?.dormant).toHaveLength(0);
			expect(setSpy).toHaveBeenCalledTimes(1);
		});

		it("boundary: with `dormantSince` older than MAX_DORMANT_AGE_MS it behaves exactly as restoreOnOpen does today", async () => {
			const aged = lessonAnchors(BIG_LF).reduce<FileFoldRecord["dormant"]>(
				(list, anchor) => addDormant(list, anchor as never, Date.now() - MAX_DORMANT_AGE_MS - 60_000),
				[],
			);
			const record = { contentHash: hashText(""), folds: [], dormant: aged };

			// What a real-text pass produces today, called directly with no wait.
			const direct = new FoldStore({
				loadData: () => Promise.resolve({ version: 1, files: { [BIG_PATH]: record } }),
				saveData: () => Promise.resolve(),
			});
			await direct.load();
			const directView = makeView(BIG_LF);
			await restoreOnOpen(directView, BIG_PATH, BIG_LF, { store: direct });
			const expected = direct.get(BIG_PATH);
			expect(expected?.folds).toHaveLength(0); // the window is not extended
			expect(expected?.contentHash).toBe(hashText(BIG_LF));

			const { app, plugin } = await boot({ [BIG_PATH]: record });
			const { view } = observedView("");
			openFile(app, BIG_PATH, view, BIG_LF);
			await pause(30);
			land(view, BIG_LF);
			await until(() => plugin.store.get(BIG_PATH)?.contentHash === hashText(BIG_LF));
			expect(plugin.store.get(BIG_PATH)).toEqual(expected);
			expect(liveFoldedLineRanges(view)).toEqual(liveFoldedLineRanges(directView));
		});
	});

	describe("E17: two panes on one note", () => {
		it("a pane still loading does not touch the folds of the pane that has loaded; the store is written once, by the pane that loads first", async () => {
			// Stored hash is stale, so the pass that runs is a re-match and writes once.
			const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
			const { app, plugin, setSpy } = await boot({ [NOTE_PATH]: record });
			const paneA = observedView(TEXT_V2);
			const paneB = observedView("");

			openFile(app, NOTE_PATH, paneA.view, TEXT_V2);
			openFile(app, NOTE_PATH, paneB.view, TEXT_V2);
			await until(() => plugin.store.get(NOTE_PATH)?.contentHash === hashText(TEXT_V2));
			const aFolds = liveFoldedLineRanges(paneA.view);
			expect(aFolds).toEqual([{ startLine: 2, endLine: 3 }]);
			expect(setSpy).toHaveBeenCalledTimes(1);

			await pause(80);
			expect(paneB.foldTransactions()).toBe(0); // B's wait is still waiting
			expect(liveFoldedLineRanges(paneB.view)).toEqual([]);
			expect(liveFoldedLineRanges(paneA.view)).toEqual(aFolds);
			expect(setSpy).toHaveBeenCalledTimes(1);

			land(paneB.view, TEXT_V2);
			await until(() => liveFoldedLineRanges(paneB.view).length === 1);
			expect(liveFoldedLineRanges(paneB.view)).toEqual(aFolds);
			expect(liveFoldedLineRanges(paneA.view)).toEqual(aFolds);
			expect(setSpy).toHaveBeenCalledTimes(1); // B found the hash current: verbatim, no write
		});

		it("a new file-open for one pane cancels only that pane's wait; the other pane's wait keeps running", async () => {
			const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
			const { app, plugin, setSpy } = await boot({ [NOTE_PATH]: record });
			const paneA = observedView("");
			const paneB = observedView("");
			openFile(app, NOTE_PATH, paneA.view, TEXT_V1);
			openFile(app, NOTE_PATH, paneB.view, TEXT_V1);
			await pause(30);
			const waits = (plugin as unknown as { loadWaits: { size: number } }).loadWaits;
			expect(waits.size).toBe(2);

			// Pane B moves on to a note with nothing stored.
			openFile(app, "Projects/Quarry/NoEntry.md", paneB.view, "plain\n");
			expect(waits.size).toBe(1);
			land(paneB.view, TEXT_V1); // B's old text arriving now must not start anything
			await pause(60);
			expect(paneB.foldTransactions()).toBe(0);

			land(paneA.view, TEXT_V1);
			await until(() => liveFoldedLineRanges(paneA.view).length === 1);
			expect(setSpy).not.toHaveBeenCalled();
			expect(waits.size).toBe(0);
		});

		it("a pane that closes mid-wait cancels its wait and never runs a pass", async () => {
			const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
			const { app, vault, plugin, setSpy } = await boot({ [NOTE_PATH]: record });
			const { view } = observedView("");
			vi.useFakeTimers();
			openFile(app, NOTE_PATH, view, TEXT_V1);
			await vi.advanceTimersByTimeAsync(100);
			const waits = (plugin as unknown as { loadWaits: { size: number } }).loadWaits;
			expect(waits.size).toBe(1);

			view.destroy(); // the pane is closed
			await vi.advanceTimersByTimeAsync(1_000);
			expect(waits.size).toBe(0);
			await vi.advanceTimersByTimeAsync(LOAD_WAIT_GIVE_UP_MS);
			expect(setSpy).not.toHaveBeenCalled();
			expect(outcomes(await logOf(plugin, vault))).toEqual(["waiting"]); // no gave-up line for a closed pane
		});
	});

	it("added: a note that really is empty on disk, with an empty editor, is loaded at once and proceeds as today", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, vault, plugin } = await boot({ [NOTE_PATH]: record });
		const { view } = observedView("");
		openFile(app, NOTE_PATH, view, "");
		await until(() => plugin.store.get(NOTE_PATH)?.contentHash === hashText(""));

		const after = plugin.store.get(NOTE_PATH);
		expect(after?.folds).toHaveLength(0);
		expect(after?.dormant).toHaveLength(1); // the real change: the fold has nowhere to go
		const lines = await logOf(plugin, vault);
		expect(outcomes(lines)).toEqual(["rematched"]); // no waiting line: loaded at once
		expect(lines[0]).toMatchObject({ editorLen: 0, diskLen: 0 });
	});

	it("added: rapid file-open for one pane (A -> B -> A within 100 ms) leaves one live wait and runs only the last file's pass", async () => {
		const A = "Projects/Quarry/A.md";
		const B = "Projects/Quarry/B.md";
		const TEXT_B = "## Beta\nBeta body.\n";
		const { app, vault, plugin, setSpy } = await boot({
			[A]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] },
			[B]: { contentHash: hashText(TEXT_B), folds: [headingAnchor(TEXT_B, "beta")], dormant: [] },
		});
		const waits = (plugin as unknown as { loadWaits: { size: number } }).loadWaits;
		const { view } = observedView("");
		openFile(app, A, view, TEXT_V1);
		openFile(app, B, view, TEXT_B);
		openFile(app, A, view, TEXT_V1);
		expect(waits.size).toBe(1);
		await pause(40);
		expect(waits.size).toBe(1);

		land(view, TEXT_V1);
		await until(() => liveFoldedLineRanges(view).length === 1);
		await pause(40);
		expect(waits.size).toBe(0);
		expect(setSpy).not.toHaveBeenCalled();
		const lines = await logOf(plugin, vault);
		expect(lines.filter((l) => l.outcome === "applied")).toHaveLength(1);
		expect(lines.filter((l) => l.path === B)).toEqual([]); // B's pass never ran
	});

	it("added: unloading the plugin mid-wait leaves no timer, listener or log write behind", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, vault, plugin, setSpy } = await boot({ [NOTE_PATH]: record });
		const { view, foldTransactions } = observedView("");
		vi.useFakeTimers();
		openFile(app, NOTE_PATH, view, TEXT_V1);
		await vi.advanceTimersByTimeAsync(100);
		const waits = (plugin as unknown as { loadWaits: { size: number } }).loadWaits;
		expect(waits.size).toBe(1);
		const linesBefore = (await logOf(plugin, vault)).length;
		const adapterCalls = vault.adapter.calls.length;

		plugin.unload();
		await vi.advanceTimersByTimeAsync(0);
		expect(waits.size).toBe(0);
		const timersAfterUnload = vi.getTimerCount();

		vault.trigger("modify", new MockTFile(NOTE_PATH)); // no listener left to re-read the disk
		land(view, TEXT_V1); // no listener left to notice the text
		await vi.advanceTimersByTimeAsync(LOAD_WAIT_GIVE_UP_MS + 5_000);

		expect(vi.getTimerCount()).toBe(timersAfterUnload);
		expect(vault.adapter.calls.length).toBe(adapterCalls); // not one more read or log write
		expect(foldTransactions()).toBe(0);
		expect(setSpy).not.toHaveBeenCalled();
		expect((await logOf(plugin, vault)).length).toBe(linesBefore);
	});

	it("F3: the wait path writes only through store.set and the log in the plugin folder; never a note", async () => {
		const record = { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] };
		const { app, vault, plugin } = await boot({ [NOTE_PATH]: record, [BIG_PATH]: { contentHash: hashText(""), folds: [], dormant: [] } });
		const modify = vi.fn();
		const process = vi.fn();
		Object.assign(vault, { modify, process });

		for (const [path, text] of [
			[NOTE_PATH, TEXT_V1],
			[BIG_PATH, BIG_LF],
		] as const) {
			const { view } = observedView("");
			openFile(app, path, view, text);
			await pause(30);
			land(view, text);
			await pause(100);
		}
		await plugin.diagnosticLog?.drain();

		expect(modify).not.toHaveBeenCalled();
		expect(process).not.toHaveBeenCalled();
		const writes = vault.adapter.calls.filter((c) => c.method === "write" || c.method === "append");
		expect(writes.length).toBeGreaterThan(0);
		for (const write of writes) expect(write.path).toBe(LOG_PATH);
		const reads = vault.adapter.calls.filter((c) => c.method === "read" && c.path !== LOG_PATH);
		expect(reads.length).toBeGreaterThan(0);
	});

	it("the log holds paths, counts and codes only: no note text in any field of a waiting, gave-up or read-failed line", async () => {
		const secretText = `## Tuesday\n${MARKER} body.\n## Wednesday\nSecond.`;
		const record = { contentHash: hashText(secretText), folds: [tuesdayAnchorFor(secretText)], dormant: [] };
		const { app, vault, plugin } = await boot({ [NOTE_PATH]: record });
		const { view } = observedView("");
		vi.useFakeTimers();
		openFile(app, NOTE_PATH, view, secretText);
		await vi.advanceTimersByTimeAsync(LOAD_WAIT_GIVE_UP_MS);
		const lines = await logOf(plugin, vault);
		expect(outcomes(lines)).toEqual(["waiting", "gave-up"]);
		const raw = vault.adapter.files.get(LOG_PATH) as string;
		for (const secret of [MARKER, "Tuesday", "tuesday", "Wednesday", "Second."]) expect(raw).not.toContain(secret);
		for (const line of lines) {
			expect(Object.keys(line)).toEqual([
				"t", "path", "pass", "editorLen", "diskLen", "foldsBefore", "dormantBefore", "foldsAfter", "dormantAfter", "outcome",
			]);
		}
	});
});

describe("native-restore guard behind the load wait (warkworth-46 PR-3)", () => {
	const LOG_PATH = ".obsidian/plugins/persistent-folded-state/diagnostic-log.jsonl";
	const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

	async function boot(delays: number[]) {
		const app = new App();
		const vault = app.vault as unknown as MockVault;
		vault.setExists(NOTE_PATH);
		const stored = {
			value: { version: 1, files: { [NOTE_PATH]: { contentHash: hashText(TEXT_V1), folds: [tuesdayAnchorFor(TEXT_V1)], dormant: [] } } },
		};
		const plugin = makePlugin(app, stored);
		plugin.guardDelaysMs = delays;
		await plugin.onload();
		return { app, vault, plugin };
	}

	async function logOf(plugin: PersistentFoldedStatePlugin, vault: MockVault): Promise<Record<string, unknown>[]> {
		await plugin.diagnosticLog?.drain();
		return (vault.adapter.files.get(LOG_PATH) ?? "")
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	}

	it("the guard's checks start after the wait: a stale native fold that lands once the text has loaded is still corrected", async () => {
		const { app, plugin } = await boot([10, 200]);
		const view = makeView("");
		openFile(app, NOTE_PATH, view, TEXT_V3); // the disk has the real (reordered) text, the pane is still empty
		await pause(60); // longer than the first guard delay: if it were timed from file-open it would be spent by now
		expect(liveFoldedLineRanges(view)).toEqual([]);

		view.dispatch({ changes: { from: 0, to: 0, insert: TEXT_V3 } });
		for (let i = 0; i < 100 && liveFoldedLineRanges(view).length === 0; i++) await pause(10);
		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 3, endLine: 4 }]);

		// Obsidian's own restore arrives late with the stale offsets: the guard still has its 200 ms check.
		view.dispatch({
			effects: [
				unfoldEffect.of({ from: view.state.doc.line(3).to, to: view.state.doc.line(4).to }),
				foldEffect.of({ from: view.state.doc.line(1).to, to: view.state.doc.line(2).to }),
			],
		});
		for (let i = 0; i < 100 && JSON.stringify(liveFoldedLineRanges(view)) !== JSON.stringify([{ startLine: 3, endLine: 4 }]); i++) await pause(10);
		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 3, endLine: 4 }]);
		expect(view.state.doc.toString()).toBe(TEXT_V3);
	}, 10000);

	it("a check that finds the pane showing other text does nothing to it, writes nothing, and logs one `native-guard` waiting line", async () => {
		const { app, vault, plugin } = await boot([60, 90, 120]);
		const view = makeView(TEXT_V3);
		openFile(app, NOTE_PATH, view);
		await pause(20);
		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 3, endLine: 4 }]);
		const setSpy = vi.spyOn(plugin.store, "set"); // the open pass's own re-match write is behind us

		// The pane is reused for another note before the guard's later checks run.
		const other = "# Another note\nbody\n## Heading\nmore body\n";
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: other } });
		const folded = JSON.stringify(liveFoldedLineRanges(view));
		view.dispatch({ effects: foldEffect.of({ from: view.state.doc.line(1).to, to: view.state.doc.line(2).to }) }); // a native fold on the new note
		await pause(200);

		expect(setSpy).not.toHaveBeenCalled();
		expect(liveFoldedLineRanges(view)).toEqual([{ startLine: 1, endLine: 2 }]); // the guard left the other note's fold alone
		expect(JSON.stringify(liveFoldedLineRanges(view))).not.toBe(folded);
		const lines = (await logOf(plugin, vault)).filter((l) => l.pass === "native-guard");
		expect(lines).toHaveLength(1); // once per open, however many checks skip
		expect(lines[0]).toMatchObject({ path: NOTE_PATH, outcome: "waiting", editorLen: other.length });
		expect(JSON.stringify(lines)).not.toContain("Another note");
	}, 10000);

	it("a pane that still shows the note's text through the whole window logs no native-guard line", async () => {
		const { app, vault, plugin } = await boot([10, 40]);
		const view = makeView(TEXT_V3);
		openFile(app, NOTE_PATH, view);
		await pause(100);
		expect((await logOf(plugin, vault)).filter((l) => l.pass === "native-guard")).toEqual([]);
	});
});
