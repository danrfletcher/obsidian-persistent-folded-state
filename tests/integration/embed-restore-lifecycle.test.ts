/**
 * The embed restore through the real plugin (ticket warkworth-21, PR-5: G2, F2, F7, E14): build
 * the plugin twice against one persisted data.json (a relaunch), close and reopen a host, two
 * panes, independence of an embed's state from the source note's in both directions, and no
 * writes to any note.
 *
 * jsdom marks every dispatched event untrusted and the plugin has no trust seam, so the stored
 * state is put in the plugin's own store as the recorder would (`setEmbed`), as
 * tests/integration/embed-recording-flush.test.ts does; the restore under test is the plugin's own
 * (src/main.ts wires it), over the same mock app the World renders its hosts in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifest } from "obsidian";
import { App } from "../mocks/obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import type { EmbedFoldRecord, FileFoldRecord } from "../../src/types";
import { EMBED_RENDER_SETTLE_MS } from "../../src/embed-render-coalescer";
import { EMBED_VERIFY_DELAY_MS } from "../../src/embed-fold-restorer";
import { LESSONS_NOTE, LESSONS_TEXT, SOURCE, SOURCE_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";
import type { Mode } from "../fixtures/embed-recording-world";
import { foldedRows, isFolded } from "../fixtures/embed-restore-world";

const manifest: PluginManifest = {
	id: "persistent-folded-state",
	name: "Persistent Folded State",
	version: "0.1.1",
	minAppVersion: "1.13.0",
	description: "test",
	author: "Dan Fletcher",
	isDesktopOnly: false,
};

const ROCKETSHIP = "Salesforce Tech Test Rocketship Course.md";
const BLOCK_EMBED = "![[Competitive Coding Fundamentals#^0169a6]]\n";

const LESSON_8_BLOCK = {
	kind: "task",
	indent: 0,
	text: "lesson 8: collections and frequency counting ^0169a6",
	siblingIndex: 0,
	parentChain: [],
};
const ROCKETSHIP_RECORD: EmbedFoldRecord = {
	host: ROCKETSHIP,
	target: SOURCE,
	subpath: "^0169a6",
	occurrence: 0,
	contentHash: "h-rocketship",
	folds: [LESSON_8_BLOCK],
	dormant: [],
};
const ROCKETSHIP_KEY = { host: ROCKETSHIP, target: SOURCE, subpath: "^0169a6", occurrence: 0 };

const NOTE_LEVEL_FOLD: FileFoldRecord = {
	contentHash: "h-source",
	folds: [{ kind: "task", indent: 0, text: "lesson 7: sorting ^aaa111", siblingIndex: 0, parentChain: [] }],
	dormant: [],
};

interface Launch {
	app: App;
	plugin: PersistentFoldedStatePlugin;
	w: World;
}

const launched: Launch[] = [];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const l of launched.splice(0)) l.plugin.unload();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Starts Obsidian: a fresh app holding the vault's notes, the plugin loaded over `persisted`. */
async function launch(persisted: unknown): Promise<Launch> {
	const app = new App();
	const w = new World({}, { app, attach: false });
	w.addNote(SOURCE, SOURCE_TEXT);
	w.addNote(LESSONS_NOTE, LESSONS_TEXT);
	const plugin = new PersistentFoldedStatePlugin(app as unknown as ConstructorParameters<typeof PersistentFoldedStatePlugin>[0], manifest);
	if (persisted !== null) await plugin.saveData(structuredClone(persisted));
	await plugin.onload();
	app.workspace.triggerLayoutReady();
	const made = { app, plugin, w };
	launched.push(made);
	return made;
}

/** Quits Obsidian: the plugin unloads (flushing), and data.json is what the next launch loads. */
async function quit(l: Launch): Promise<unknown> {
	l.plugin.unload();
	await vi.advanceTimersByTimeAsync(0);
	launched.splice(launched.indexOf(l), 1);
	document.body.replaceChildren();
	return await l.plugin.loadData();
}

async function renderPasses(): Promise<void> {
	for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(EMBED_RENDER_SETTLE_MS);
	for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
	await vi.advanceTimersByTimeAsync(EMBED_VERIFY_DELAY_MS);
	for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
}

/** Every note the vault holds, with its text, as one string to compare. */
async function hashFiles(l: Launch): Promise<string> {
	const entries: [string, string][] = [];
	for (const path of l.app.vault.allPaths()) {
		const file = l.app.vault.getFileByPath(path);
		entries.push([path, file === null ? "" : await l.app.vault.cachedRead(file)]);
	}
	return JSON.stringify(entries);
}

const MODES: Mode[] = ["live-preview", "reading-view"];

describe.each(MODES)("%s host: G2, close and reopen, and relaunch from the persisted data.json", (mode) => {
	it("close/reopen: the embed's fold is restored by the plugin when the host renders again", async () => {
		const l = await launch(null);
		l.plugin.store.setEmbed(structuredClone(ROCKETSHIP_RECORD));

		const first = l.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		await renderPasses();
		expect(foldedRows(first.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		first.view.containerEl.remove();

		const reopened = l.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		expect(foldedRows(reopened.embeds[0])).toEqual([]);
		await renderPasses();
		expect(foldedRows(reopened.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		expect(isFolded(arrowFor(reopened.embeds[0], "Count word frequency"))).toBe(false);
	});

	it("relaunch from persisted data.json: a second plugin, over the saved data, restores the same fold", async () => {
		const one = await launch(null);
		one.plugin.store.setEmbed(structuredClone(ROCKETSHIP_RECORD));
		const dataJson = await quit(one);
		expect((dataJson as { embeds: EmbedFoldRecord[] }).embeds).toEqual([ROCKETSHIP_RECORD]);

		const two = await launch(dataJson);
		const host = two.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		expect(foldedRows(host.embeds[0])).toEqual([]);
		await renderPasses();

		expect(foldedRows(host.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		expect(two.plugin.store.embedRecords()).toEqual([ROCKETSHIP_RECORD]);
	});

	it("an embed with no stored state in a relaunched plugin starts expanded and writes nothing", async () => {
		const one = await launch(null);
		const dataJson = await quit(one);
		const two = await launch(dataJson);
		const saveData = vi.spyOn(two.plugin, "saveData");

		const host = two.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		for (const arrow of Array.from(host.embeds[0].querySelectorAll(".list-collapse-indicator"))) {
			arrow.classList.add("is-collapsed");
			arrow.parentElement?.classList.add("is-collapsed");
		}
		await renderPasses();
		await vi.advanceTimersByTimeAsync(1000);

		expect(foldedRows(host.embeds[0])).toEqual([]);
		expect(two.plugin.store.embedSize).toBe(0);
		expect(saveData).not.toHaveBeenCalled();
	});
});

describe.each(MODES)("%s host: E14, the same host open in two panes", (mode) => {
	it("both panes restore from the one stored state, and nothing is written", async () => {
		const l = await launch({ version: 1, files: {}, embeds: [structuredClone(ROCKETSHIP_RECORD)] });
		const saveData = vi.spyOn(l.plugin, "saveData");

		const paneA = l.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		const paneB = l.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		await renderPasses();
		await vi.advanceTimersByTimeAsync(2000);

		expect(foldedRows(paneA.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		expect(foldedRows(paneB.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		expect(l.plugin.store.embedRecords()).toEqual([ROCKETSHIP_RECORD]);
		expect(saveData).not.toHaveBeenCalled();
	});
});

describe.each(MODES)("%s host: F2, an embed's state and the source note's are independent in both directions", (mode) => {
	it("a note-level fold on the source leaves the embed's stored set, and what the embed shows, untouched", async () => {
		const l = await launch({ version: 1, files: {}, embeds: [structuredClone(ROCKETSHIP_RECORD)] });
		const host = l.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		await renderPasses();
		const shown = foldedRows(host.embeds[0]);
		expect(shown).toEqual(["Lesson 8: Collections and frequency counting"]);

		// Dan folds something in the source note in its own editor: the note-level record changes.
		l.plugin.store.set(SOURCE, structuredClone(NOTE_LEVEL_FOLD));
		l.w.rerender(host.embeds[0], ROCKETSHIP);
		await renderPasses();

		expect(l.plugin.store.getEmbed(ROCKETSHIP_KEY)).toEqual(ROCKETSHIP_RECORD);
		expect(foldedRows(host.embeds[0])).toEqual(shown);
	});

	it("restoring an embed never reads or writes the note-level record of its source or its host", async () => {
		const l = await launch({
			version: 1,
			files: { [SOURCE]: structuredClone(NOTE_LEVEL_FOLD), [ROCKETSHIP]: structuredClone(NOTE_LEVEL_FOLD) },
			embeds: [structuredClone(ROCKETSHIP_RECORD)],
		});
		const store = l.plugin.store;
		const before = JSON.stringify([store.get(SOURCE), store.get(ROCKETSHIP)]);
		const reads = [vi.spyOn(store, "get"), vi.spyOn(store, "embedRecords")];
		const writes = [
			vi.spyOn(store, "set"),
			vi.spyOn(store, "setEmbed"),
			vi.spyOn(store, "forgetEmbed"),
			vi.spyOn(store, "forgetNote"),
			vi.spyOn(store, "forget"),
		];

		const host = l.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		await renderPasses();

		expect(foldedRows(host.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		for (const spy of reads) expect(spy).not.toHaveBeenCalled();
		for (const spy of writes) expect(spy).not.toHaveBeenCalled();
		vi.restoreAllMocks();
		expect(JSON.stringify([store.get(SOURCE), store.get(ROCKETSHIP)])).toBe(before);
	});

	it("an embed's stored set is not touched when the note-level record for the same source is forgotten, and the reverse", async () => {
		const l = await launch({
			version: 1,
			files: { [SOURCE]: structuredClone(NOTE_LEVEL_FOLD) },
			embeds: [structuredClone(ROCKETSHIP_RECORD)],
		});
		l.plugin.store.forgetNote(SOURCE);
		expect(l.plugin.store.get(SOURCE)).toBeUndefined();
		expect(l.plugin.store.getEmbed(ROCKETSHIP_KEY)).toEqual(ROCKETSHIP_RECORD);

		l.plugin.store.set(SOURCE, structuredClone(NOTE_LEVEL_FOLD));
		l.plugin.store.forgetEmbed(ROCKETSHIP_KEY);
		expect(l.plugin.store.get(SOURCE)).toEqual(NOTE_LEVEL_FOLD);
		expect(l.plugin.store.getEmbed(ROCKETSHIP_KEY)).toBeUndefined();
		expect(mode).toMatch(/view|preview/);
	});
});

describe.each(MODES)("%s host: F7, nothing is written to the host or the source note", (mode) => {
	it("the vault's files hash the same before and after a restore, and so does the host's own text", async () => {
		const l = await launch({ version: 1, files: {}, embeds: [structuredClone(ROCKETSHIP_RECORD)] });
		expect(await hashFiles(l)).toContain("Competitive Coding Fundamentals");

		const host = l.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		const hostTextBefore = host.view.getViewData();
		const filesBefore = await hashFiles(l);
		await renderPasses();
		await vi.advanceTimersByTimeAsync(2000);

		expect(foldedRows(host.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		expect(await hashFiles(l)).toBe(filesBefore);
		expect(host.view.getViewData()).toBe(hostTextBefore);
		expect(l.app.vault.getFileByPath(SOURCE)).not.toBeNull();
		expect(await l.app.vault.cachedRead(l.app.vault.getFileByPath(SOURCE)!)).toBe(SOURCE_TEXT);
	});
});

describe("unload", () => {
	it("after unload no embed is restored, and nothing pending runs", async () => {
		const l = await launch({ version: 1, files: {}, embeds: [structuredClone(ROCKETSHIP_RECORD)] });
		const host = l.w.addHost(ROCKETSHIP, "live-preview", BLOCK_EMBED);
		await vi.advanceTimersByTimeAsync(50);

		l.plugin.unload();
		await renderPasses();
		expect(foldedRows(host.embeds[0])).toEqual([]);

		const later = l.w.addHost(ROCKETSHIP, "reading-view", BLOCK_EMBED);
		await renderPasses();
		expect(foldedRows(later.embeds[0])).toEqual([]);
	});
});
