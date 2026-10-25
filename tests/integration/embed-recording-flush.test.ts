/**
 * Flush timing for recorded embed folds (PR-4): a recorded fold reaches the in-memory map at
 * once and `data.json` within 150 ms of the last change, and is also flushed on unload,
 * `visibilitychange` (hidden) and `pagehide`. Fake timers.
 *
 * The click-to-map-to-debounce half drives the real recorder and a real `FoldStore`. The lifecycle
 * half drives the real plugin: jsdom marks every dispatched event untrusted and the plugin has no
 * trust seam, so a record is put in the plugin's own store as the recorder would (`setEmbed`), and
 * the plugin's lifecycle hooks are fired for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import type { PluginManifest } from "obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import type { EmbedFoldRecord } from "../../src/types";
import { LESSONS_NOTE, LESSONS_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";

const manifest: PluginManifest = {
	id: "persistent-folded-state",
	name: "Persistent Folded State",
	version: "0.1.1",
	minAppVersion: "1.13.0",
	description: "test",
	author: "Dan Fletcher",
	isDesktopOnly: false,
};

const worlds: World[] = [];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const w of worlds.splice(0)) w.recorder.dispose();
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function world(): World {
	const w = new World();
	worlds.push(w);
	w.addNote(LESSONS_NOTE, LESSONS_TEXT);
	return w;
}

describe("a recorded fold is flushed through the existing debounce", () => {
	it("is in the map at once, and in data.json within 150 ms of the last change", async () => {
		const w = world();
		const host = w.addHost("Host.md", "live-preview", "![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await w.settle();
		expect(w.store.embedSize).toBe(1);
		expect(w.saved).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(149);
		expect(w.saved).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(w.saved).toHaveLength(1);
		expect((w.saved[0] as { embeds: EmbedFoldRecord[] }).embeds[0].folds).toHaveLength(1);
	});

	it("a second fold within the window restarts it: one write, 150 ms after the last change", async () => {
		const w = world();
		const host = w.addHost("Host.md", "reading-view", "![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 1"));
		await w.settle();
		await vi.advanceTimersByTimeAsync(100);
		w.realClick(arrowFor(host.embeds[0], "Lesson 3"));
		await w.settle();

		await vi.advanceTimersByTimeAsync(149);
		expect(w.saved).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(w.saved).toHaveLength(1);
		expect((w.saved[0] as { embeds: EmbedFoldRecord[] }).embeds[0].folds).toHaveLength(2);
	});

	it("an unfold is flushed the same way", async () => {
		const w = world();
		const host = w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		const arrow = arrowFor(host.embeds[0], "Lesson 2");
		w.realClick(arrow);
		await w.settle();
		await vi.advanceTimersByTimeAsync(150);

		w.realClick(arrow);
		await w.settle();
		await vi.advanceTimersByTimeAsync(150);

		expect(w.saved).toHaveLength(2);
		expect((w.saved[1] as { embeds: EmbedFoldRecord[] }).embeds[0].folds).toEqual([]);
	});

	it("rapid fold, unfold, fold within 150 ms: one write, and it matches the last click", async () => {
		const w = world();
		const host = w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		const arrow = arrowFor(host.embeds[0], "Lesson 2");

		w.realClick(arrow);
		await vi.advanceTimersByTimeAsync(40);
		w.realClick(arrow);
		await vi.advanceTimersByTimeAsync(40);
		w.realClick(arrow);
		await w.settle();
		await vi.advanceTimersByTimeAsync(150);

		expect(arrow.classList.contains("is-collapsed")).toBe(true);
		expect(w.saved).toHaveLength(1);
		const written = (w.saved[0] as { embeds: EmbedFoldRecord[] }).embeds;
		expect(written).toHaveLength(1);
		expect(written[0].folds).toHaveLength(1);
		expect(written[0].folds[0]).toMatchObject({ text: "lesson 2: maps" });
	});
});

describe("a recorded embed fold is flushed by the plugin's lifecycle hooks", () => {
	const RECORD: EmbedFoldRecord = {
		host: "Host.md",
		target: LESSONS_NOTE,
		subpath: "",
		occurrence: 0,
		contentHash: "h",
		folds: [{ kind: "task", indent: 0, text: "lesson 2: maps", siblingIndex: 1, parentChain: [] }],
		dormant: [],
	};

	async function loaded() {
		const plugin = new PersistentFoldedStatePlugin(new App(), manifest);
		const saveData = vi.spyOn(plugin, "saveData");
		await plugin.onload();
		plugin.store.setEmbed(structuredClone(RECORD));
		return { plugin, saveData };
	}

	it("on unload", async () => {
		const { plugin, saveData } = await loaded();
		expect(saveData).not.toHaveBeenCalled();

		plugin.unload();
		await vi.advanceTimersByTimeAsync(0);

		expect(saveData).toHaveBeenCalledTimes(1);
		expect((saveData.mock.calls[0][0] as { embeds: unknown[] }).embeds).toEqual([RECORD]);
	});

	it("on visibilitychange to hidden, at once and not before the debounce", async () => {
		const { plugin, saveData } = await loaded();
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");

		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);

		expect(saveData).toHaveBeenCalledTimes(1);
		expect((saveData.mock.calls[0][0] as { embeds: unknown[] }).embeds).toEqual([RECORD]);
		plugin.unload();
	});

	it("not on visibilitychange to visible", async () => {
		const { plugin, saveData } = await loaded();
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(0);

		expect(saveData).not.toHaveBeenCalled();
		plugin.unload();
	});

	it("on pagehide", async () => {
		const { plugin, saveData } = await loaded();

		window.dispatchEvent(new Event("pagehide"));
		await vi.advanceTimersByTimeAsync(0);

		expect(saveData).toHaveBeenCalledTimes(1);
		expect((saveData.mock.calls[0][0] as { embeds: unknown[] }).embeds).toEqual([RECORD]);
		plugin.unload();
	});
});
