import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Plugin, type PluginManifest } from "obsidian";
import type { Plugin as MockPlugin, Vault as MockVault } from "../mocks/obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import { COPY_DIAGNOSTIC_LOG_COMMAND_ID, FORGET_NOTE_FOLDS_COMMAND_ID } from "../../src/commands";

// Warkworth-46 PR-1 (F6): the command list is exactly these two, in this order. The second is
// "Copy diagnostic log". Any other command, ribbon icon, status bar item or view still fails.
const COMMAND_IDS = [FORGET_NOTE_FOLDS_COMMAND_ID, COPY_DIAGNOSTIC_LOG_COMMAND_ID];
import { SEED_EMBEDS, SEED_FILES } from "../fixtures/embed-seed";
import type { EmbedFoldRecord } from "../../src/types";

const manifest: PluginManifest = {
	id: "persistent-folded-state",
	name: "Persistent Folded State",
	version: "0.1.0",
	minAppVersion: "1.13.0",
	description: "test",
	author: "Dan Fletcher",
	isDesktopOnly: false,
};

function makePlugin(): PersistentFoldedStatePlugin {
	const app = new App();
	return new PersistentFoldedStatePlugin(app, manifest);
}

describe("lifecycle: onload/onunload flush", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("onload registers exactly the two commands and one settings tab", async () => {
		const plugin = makePlugin();
		const addCommand = vi.spyOn(plugin, "addCommand");
		const addSettingTab = vi.spyOn(plugin, "addSettingTab");

		await plugin.onload();

		expect(addCommand).toHaveBeenCalledTimes(2);
		expect(addCommand.mock.calls.map((call) => call[0].id)).toEqual(COMMAND_IDS);
		expect(addSettingTab).toHaveBeenCalledTimes(1);
		// F10 (narrowed by warkworth-46 PR-1): no debug command — the registered command list is
		// exactly the forget command and "Copy diagnostic log".
		expect((plugin as unknown as MockPlugin).getCommands().map((command) => command.id)).toEqual(COMMAND_IDS);
	});

	it("onunload flushes pending state at once", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		plugin.store.set("Tasks.md", { contentHash: "abc", folds: [], dormant: [] });

		plugin.onunload();
		await vi.advanceTimersByTimeAsync(0);

		const saved = (await plugin.loadData()) as { files: Record<string, unknown> };
		expect(Object.keys(saved.files)).toEqual(["Tasks.md"]);
	});

	it("visibilitychange turning hidden flushes at once", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		plugin.store.set("Tasks.md", { contentHash: "abc", folds: [], dormant: [] });

		Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);

		const saved = (await plugin.loadData()) as { files: Record<string, unknown> };
		expect(Object.keys(saved.files)).toEqual(["Tasks.md"]);
	});

	it("visibilitychange turning visible (not hidden) does not force an early flush", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		plugin.store.set("Tasks.md", { contentHash: "abc", folds: [], dormant: [] });

		Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);

		const saved = (await plugin.loadData()) as { files: Record<string, unknown> } | null;
		expect(saved).toBeNull(); // still unwritten; the 150ms debounce hasn't elapsed
	});

	it("pagehide flushes at once", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		plugin.store.set("Tasks.md", { contentHash: "abc", folds: [], dormant: [] });

		window.dispatchEvent(new Event("pagehide"));
		await vi.advanceTimersByTimeAsync(0);

		const saved = (await plugin.loadData()) as { files: Record<string, unknown> };
		expect(Object.keys(saved.files)).toEqual(["Tasks.md"]);
	});

	it("registerDomEvent listeners are gone after unload", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		plugin.unload(); // what Obsidian calls when disabling the plugin

		const flushSpy = vi.spyOn(plugin.store, "flush");
		Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("pagehide"));

		// Both listeners were registered via registerDomEvent; unload() must have detached them,
		// so neither event forces a flush anymore.
		expect(flushSpy).not.toHaveBeenCalled();
	});
});

describe("lifecycle: disable then re-enable keeps the map (E7)", () => {
	it("a new plugin instance over the same loadData/saveData loads the identical map", async () => {
		let stored: unknown = null;
		const app = new App();
		const sharedLoadData = async () => stored;
		const sharedSaveData = async (data: unknown) => {
			stored = data;
		};

		const first = new PersistentFoldedStatePlugin(app, manifest);
		first.loadData = sharedLoadData;
		first.saveData = sharedSaveData;
		// G9: pruneOrphans (onload) would otherwise drop "Tasks.md" immediately — this test
		// is about E7 (disable/re-enable keeps the map), not G9, so the file is seeded as
		// existing in the mock vault the same way a real one always would be.
		(app.vault as unknown as MockVault).setExists("Tasks.md");
		await first.onload();
		// PR-5: a fold entry must be a real Anchor (src/anchors.ts) to survive FoldStore's
		// load-time validation — a bare {kind: "heading"} is a PR-2-era shape and is discarded.
		first.store.set("Tasks.md", {
			contentHash: "abc",
			folds: [{ kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] }],
			dormant: [],
		});
		await first.store.flush();

		first.unload(); // "disable": must not clear, rewrite or delete the stored data
		const afterDisable = JSON.stringify(stored);

		const second = new PersistentFoldedStatePlugin(app, manifest);
		second.loadData = sharedLoadData;
		second.saveData = sharedSaveData;
		await second.onload(); // "re-enable"

		expect(JSON.stringify(stored)).toBe(afterDisable); // bytes identical across disable/re-enable
		expect(second.store.get("Tasks.md")).toEqual({
			contentHash: "abc",
			folds: [{ kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] }],
			dormant: [],
		});
	});
});

/** E8/R3: `onload()` itself (not just `FoldStore.load()`/`sanitizeStoreData()` in isolation) must
 * survive an absent, corrupt, rejecting or wrong-shape `loadData()` — resolving without throwing,
 * and still registering the command and the settings tab, so the plugin stays usable even when
 * `data.json` can't be read. */
describe("onload resilience: absent, corrupt, rejecting or wrong-shape loadData (E8/R3)", () => {
	const cases: { label: string; loadData: () => Promise<unknown> }[] = [
		{ label: "absent (loadData resolves null, the Obsidian convention)", loadData: async () => null },
		{
			label: "non-JSON on disk / a rejecting loadData()",
			loadData: async () => {
				throw new SyntaxError("Unexpected end of JSON input");
			},
		},
		{ label: "wrong shape: top-level array", loadData: async () => [] },
		{ label: "wrong shape: top-level string", loadData: async () => "not an object" },
		{ label: "wrong shape: files is not an object", loadData: async () => ({ version: 1, files: "nope" }) },
		{
			label: "wrong shape: one record missing contentHash",
			loadData: async () => ({ version: 1, files: { "Bad.md": { folds: [], dormant: [] } } }),
		},
	];

	for (const { label, loadData } of cases) {
		it(`${label}: onload resolves, and the command and settings tab are still registered`, async () => {
			const plugin = makePlugin();
			plugin.loadData = loadData;
			const addCommand = vi.spyOn(plugin, "addCommand");
			const addSettingTab = vi.spyOn(plugin, "addSettingTab");

			await expect(plugin.onload()).resolves.toBeUndefined();

			expect(addCommand).toHaveBeenCalledTimes(2);
			expect(addCommand.mock.calls.map((call) => call[0].id)).toEqual(COMMAND_IDS);
			expect(addSettingTab).toHaveBeenCalledTimes(1);
		});
	}
});

// --- Embed records through the plugin lifecycle (ticket warkworth-21, PR-1) -------------------

const SEED_DISK = { version: 1, files: SEED_FILES, embeds: SEED_EMBEDS };

function embedRecord(contentHash: string): EmbedFoldRecord {
	return { host: "Late.md", target: "Source.md", subpath: "", occurrence: 0, contentHash, folds: [], dormant: [] };
}

describe("lifecycle: embeds survive disable then re-enable (E9)", () => {
	// The seed's dormant entry is stamped at 1,000 ms; PR-7 forgets it after 10 minutes of wall
	// clock, so the clock (Date only) is pinned inside that window.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(2_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("bytes in data.json are identical across disable and re-enable, and the reloaded store returns the same records", async () => {
		let stored: unknown = structuredClone(SEED_DISK);
		const app = new App();
		const loadData = async () => structuredClone(stored);
		const saveData = vi.fn(async (data: unknown) => {
			stored = structuredClone(data);
		});
		for (const path of Object.keys(SEED_FILES)) (app.vault as unknown as MockVault).setExists(path);
		// PR-8: layout ready prunes an embed record whose host or target is not in the vault (G10).
		for (const record of SEED_EMBEDS) {
			(app.vault as unknown as MockVault).setExists(record.host);
			(app.vault as unknown as MockVault).setExists(record.target);
		}

		const first = new PersistentFoldedStatePlugin(app, manifest);
		first.loadData = loadData;
		first.saveData = saveData;
		await first.onload();
		(app.workspace as unknown as { triggerLayoutReady(): void }).triggerLayoutReady();
		await first.store.flush();
		const before = JSON.stringify(stored);
		expect(first.store.embedRecords()).toEqual(SEED_EMBEDS);

		first.unload(); // "disable"
		const afterDisable = JSON.stringify(stored);

		const second = new PersistentFoldedStatePlugin(app, manifest);
		second.loadData = loadData;
		second.saveData = saveData;
		await second.onload(); // "re-enable"
		await second.store.flush();

		expect(afterDisable).toBe(before);
		expect(JSON.stringify(stored)).toBe(before);
		expect(saveData).not.toHaveBeenCalled(); // nothing changed, so nothing was written at all
		expect(second.store.embedRecords()).toEqual(SEED_EMBEDS);
		expect(second.store.embedRecords()).toEqual(first.store.embedRecords());
		expect(second.store.get("Rocketship.md")).toEqual(SEED_FILES["Rocketship.md"]);
	});

	it("still registers exactly the two commands after a disable and re-enable", async () => {
		const app = new App();
		const first = new PersistentFoldedStatePlugin(app, manifest);
		first.loadData = async () => structuredClone(SEED_DISK);
		await first.onload();
		first.unload();

		const second = new PersistentFoldedStatePlugin(app, manifest);
		second.loadData = async () => structuredClone(SEED_DISK);
		await second.onload();
		expect((second as unknown as MockPlugin).getCommands().map((c) => c.id)).toEqual(COMMAND_IDS);
	});
});

describe("lifecycle: embed changes flush on unload, pagehide and visibilitychange (E9)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	async function pluginWithPendingEmbed() {
		const plugin = makePlugin();
		await plugin.onload();
		plugin.store.setEmbed(embedRecord("pending")); // schedules a flush 150ms out
		await vi.advanceTimersByTimeAsync(40);
		expect(((await plugin.loadData()) as unknown)).toBeNull(); // not yet on disk
		return plugin;
	}

	it("onunload writes a change made well inside the 150ms window", async () => {
		const plugin = await pluginWithPendingEmbed();
		plugin.onunload();
		await vi.advanceTimersByTimeAsync(0);
		const saved = (await plugin.loadData()) as { embeds: EmbedFoldRecord[] };
		expect(saved.embeds).toEqual([embedRecord("pending")]);
	});

	it("pagehide writes it", async () => {
		const plugin = await pluginWithPendingEmbed();
		window.dispatchEvent(new Event("pagehide"));
		await vi.advanceTimersByTimeAsync(0);
		const saved = (await plugin.loadData()) as { embeds: EmbedFoldRecord[] };
		expect(saved.embeds).toEqual([embedRecord("pending")]);
	});

	it("visibilitychange to hidden writes it", async () => {
		const plugin = await pluginWithPendingEmbed();
		Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		const saved = (await plugin.loadData()) as { embeds: EmbedFoldRecord[] };
		expect(saved.embeds).toEqual([embedRecord("pending")]);
	});

	it("visibilitychange to visible does not force the write early", async () => {
		const plugin = await pluginWithPendingEmbed();
		Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);
		expect(((await plugin.loadData()) as unknown)).toBeNull();
	});
});

// Ticket warkworth-21 PR-5 (F1): the embed restore adds no fold control, element or command, and
// no observer outlives the plugin.
describe("lifecycle: the embed restore adds no UI and leaves nothing behind (PR-5, F1)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		document.body.replaceChildren();
	});

	it("onload adds no element to the page, and the command list and settings tab are exactly what they were", async () => {
		const plugin = makePlugin();
		const addSettingTab = vi.spyOn(plugin, "addSettingTab");
		const bodyBefore = document.body.innerHTML;

		await plugin.onload();

		expect(document.body.innerHTML).toBe(bodyBefore);
		expect((plugin as unknown as MockPlugin).getCommands().map((command) => command.id)).toEqual(COMMAND_IDS);
		expect(addSettingTab).toHaveBeenCalledTimes(1);
		plugin.onunload();
	});

	it("every MutationObserver the plugin starts is disconnected by onunload, and none is left observing", async () => {
		const observed: MutationObserver[] = [];
		const disconnected: MutationObserver[] = [];
		const observe = vi.spyOn(MutationObserver.prototype, "observe").mockImplementation(function (this: MutationObserver) {
			observed.push(this);
		});
		const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect").mockImplementation(function (this: MutationObserver) {
			disconnected.push(this);
		});
		const plugin = makePlugin();

		await plugin.onload();
		// The restorer's render watcher (the recorder arms its own only per click).
		expect(observed.length).toBeGreaterThanOrEqual(1);
		plugin.onunload();

		for (const observer of observed) expect(disconnected).toContain(observer);
		expect(observe).toHaveBeenCalled();
		expect(disconnect).toHaveBeenCalled();
	});

	it("rendering an embed with nothing stored changes nothing on the page and writes nothing", async () => {
		const plugin = makePlugin();
		const saveData = vi.spyOn(plugin, "saveData");
		await plugin.onload();
		const embed = document.createElement("div");
		embed.className = "internal-embed markdown-embed inline-embed is-loaded";
		embed.setAttribute("src", "Lessons");
		embed.innerHTML = '<div class="markdown-embed-content"><ul><li><div class="list-collapse-indicator collapse-indicator"></div>x</li></ul></div>';
		document.body.append(embed);
		const markup = document.body.innerHTML;

		await vi.advanceTimersByTimeAsync(2000);

		expect(document.body.innerHTML).toBe(markup);
		expect(saveData).not.toHaveBeenCalled();
		expect(plugin.store.embedSize).toBe(0);
		plugin.onunload();
	});
});
