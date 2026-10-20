import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Plugin, type PluginManifest } from "obsidian";
import type { Plugin as MockPlugin } from "../mocks/obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import { FORGET_NOTE_FOLDS_COMMAND_ID } from "../../src/commands";

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

	it("onload registers exactly the one command and one settings tab", async () => {
		const plugin = makePlugin();
		const addCommand = vi.spyOn(plugin, "addCommand");
		const addSettingTab = vi.spyOn(plugin, "addSettingTab");

		await plugin.onload();

		expect(addCommand).toHaveBeenCalledTimes(1);
		expect(addCommand.mock.calls[0][0].id).toBe(FORGET_NOTE_FOLDS_COMMAND_ID);
		expect(addSettingTab).toHaveBeenCalledTimes(1);
		// F10: no debug command — the registered command list is exactly this one.
		expect((plugin as unknown as MockPlugin).getCommands().map((command) => command.id)).toEqual([
			FORGET_NOTE_FOLDS_COMMAND_ID,
		]);
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

			expect(addCommand).toHaveBeenCalledTimes(1);
			expect(addCommand.mock.calls[0][0].id).toBe(FORGET_NOTE_FOLDS_COMMAND_ID);
			expect(addSettingTab).toHaveBeenCalledTimes(1);
		});
	}
});
