/**
 * Warkworth-46 PR-3 (T1): a re-match leaves the stored folds under their blocks' current anchors.
 *
 * The bug this pins: an external rewrite that drops a line above folded siblings shifts every
 * later sibling's `siblingIndex`. The re-match still folds them (through a fuzzy tier), and the
 * pass stores the new `contentHash`; but if the old anchors stayed in `folds`, the NEXT open (hash
 * now unchanged, so stored anchors are looked up by exact key with no matcher) found none of them,
 * folded nothing, and data.json still said every fold was there. Both tests run the real passes
 * (the plugin's `file-open` handler and the real editor watcher behind the load guard) over the
 * 140-lesson fixture; nothing is stubbed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges } from "@codemirror/language";
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
import { FoldStore, hashText } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import { anchorKey, buildAnchors, parseAnchor } from "../../src/anchors";
import { makeGuardRig } from "../guard-rig";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const ORIGINAL = readFileSync(join(FIXTURES, "competitive-coding-140.md"), "utf8");
const NOTE_PATH = "Competitive Coding Fundamentals/Competitive Coding Fundamentals.md";

const manifest: PluginManifest = {
	id: "persistent-folded-state",
	name: "Persistent Folded State",
	version: "0.1.0",
	minAppVersion: "1.13.0",
	description: "test",
	author: "Dan Fletcher",
	isDesktopOnly: false,
};

/** The agent's rewrite: the whole "Lesson 1" block (parent task and its two children) is removed, so
 * every later lesson's sibling index drops by one. */
const REWRITTEN = ORIGINAL.split("\n")
	.filter((line, i, all) => {
		const lesson1 = all.findIndex((l) => l.startsWith("- [ ] Lesson 1:"));
		return i < lesson1 || i >= lesson1 + 3;
	})
	.join("\n");

/** Every foldable lesson task at the top indent of `text`, as stored anchors. */
function lessonFolds(text: string): Record<string, unknown>[] {
	return buildAnchors(text)
		.filter((b) => b.anchor.kind === "task" && b.anchor.indent === 0 && b.range.endLine > b.range.startLine)
		.map((b) => b.anchor as unknown as Record<string, unknown>);
}

function candidateKeys(text: string): Set<string> {
	return new Set(buildAnchors(text).map((b) => anchorKey(b.anchor)));
}

function storedKeys(folds: readonly unknown[]): string[] {
	return folds.map((raw) => {
		const anchor = parseAnchor(raw);
		if (!anchor) throw new Error("stored fold is not a well-formed anchor");
		return anchorKey(anchor);
	});
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

describe("a re-match stores each matched fold under its block's current anchor (T1)", () => {
	it("fixture sanity: the rewrite shifts sibling indices, so no stored lesson anchor resolves by exact key", () => {
		const keys = candidateKeys(REWRITTEN);
		const stored = lessonFolds(ORIGINAL);
		expect(stored.length).toBeGreaterThan(100);
		const resolving = storedKeys(stored).filter((k) => keys.has(k));
		expect(resolving).toHaveLength(0);
	});

	it("open pass: after the closed-note rewrite is re-matched, the next open (hash unchanged) folds the same blocks, and the store does not change", async () => {
		const app = new App();
		(app.vault as unknown as MockVault).setExists(NOTE_PATH);
		const seeded = lessonFolds(ORIGINAL);
		const stored: { value: unknown } = {
			value: { version: 1, files: { [NOTE_PATH]: { contentHash: hashText(ORIGINAL), folds: seeded, dormant: [] } } },
		};
		const plugin = new PersistentFoldedStatePlugin(app, manifest);
		plugin.loadData = async () => stored.value;
		plugin.saveData = async (data: unknown) => {
			stored.value = data;
		};
		await plugin.onload();

		const open = (view: EditorView): void => {
			const vault = app.vault as unknown as MockVault;
			vault.setContent(NOTE_PATH, REWRITTEN);
			const file = new MockTFile(NOTE_PATH);
			const markdownView = new MockMarkdownView();
			markdownView.file = file;
			markdownView.editor = new MockEditor(view);
			const workspace = app.workspace as unknown as MockWorkspace;
			workspace.addLeaf(markdownView);
			workspace.setActiveView(markdownView);
			workspace.trigger("file-open", file);
		};
		const paneOver = (text: string): EditorView =>
			new EditorView({ state: EditorState.create({ doc: text, extensions: [codeFolding()] }), parent: document.body });

		// First open: the hash differs, so the folds are re-matched. Lesson 1's fold has no block left.
		const first = paneOver(REWRITTEN);
		open(first);
		await settle();
		const afterFirst = plugin.store.get(NOTE_PATH)!;
		expect(afterFirst.contentHash).toBe(hashText(REWRITTEN));
		expect(afterFirst.dormant).toHaveLength(1);
		expect(afterFirst.folds).toHaveLength(seeded.length - 1);
		const firstFolds = liveFoldedLineRanges(first);
		expect(firstFolds).toHaveLength(seeded.length - 1);

		// Every stored fold now names its block exactly, which is what the next open relies on.
		const keys = candidateKeys(REWRITTEN);
		expect(storedKeys(afterFirst.folds).filter((k) => !keys.has(k))).toEqual([]);

		// Second open in a fresh pane over the same text: hash unchanged, stored anchors applied by exact key.
		const snapshot = JSON.stringify(afterFirst);
		const second = paneOver(REWRITTEN);
		open(second);
		await settle();
		expect(liveFoldedLineRanges(second)).toEqual(firstFolds);
		expect(JSON.stringify(plugin.store.get(NOTE_PATH))).toBe(snapshot);
	}, 30000);

	it("settled pass: an external rewrite re-matched while the note is open leaves exact-key anchors in the store", async () => {
		const rig = makeGuardRig();
		const clock = 5_000;
		let persisted: unknown = {
			version: 1,
			files: { [NOTE_PATH]: { contentHash: hashText(ORIGINAL), folds: lessonFolds(ORIGINAL), dormant: [] } },
		};
		const store = new FoldStore({ loadData: async () => persisted, saveData: async (d) => { persisted = d; }, now: () => clock });
		await store.load();
		rig.vault.setContent(NOTE_PATH, REWRITTEN);
		const watcher = createEditorWatcher({ store, now: () => clock, ...rig.watcherDeps });
		const view = new EditorView({
			state: EditorState.create({
				doc: ORIGINAL,
				selection: { anchor: 0 },
				extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
			}),
			parent: document.body,
		});

		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: REWRITTEN }, annotations: Transaction.userEvent.of("set") });
		await settle();

		const after = store.get(NOTE_PATH)!;
		expect(after.contentHash).toBe(hashText(REWRITTEN));
		expect(after.dormant).toHaveLength(1);
		expect(after.folds.length).toBeGreaterThan(100);
		const keys = candidateKeys(REWRITTEN);
		expect(storedKeys(after.folds).filter((k) => !keys.has(k))).toEqual([]);
		expect(liveFoldedLineRanges(view)).toHaveLength(after.folds.length);
	}, 30000);
});
