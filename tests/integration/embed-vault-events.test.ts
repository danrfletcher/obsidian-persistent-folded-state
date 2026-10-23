/**
 * PR-8 (G10, G11, G17, E8, E9, F2, F7): fake vault `rename`/`delete` events and metadata-cache
 * `changed` events driven through the real plugin wiring (`app.vault.trigger`,
 * `app.metadataCache.trigger`, as tests/integration/vault-events.test.ts does), with fake timers,
 * asserting the saved `data.json` content. The pure rules are covered by
 * tests/unit/embed-lifecycle.test.ts; this file proves the plugin calls them on the real events,
 * flushes at once, writes once per event, never touches the notes' own `files` entries, and never
 * writes to a note.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, type PluginManifest } from "obsidian";
import { TFile as MockTFile, Vault as MockVault, MetadataCache as MockMetadataCache } from "../mocks/obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import { PENDING_WINDOW_MS } from "../../src/embed-heading-rename";
import type { EmbedFoldRecord, FileFoldRecord } from "../../src/types";

const manifest: PluginManifest = {
	id: "persistent-folded-state",
	name: "Persistent Folded State",
	version: "0.1.1",
	minAppVersion: "1.13.0",
	description: "test",
	author: "Dan Fletcher",
	isDesktopOnly: false,
};

const HOST = "Courses/Rocketship.md";
const SOURCE = "Lessons/Fundamentals.md";
const FOLD = { kind: "task", indent: 0, text: "lesson 8", siblingIndex: 0, parentChain: [] };
const NOTE_FILE: FileFoldRecord = { contentHash: "note-level", folds: [FOLD], dormant: [] };

function embed(host: string, target: string, subpath: string, occurrence = 0, contentHash = "slice"): EmbedFoldRecord {
	return { host, target, subpath, occurrence, contentHash, folds: [FOLD], dormant: [] };
}

interface Stored {
	value: unknown;
}
interface Disk {
	version: number;
	files: Record<string, FileFoldRecord>;
	embeds?: EmbedFoldRecord[];
}

const WRITES = ["modify", "process", "create", "append", "createBinary", "modifyBinary", "delete", "rename", "trash"] as const;

interface Launch {
	app: App;
	plugin: PersistentFoldedStatePlugin;
	stored: Stored;
	saves: ReturnType<typeof vi.fn>;
	vaultWrites: ReturnType<typeof vi.fn>[];
}

/** Starts Obsidian over `disk`: every path in `exists` is in the vault, the plugin is loaded and
 * layout is ready. `saves` counts every `saveData`; `vaultWrites` spy on the vault's write APIs. */
async function launch(disk: unknown, exists: string[], app = new App()): Promise<Launch> {
	const vault = app.vault as unknown as MockVault & Record<string, unknown>;
	const vaultWrites = WRITES.map((name) => (vault[name] = vi.fn()) as ReturnType<typeof vi.fn>);
	for (const path of exists) vault.setExists(path);
	const stored: Stored = { value: disk };
	const saves = vi.fn();
	const plugin = new PersistentFoldedStatePlugin(app, manifest);
	plugin.loadData = async () => stored.value;
	plugin.saveData = async (data: unknown) => {
		saves(data);
		stored.value = structuredClone(data);
	};
	await plugin.onload();
	(app.workspace as unknown as { triggerLayoutReady(): void }).triggerLayoutReady();
	return { app, plugin, stored, saves, vaultWrites };
}

function vaultOf(app: App): MockVault {
	return app.vault as unknown as MockVault;
}
function cacheOf(app: App): MockMetadataCache {
	return app.metadataCache as unknown as MockMetadataCache;
}
/** Lets the store's flush chain (promise microtasks) finish, without moving the clock: a pending
 * 150 ms debounce timer stays pending. */
async function settle(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}
async function rename(l: Launch, newPath: string, oldPath: string): Promise<void> {
	vaultOf(l.app).trigger("rename", new MockTFile(newPath), oldPath);
	await settle();
}
async function remove(l: Launch, path: string): Promise<void> {
	vaultOf(l.app).trigger("delete", new MockTFile(path));
	await settle();
}
async function changed(app: App, path: string): Promise<void> {
	const cache = cacheOf(app);
	cache.trigger("changed", new MockTFile(path), "", cache.getFileCache(new MockTFile(path)));
	await settle();
}
const disk = (l: Launch): Disk => l.stored.value as Disk;
const keys = (l: Launch): string[] => (disk(l).embeds ?? []).map((r) => `${r.host} > ${r.target}${r.subpath === "" ? "" : `#${r.subpath}`} [${r.occurrence}]`);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("embed vault events: rename (G10)", () => {
	const seed = (): unknown => ({
		version: 1,
		files: { [SOURCE]: NOTE_FILE },
		embeds: [embed(HOST, SOURCE, "^0169a6"), embed(HOST, SOURCE, "Lesson 8"), embed(HOST, SOURCE, "", 1), embed("Other.md", SOURCE, "^0169a6")],
	});
	const present = [HOST, SOURCE, "Other.md"];

	it("a host rename re-keys that host's records on disk, immediately, in one write; the old host survives nowhere", async () => {
		const l = await launch(seed(), present);
		await rename(l, "Courses/Rocketship Q4.md", HOST);
		expect(l.saves).toHaveBeenCalledTimes(1); // flushed at once, no timer advance
		expect(keys(l)).toEqual([
			"Courses/Rocketship Q4.md > Lessons/Fundamentals.md#^0169a6 [0]",
			"Courses/Rocketship Q4.md > Lessons/Fundamentals.md#Lesson 8 [0]",
			"Courses/Rocketship Q4.md > Lessons/Fundamentals.md [1]",
			"Other.md > Lessons/Fundamentals.md#^0169a6 [0]",
		]);
		expect(JSON.stringify(l.stored.value)).not.toContain(`"host":"${HOST}"`);
		expect(disk(l).embeds?.[0]).toEqual({ ...embed("Courses/Rocketship Q4.md", SOURCE, "^0169a6") });
	});

	it("a target rename re-keys the records in every host that point at it", async () => {
		const l = await launch(seed(), present);
		await rename(l, "Lessons/Fundamentals v2.md", SOURCE);
		expect(l.saves).toHaveBeenCalledTimes(1);
		expect(new Set((disk(l).embeds ?? []).map((r) => r.target))).toEqual(new Set(["Lessons/Fundamentals v2.md"]));
		expect((disk(l).embeds ?? []).map((r) => [r.host, r.subpath, r.occurrence])).toEqual([
			[HOST, "^0169a6", 0],
			[HOST, "Lesson 8", 0],
			[HOST, "", 1],
			["Other.md", "^0169a6", 0],
		]);
	});

	it("a folder move re-keys host and target beneath it, by full path segment", async () => {
		const l = await launch(
			{ version: 1, files: {}, embeds: [embed("Projects/Quarry/H.md", "Projects/Quarry/S.md", ""), embed("Projects/Quarry2024/H.md", "Projects/Quarry2024/S.md", "")] },
			["Projects/Quarry/H.md", "Projects/Quarry/S.md", "Projects/Quarry2024/H.md", "Projects/Quarry2024/S.md"],
		);
		await rename(l, "Archive/Quarry", "Projects/Quarry");
		expect(keys(l)).toEqual(["Archive/Quarry/H.md > Archive/Quarry/S.md [0]", "Projects/Quarry2024/H.md > Projects/Quarry2024/S.md [0]"]);
	});

	it("a rename onto a key that has a record replaces it and the old key is gone", async () => {
		const l = await launch(
			{ version: 1, files: {}, embeds: [embed("A.md", "S.md", "", 0, "moving"), embed("B.md", "S.md", "", 0, "existing")] },
			["A.md", "B.md", "S.md"],
		);
		await rename(l, "B.md", "A.md");
		expect((disk(l).embeds ?? []).map((r) => [r.host, r.contentHash])).toEqual([["B.md", "moving"]]);
	});

	it("E15: occurrence indices are not renumbered by a host rename", async () => {
		const l = await launch(
			{ version: 1, files: {}, embeds: [embed("H.md", "S.md", "^a", 0, "first"), embed("H.md", "S.md", "^a", 1, "second")] },
			["H.md", "S.md"],
		);
		await rename(l, "H2.md", "H.md");
		expect((disk(l).embeds ?? []).map((r) => [r.host, r.occurrence, r.contentHash])).toEqual([["H2.md", 0, "first"], ["H2.md", 1, "second"]]);
	});

	it("a miss is a no-op that never reaches saveData and never throws", async () => {
		const l = await launch(seed(), present);
		await rename(l, "Elsewhere.md", "Unrelated.md");
		await vi.advanceTimersByTimeAsync(1000);
		expect(l.saves).not.toHaveBeenCalled();
		expect(l.stored.value).toEqual(seed());
	});

	it("a rename arriving while a debounced flush is pending flushes at once; no later write lands under the old key", async () => {
		const l = await launch({ version: 1, files: {} }, [HOST, SOURCE]);
		l.plugin.store.setEmbed(embed(HOST, SOURCE, "^0169a6")); // schedules the ordinary debounced flush
		expect(l.saves).not.toHaveBeenCalled();

		await rename(l, "Courses/Renamed.md", HOST);
		expect(l.saves).toHaveBeenCalledTimes(1);
		expect(keys(l)).toEqual(["Courses/Renamed.md > Lessons/Fundamentals.md#^0169a6 [0]"]);

		await vi.advanceTimersByTimeAsync(1000); // the original timer's moment passes
		expect(keys(l)).toEqual(["Courses/Renamed.md > Lessons/Fundamentals.md#^0169a6 [0]"]);
		expect(JSON.stringify(l.stored.value)).not.toContain(`"host":"${HOST}"`);
	});

	it("F2: the notes' own `files` entry is not read, written or changed by the embed rename, and a note-level rename leaves `embeds` as the embed path left it", async () => {
		const l = await launch(seed(), present);
		const noteBefore = structuredClone(disk(l).files);
		await rename(l, "Lessons/Fundamentals v2.md", SOURCE);
		// handleRename re-keyed the note entry; the embed path re-keyed the records; neither section
		// holds the other's work.
		expect(Object.keys(disk(l).files)).toEqual(["Lessons/Fundamentals v2.md"]);
		expect(disk(l).files["Lessons/Fundamentals v2.md"]).toEqual(noteBefore[SOURCE]);
		expect((disk(l).embeds ?? []).every((r) => r.target === "Lessons/Fundamentals v2.md")).toBe(true);
		expect(l.vaultWrites.map((spy) => spy.mock.calls.length)).toEqual(WRITES.map(() => 0));
	});
});

describe("embed vault events: delete (G11)", () => {
	const seed = (): unknown => ({
		version: 1,
		files: { [SOURCE]: NOTE_FILE, [HOST]: NOTE_FILE },
		embeds: [embed(HOST, SOURCE, "^0169a6"), embed("Other.md", SOURCE, "Lesson 8"), embed("Other.md", "Whole.md", ""), embed("Folder/H.md", "Folder/S.md", "")],
	});
	const present = [HOST, SOURCE, "Other.md", "Whole.md", "Folder/H.md", "Folder/S.md"];

	it("deleting a host removes every record for it, in one write", async () => {
		const l = await launch(seed(), present);
		await remove(l, "Other.md");
		expect(keys(l)).toEqual([`${HOST} > ${SOURCE}#^0169a6 [0]`, "Folder/H.md > Folder/S.md [0]"]);
		expect(l.saves).toHaveBeenCalledTimes(1);
	});

	it("deleting a target removes the records in every host that point at it; it is removal, not dormancy", async () => {
		const l = await launch(seed(), present);
		await remove(l, SOURCE);
		expect(keys(l)).toEqual(["Other.md > Whole.md [0]", "Folder/H.md > Folder/S.md [0]"]);
		expect((disk(l).embeds ?? []).every((r) => !("dormantSince" in r) && r.dormant.length === 0)).toBe(true);
	});

	it("deleting a folder removes the records whose host or target lie beneath it", async () => {
		const l = await launch(seed(), present);
		await remove(l, "Folder");
		expect(keys(l)).toEqual([`${HOST} > ${SOURCE}#^0169a6 [0]`, `Other.md > ${SOURCE}#Lesson 8 [0]`, "Other.md > Whole.md [0]"]);
	});

	it("deleting the last record leaves a file with no `embeds` key", async () => {
		const l = await launch({ version: 1, files: {}, embeds: [embed("H.md", "S.md", "")] }, ["H.md", "S.md"]);
		await remove(l, "S.md");
		expect(l.stored.value).toEqual({ version: 1, files: {} });
	});

	it("a miss is a no-op that never reaches saveData", async () => {
		const l = await launch(seed(), present);
		await remove(l, "Nowhere.md");
		await vi.advanceTimersByTimeAsync(1000);
		expect(l.saves).not.toHaveBeenCalled();
	});

	it("F2: the other section survives: the host's note-level entry is the existing handler's, not the embed path's", async () => {
		const l = await launch(seed(), present);
		await remove(l, SOURCE);
		expect(Object.keys(disk(l).files)).toEqual([HOST]); // handleDelete removed the source's note entry only
		expect(disk(l).files[HOST]).toEqual(NOTE_FILE);
	});
});

describe("embed vault events: outside Obsidian, pruned at layout ready (G10)", () => {
	it("a record whose host or target no longer exists is dropped at load; a record whose host and target exist is kept", async () => {
		const kept = embed("Kept.md", "S.md", "^a");
		const l = await launch(
			{ version: 1, files: {}, embeds: [embed("Gone Host.md", "S.md", "^a"), kept, embed("Kept.md", "Gone Target.md", "^a")] },
			["Kept.md", "S.md"],
		);
		expect(disk(l).embeds).toEqual([kept]);
		expect(l.saves).toHaveBeenCalledTimes(1);
	});

	it("nothing to prune: no write", async () => {
		const l = await launch({ version: 1, files: {}, embeds: [embed("Kept.md", "S.md", "^a")] }, ["Kept.md", "S.md"]);
		expect(l.saves).not.toHaveBeenCalled();
	});

	it("prune runs inside onLayoutReady: before layout is ready nothing is dropped", async () => {
		const app = new App();
		const stored: Stored = { value: { version: 1, files: {}, embeds: [embed("Late.md", "S.md", "")] } };
		const plugin = new PersistentFoldedStatePlugin(app, manifest);
		plugin.loadData = async () => stored.value;
		plugin.saveData = async (data: unknown) => {
			stored.value = data;
		};
		await plugin.onload();
		expect(plugin.store.embedRecords()).toHaveLength(1); // the vault tree is not populated yet
		(app.workspace as unknown as { triggerLayoutReady(): void }).triggerLayoutReady();
		expect(plugin.store.embedRecords()).toHaveLength(0);
	});
});

describe("embed vault events: E8 corrupt or malformed data starts empty and never throws", () => {
	const cases: [string, unknown][] = [
		["missing data.json", null],
		["a string", "garbage"],
		["a top-level array", []],
		["embeds not an array", { version: 1, files: {}, embeds: { host: "H.md" } }],
		["malformed embed records", { version: 1, files: {}, embeds: [null, 5, "x", { host: 3 }, { host: "H.md" }] }],
	];
	it.each(cases)("%s: rename, delete and prune throw nothing and write nothing", async (_label, data) => {
		const l = await launch(data, ["H.md", "S.md"]);
		await expect(
			(async () => {
				await rename(l, "H2.md", "H.md");
				await remove(l, "S.md");
				await remove(l, "Folder");
			})(),
		).resolves.toBeUndefined();
		await vi.advanceTimersByTimeAsync(1000);
		expect(l.plugin.store.embedRecords()).toEqual([]);
		expect(l.saves).not.toHaveBeenCalled();
	});
});

describe("embed vault events: a file with no `embeds` section gets none from a rename or delete (data-json unchanged)", () => {
	it("a notes-only file keeps its shape", async () => {
		const original = { version: 1, files: { "Tasks.md": { contentHash: "n1", folds: [], dormant: [] } } };
		const l = await launch(structuredClone(original), ["Tasks.md"]);
		await rename(l, "Tasks 2.md", "Other.md"); // no record anywhere: a miss
		await remove(l, "Other.md");
		expect(l.saves).not.toHaveBeenCalled();
		expect(l.stored.value).toEqual(original);
		await rename(l, "Tasks Renamed.md", "Tasks.md"); // the note-level handler writes; the embed path adds no section
		expect(l.stored.value).toEqual({ version: 1, files: { "Tasks Renamed.md": original.files["Tasks.md"] } });
		expect("embeds" in (l.stored.value as object)).toBe(false);
	});
});

describe("embed vault events: heading rename (G17)", () => {
	const BEFORE = [
		{ heading: "Intro", level: 1 },
		{ heading: "Lesson 8", level: 2 },
		{ heading: "Lesson 9", level: 2 },
	];
	const AFTER = [
		{ heading: "Intro", level: 1 },
		{ heading: "Lesson 8 (revised)", level: 2 },
		{ heading: "Lesson 9", level: 2 },
	];

	function seed(extra: EmbedFoldRecord[] = []): unknown {
		return { version: 1, files: {}, embeds: [embed(HOST, SOURCE, "Lesson 8", 0, "keep"), embed(HOST, SOURCE, "^0169a6"), ...extra] };
	}

	/** The metadata events of one Obsidian heading rename: the source is re-parsed with the new
	 * heading, then the host is re-parsed with its link rewritten. */
	async function obsidianRenamesHeading(app: App, linkInHost = "Fundamentals#Lesson 8 (revised)", targetHeadings = AFTER): Promise<void> {
		cacheOf(app).setCache(SOURCE, { headings: targetHeadings });
		await changed(app, SOURCE);
		cacheOf(app).setCache(HOST, { embeds: [{ link: linkInHost }, { link: "Fundamentals#^0169a6" }] });
		await changed(app, HOST);
	}

	async function launched(extra: EmbedFoldRecord[] = []): Promise<Launch> {
		const app = new App();
		cacheOf(app).setCache(SOURCE, { headings: BEFORE });
		return await launch(seed(extra), [HOST, SOURCE, "Other.md"], app);
	}

	it("one migration and one persisted write: the subpath follows the heading; occurrence, folds, hash kept; no dormant period; block embed untouched", async () => {
		const l = await launched();
		await obsidianRenamesHeading(l.app);
		expect(l.saves).toHaveBeenCalledTimes(1);
		const [moved, block] = disk(l).embeds ?? [];
		expect(moved).toEqual(embed(HOST, SOURCE, "Lesson 8 (revised)", 0, "keep"));
		expect("dormantSince" in moved).toBe(false);
		expect(block).toEqual(embed(HOST, SOURCE, "^0169a6"));
		expect(l.vaultWrites.map((spy) => spy.mock.calls.length)).toEqual(WRITES.map(() => 0));
	});

	/** The order real Obsidian uses for "Rename this heading...": the links in the host are
	 * rewritten and the host re-parsed first, and the source's own file is written and re-parsed
	 * about two seconds later (seen over CDP in tests/e2e/embed-rename-delete.e2e.ts). */
	async function obsidianRenamesHeadingLinksFirst(app: App, linkInHost = "Fundamentals#Lesson 8 (revised)", targetHeadings = AFTER): Promise<void> {
		cacheOf(app).setCache(HOST, { embeds: [{ link: linkInHost }, { link: "Fundamentals#^0169a6" }] });
		await changed(app, HOST);
		await vi.advanceTimersByTimeAsync(2000);
		cacheOf(app).setCache(SOURCE, { headings: targetHeadings });
		await changed(app, SOURCE);
	}

	it("real Obsidian's order, the host's rewritten links first and the source two seconds later: the same one migration and one write", async () => {
		const l = await launched([embed(HOST, SOURCE, "Lesson 8", 1, "second"), embed("Other.md", SOURCE, "Lesson 8", 0, "other")]);
		await obsidianRenamesHeadingLinksFirst(l.app);
		expect(l.saves).toHaveBeenCalledTimes(1);
		const [moved, block, second, other] = disk(l).embeds ?? [];
		expect(moved).toEqual(embed(HOST, SOURCE, "Lesson 8 (revised)", 0, "keep"));
		expect(second.subpath).toBe("Lesson 8 (revised)"); // the host's second occurrence follows too
		expect(block).toEqual(embed(HOST, SOURCE, "^0169a6"));
		expect(other.subpath).toBe("Lesson 8"); // its own note is re-parsed separately
		expect((disk(l).embeds ?? []).some((r) => "dormantSince" in r)).toBe(false);
		expect(l.vaultWrites.map((spy) => spy.mock.calls.length)).toEqual(WRITES.map(() => 0));
	});

	it("real Obsidian's order, a second host re-parsed after the source: its links migrate when they arrive", async () => {
		const l = await launched([embed("Other.md", SOURCE, "Lesson 8", 0, "other")]);
		await obsidianRenamesHeadingLinksFirst(l.app);
		cacheOf(l.app).setCache("Other.md", { embeds: [{ link: "Fundamentals#Lesson 8 (revised)" }] });
		await changed(l.app, "Other.md");
		expect((disk(l).embeds ?? []).map((r) => [r.host, r.subpath])).toEqual([
			[HOST, "Lesson 8 (revised)"],
			[HOST, "^0169a6"],
			["Other.md", "Lesson 8 (revised)"],
		]);
	});

	it("real Obsidian's order, a link edited by hand and a rename of the heading in the target more than the window later: no migration", async () => {
		const l = await launched();
		cacheOf(l.app).setCache(HOST, { embeds: [{ link: "Fundamentals#Lesson 9" }, { link: "Fundamentals#^0169a6" }] });
		await changed(l.app, HOST);
		await vi.advanceTimersByTimeAsync(PENDING_WINDOW_MS + 1000);
		cacheOf(l.app).setCache(SOURCE, { headings: AFTER });
		await changed(l.app, SOURCE);
		expect(l.saves).not.toHaveBeenCalled();
		expect((disk(l).embeds ?? [])[0].subpath).toBe("Lesson 8");
	});

	it("real Obsidian's order, a link edited by hand to a different heading, then the target's headings change for another reason inside the window: the rule says no", async () => {
		const l = await launched();
		cacheOf(l.app).setCache(HOST, { embeds: [{ link: "Fundamentals#Lesson 9" }, { link: "Fundamentals#^0169a6" }] });
		await changed(l.app, HOST);
		cacheOf(l.app).setCache(SOURCE, { headings: AFTER });
		await changed(l.app, SOURCE);
		expect(l.saves).not.toHaveBeenCalled();
		expect((disk(l).embeds ?? [])[0].subpath).toBe("Lesson 8");
	});

	it("is a migration, not a retarget: nothing is stamped dormant and no forget timer fires later", async () => {
		const l = await launched();
		await obsidianRenamesHeading(l.app);
		await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
		expect(keys(l)).toEqual([`${HOST} > ${SOURCE}#Lesson 8 (revised) [0]`, `${HOST} > ${SOURCE}#^0169a6 [0]`]);
		expect((disk(l).embeds ?? []).some((r) => "dormantSince" in r)).toBe(false);
		expect(l.saves).toHaveBeenCalledTimes(1);
	});

	it("migrates every record that follows the heading: twice in one host, and in a second host", async () => {
		const l = await launched([embed(HOST, SOURCE, "Lesson 8", 1, "second"), embed("Other.md", SOURCE, "Lesson 8", 0, "other")]);
		await obsidianRenamesHeading(l.app);
		expect((disk(l).embeds ?? []).map((r) => [r.host, r.subpath, r.occurrence])).toEqual([
			[HOST, "Lesson 8 (revised)", 0],
			[HOST, "^0169a6", 0],
			[HOST, "Lesson 8 (revised)", 1],
			["Other.md", "Lesson 8", 0], // its own note is re-parsed separately
		]);
		const cache = cacheOf(l.app);
		cache.setCache("Other.md", { embeds: [{ link: "Fundamentals#Lesson 8 (revised)" }] });
		await changed(l.app, "Other.md");
		expect((disk(l).embeds ?? []).find((r) => r.host === "Other.md")?.subpath).toBe("Lesson 8 (revised)");
	});

	it("a heading rename whose new name collides with an existing stored key replaces the destination record", async () => {
		const l = await launched([embed(HOST, SOURCE, "Lesson 8 (revised)", 0, "stale")]);
		await obsidianRenamesHeading(l.app);
		expect((disk(l).embeds ?? []).filter((r) => r.subpath === "Lesson 8 (revised)").map((r) => r.contentHash)).toEqual(["keep"]);
		expect((disk(l).embeds ?? []).some((r) => r.subpath === "Lesson 8")).toBe(false);
	});

	it("a link edited by hand to a different heading (the target keeps its heading) is a retarget: nothing migrates, nothing is written", async () => {
		const l = await launched();
		const cache = cacheOf(l.app);
		cache.setCache(SOURCE, { headings: BEFORE });
		await changed(l.app, SOURCE);
		cache.setCache(HOST, { embeds: [{ link: "Fundamentals#Lesson 9" }, { link: "Fundamentals#^0169a6" }] });
		await changed(l.app, HOST);
		expect(l.saves).not.toHaveBeenCalled();
		expect(keys(l).length).toBe(2);
		expect((l.stored.value as Disk).embeds?.[0].subpath).toBe("Lesson 8");
	});

	it("delete-and-add in the target, with a link to the new name, is not a rename", async () => {
		const l = await launched();
		await obsidianRenamesHeading(l.app, "Fundamentals#Lesson 8 (revised)", [
			{ heading: "Intro", level: 1 },
			{ heading: "Lesson 9", level: 2 },
			{ heading: "Lesson 8 (revised)", level: 2 },
		]);
		expect(l.saves).not.toHaveBeenCalled();
	});

	it("a heading rename leaves whole-note and block embeds of the same source alone: same objects, one write for the heading record only", async () => {
		const l = await launched([embed(HOST, SOURCE, "", 0, "whole")]);
		await obsidianRenamesHeading(l.app);
		expect(l.saves).toHaveBeenCalledTimes(1);
		const [moved, block, whole] = disk(l).embeds ?? [];
		expect(moved.subpath).toBe("Lesson 8 (revised)");
		expect(block).toEqual(embed(HOST, SOURCE, "^0169a6"));
		expect(whole).toEqual(embed(HOST, SOURCE, "", 0, "whole")); // key, hash and folds as stored: the PR-6 matcher re-matches it on render
	});

	it("case-different and similarly named headings are not touched: only the exact heading's record follows the rename", async () => {
		const l = await launched([
			embed(HOST, SOURCE, "lesson 8", 0, "lower"),
			embed(HOST, SOURCE, "LESSON 8", 0, "upper"),
			embed(HOST, SOURCE, "Lesson 8 and more", 0, "longer"),
			embed(HOST, SOURCE, "Lesson 80", 0, "prefix"),
			embed(HOST, SOURCE, "Lesson  8", 0, "spaced"),
		]);
		// Obsidian rewrote only the link to the exact heading; the others read as they did.
		cacheOf(l.app).setCache(SOURCE, { headings: AFTER });
		await changed(l.app, SOURCE);
		cacheOf(l.app).setCache(HOST, {
			embeds: [
				{ link: "Fundamentals#Lesson 8 (revised)" },
				{ link: "Fundamentals#^0169a6" },
				{ link: "Fundamentals#lesson 8" },
				{ link: "Fundamentals#LESSON 8" },
				{ link: "Fundamentals#Lesson 8 and more" },
				{ link: "Fundamentals#Lesson 80" },
				{ link: "Fundamentals#Lesson  8" },
			],
		});
		await changed(l.app, HOST);
		expect(l.saves).toHaveBeenCalledTimes(1);
		expect((disk(l).embeds ?? []).map((r) => [r.subpath, r.contentHash])).toEqual([
			["Lesson 8 (revised)", "keep"],
			["^0169a6", "slice"],
			["lesson 8", "lower"],
			["LESSON 8", "upper"],
			["Lesson 8 and more", "longer"],
			["Lesson 80", "prefix"],
			["Lesson  8", "spaced"],
		]);
	});

	it("a rewritten link to a case-different spelling of the new name is not the rename: nothing migrates, nothing is written", async () => {
		const l = await launched();
		await obsidianRenamesHeading(l.app, "Fundamentals#lesson 8 (REVISED)");
		expect(l.saves).not.toHaveBeenCalled();
		expect((disk(l).embeds ?? [])[0].subpath).toBe("Lesson 8");
	});

	it("a heading rename in the target where the host stored a case-different spelling of the old name migrates nothing", async () => {
		const app = new App();
		cacheOf(app).setCache(SOURCE, { headings: BEFORE });
		const l = await launch({ version: 1, files: {}, embeds: [embed(HOST, SOURCE, "lesson 8", 0, "lower")] }, [HOST, SOURCE], app);
		await obsidianRenamesHeading(l.app);
		expect(l.saves).not.toHaveBeenCalled();
		expect((disk(l).embeds ?? [])[0].subpath).toBe("lesson 8");
	});

	it("a host with no `embeds` record produces no write", async () => {
		const app = new App();
		cacheOf(app).setCache(SOURCE, { headings: BEFORE });
		const l = await launch({ version: 1, files: {} }, [HOST, SOURCE], app);
		await obsidianRenamesHeading(l.app);
		await vi.advanceTimersByTimeAsync(1000);
		expect(l.saves).not.toHaveBeenCalled();
	});

	it("a rewritten link that arrives after the pending window has passed is not a rename", async () => {
		const l = await launched();
		const cache = cacheOf(l.app);
		cache.setCache(SOURCE, { headings: AFTER });
		await changed(l.app, SOURCE);
		await vi.advanceTimersByTimeAsync(PENDING_WINDOW_MS + 1);
		cache.setCache(HOST, { embeds: [{ link: "Fundamentals#Lesson 8 (revised)" }] });
		await changed(l.app, HOST);
		expect(l.saves).not.toHaveBeenCalled();
	});

	it("a rename of the note between the heading change and the link rewrite still migrates", async () => {
		const l = await launched();
		const cache = cacheOf(l.app);
		cache.setCache(SOURCE, { headings: AFTER });
		await changed(l.app, SOURCE);
		await rename(l, "Lessons/Moved.md", SOURCE);
		cache.setCache(HOST, { embeds: [{ link: "Moved#Lesson 8 (revised)" }] });
		vaultOf(l.app).setExists("Lessons/Moved.md");
		await changed(l.app, HOST);
		expect((disk(l).embeds ?? []).map((r) => [r.target, r.subpath])).toContainEqual(["Lessons/Moved.md", "Lesson 8 (revised)"]);
	});

	it("E9: after a migration, disable then re-enable leaves the migrated state intact, byte for byte", async () => {
		const l = await launched();
		await obsidianRenamesHeading(l.app);
		const bytes = JSON.stringify(l.stored.value);
		l.plugin.unload();
		await vi.advanceTimersByTimeAsync(0);
		expect(JSON.stringify(l.stored.value)).toBe(bytes);
		const again = await launch(l.stored.value, [HOST, SOURCE]);
		expect(JSON.stringify(again.stored.value)).toBe(bytes);
		expect(again.plugin.store.embedRecords().map((r) => r.subpath)).toEqual(["Lesson 8 (revised)", "^0169a6"]);
		expect(again.saves).not.toHaveBeenCalled();
	});

	it("F7: the heading-rename code only reads the metadata cache; no vault write API was called, and a thrown cache read does not escape", async () => {
		const l = await launched();
		await obsidianRenamesHeading(l.app);
		expect(l.vaultWrites.map((spy) => spy.mock.calls.length)).toEqual(WRITES.map(() => 0));
		const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const cache = cacheOf(l.app);
		expect(() => cache.trigger("changed", new MockTFile(SOURCE), "", { get headings(): never { throw new Error("cache read failed"); } })).not.toThrow();
		expect(spy).toHaveBeenCalled();
	});
});
