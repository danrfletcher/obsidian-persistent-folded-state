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
import { codeFolding, foldEffect, foldedRanges } from "@codemirror/language";
import { App, type PluginManifest } from "obsidian";
import {
	Editor as MockEditor,
	MarkdownView as MockMarkdownView,
	TFile as MockTFile,
	Vault as MockVault,
	Workspace as MockWorkspace,
} from "../mocks/obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
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
	});

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
