import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type PluginManifest } from "obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import { PersistentFoldedStateSettingTab } from "../../src/settings-tab";
import { collectNotices } from "../helpers";
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

async function makeTab(): Promise<{ plugin: PersistentFoldedStatePlugin; tab: PersistentFoldedStateSettingTab }> {
	const plugin = new PersistentFoldedStatePlugin(new App(), manifest);
	await plugin.onload();
	const tab = new PersistentFoldedStateSettingTab(plugin.app, plugin);
	return { plugin, tab };
}

function modalButtons(): HTMLButtonElement[] {
	return Array.from(document.querySelectorAll(".modal-container button"));
}

function clickByText(buttons: HTMLButtonElement[], text: string): void {
	const button = buttons.find((b) => b.textContent === text);
	if (!button) throw new Error(`no button with text "${text}" (have: ${buttons.map((b) => b.textContent).join(", ")})`);
	button.click();
}

describe("settings tab: structure (F7 fence)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("holds exactly one control (a Setting with one button); no other settings, headings or toggles", async () => {
		const { tab } = await makeTab();
		tab.display();

		const settingItems = tab.containerEl.querySelectorAll(".setting-item");
		expect(settingItems).toHaveLength(1);
		expect(tab.containerEl.querySelectorAll(".setting-item-heading")).toHaveLength(0);
		expect(tab.containerEl.querySelectorAll("input[type=checkbox]")).toHaveLength(0);
		expect(tab.containerEl.querySelectorAll("button")).toHaveLength(1);
	});

	it("display() called twice (re-opening the tab) still shows exactly one control", async () => {
		const { tab } = await makeTab();
		tab.display();
		tab.display();
		expect(tab.containerEl.querySelectorAll(".setting-item")).toHaveLength(1);
		expect(tab.containerEl.querySelectorAll("button")).toHaveLength(1);
	});
});

describe("settings tab: confirmation flow (G12)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("clicking the button opens a modal with Cancel and a destructive confirm button", async () => {
		const { tab } = await makeTab();
		tab.display();

		const openButton = tab.containerEl.querySelector("button") as HTMLButtonElement;
		openButton.click();

		expect(document.querySelectorAll(".modal-container")).toHaveLength(1);
		const buttons = modalButtons();
		expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Forget all stored folds"]);
		expect(buttons[1].classList.contains("mod-destructive")).toBe(true);
	});

	it("Cancel leaves the store and data.json unchanged", async () => {
		const { plugin, tab } = await makeTab();
		plugin.store.set("Tasks.md", { contentHash: "abc", folds: [], dormant: [] });
		await plugin.store.flush();
		tab.display();

		(tab.containerEl.querySelector("button") as HTMLButtonElement).click();
		clickByText(modalButtons(), "Cancel");

		expect(document.querySelectorAll(".modal-container")).toHaveLength(0);
		expect(plugin.store.size).toBe(1);
		expect(plugin.store.get("Tasks.md")).toBeDefined();
	});

	it("Escape leaves the store and data.json unchanged", async () => {
		const { plugin, tab } = await makeTab();
		plugin.store.set("Tasks.md", { contentHash: "abc", folds: [], dormant: [] });
		await plugin.store.flush();
		tab.display();

		(tab.containerEl.querySelector("button") as HTMLButtonElement).click();
		expect(document.querySelectorAll(".modal-container")).toHaveLength(1);

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

		expect(document.querySelectorAll(".modal-container")).toHaveLength(0);
		expect(plugin.store.size).toBe(1);
	});

	it("clicking outside the modal leaves the store and data.json unchanged", async () => {
		const { plugin, tab } = await makeTab();
		plugin.store.set("Tasks.md", { contentHash: "abc", folds: [], dormant: [] });
		await plugin.store.flush();
		tab.display();

		(tab.containerEl.querySelector("button") as HTMLButtonElement).click();
		const backdrop = document.querySelector(".modal-container") as HTMLElement;
		backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(document.querySelectorAll(".modal-container")).toHaveLength(0);
		expect(plugin.store.size).toBe(1);
	});

	it("clicking inside the modal content does not close it (only a direct backdrop click does)", async () => {
		const { tab } = await makeTab();
		tab.display();
		(tab.containerEl.querySelector("button") as HTMLButtonElement).click();

		const modalEl = document.querySelector(".modal") as HTMLElement;
		modalEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(document.querySelectorAll(".modal-container")).toHaveLength(1);
	});

	it("confirming empties the whole map, flushes at once, and shows a Notice with the count", async () => {
		const { plugin, tab } = await makeTab();
		plugin.store.set("A.md", { contentHash: "a", folds: [], dormant: [] });
		plugin.store.set("B.md", { contentHash: "b", folds: [], dormant: [] });
		tab.display();

		const notices = collectNotices();
		(tab.containerEl.querySelector("button") as HTMLButtonElement).click();
		clickByText(modalButtons(), "Forget all stored folds");

		expect(document.querySelectorAll(".modal-container")).toHaveLength(0);
		expect(plugin.store.size).toBe(0);
		expect(notices.messages).toEqual(["Cleared stored folds for 2 notes."]);
		notices.stop();

		await vi.waitFor(async () => {
			const saved = (await plugin.loadData()) as { files: Record<string, unknown> };
			expect(saved.files).toEqual({});
		});
	});

	it("confirming with exactly one note stored uses singular wording", async () => {
		const { plugin, tab } = await makeTab();
		plugin.store.set("A.md", { contentHash: "a", folds: [], dormant: [] });
		tab.display();

		const notices = collectNotices();
		(tab.containerEl.querySelector("button") as HTMLButtonElement).click();
		clickByText(modalButtons(), "Forget all stored folds");

		expect(notices.messages).toEqual(["Cleared stored folds for 1 note."]);
		notices.stop();
	});

	it("a double-clicked button opens only one modal", async () => {
		const { tab } = await makeTab();
		tab.display();

		const openButton = tab.containerEl.querySelector("button") as HTMLButtonElement;
		openButton.click();
		openButton.click();

		expect(document.querySelectorAll(".modal-container")).toHaveLength(1);
	});

	it("after closing a modal, the button opens a fresh one again", async () => {
		const { tab } = await makeTab();
		tab.display();
		const openButton = tab.containerEl.querySelector("button") as HTMLButtonElement;

		openButton.click();
		clickByText(modalButtons(), "Cancel");
		expect(document.querySelectorAll(".modal-container")).toHaveLength(0);

		openButton.click();
		expect(document.querySelectorAll(".modal-container")).toHaveLength(1);
	});
});

// --- Embed state (ticket warkworth-21, PR-1) ------------------------------------------------------

function embed(host: string, target: string, occurrence = 0): EmbedFoldRecord {
	return { host, target, subpath: "^abc", occurrence, contentHash: "e", folds: [], dormant: [] };
}

type Saved = { files: Record<string, unknown>; embeds?: unknown[] } | null;

describe("settings tab: Forget all also clears embed state (G15)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	async function withEmbeds() {
		const made = await makeTab();
		made.plugin.store.set("A.md", { contentHash: "a", folds: [], dormant: [] });
		made.plugin.store.set("B.md", { contentHash: "b", folds: [], dormant: [] });
		made.plugin.store.setEmbed(embed("A.md", "T.md", 0));
		made.plugin.store.setEmbed(embed("A.md", "T.md", 1));
		made.plugin.store.setEmbed(embed("B.md", "T.md", 0));
		await made.plugin.store.flush();
		made.tab.display();
		return made;
	}

	it("still holds exactly one control", async () => {
		const { tab } = await withEmbeds();
		expect(tab.containerEl.querySelectorAll(".setting-item")).toHaveLength(1);
		expect(tab.containerEl.querySelectorAll("button")).toHaveLength(1);
	});

	it("confirming clears the notes and the embeds, flushes at once, and the Notice reports both counts", async () => {
		const { plugin, tab } = await withEmbeds();
		const saveData = vi.spyOn(plugin, "saveData");

		const notices = collectNotices();
		(tab.containerEl.querySelector("button") as HTMLButtonElement).click();
		vi.useFakeTimers(); // from here a 150ms debounce could never fire: only an immediate flush writes
		try {
			clickByText(modalButtons(), "Forget all stored folds");
			await vi.advanceTimersByTimeAsync(0);
			expect(saveData).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
		notices.stop();

		expect(plugin.store.size).toBe(0);
		expect(plugin.store.embedSize).toBe(0);
		expect(notices.messages).toEqual(["Cleared stored folds for 2 notes and 3 embeds."]);

		await plugin.store.flush(); // nothing left to write
		expect(saveData).toHaveBeenCalledTimes(1);
		const saved = (await plugin.loadData()) as Saved;
		expect(saved).toEqual({ version: 1, files: {} });
		expect(saved && "embeds" in saved).toBe(false);
	});

	it("one note and one embed use singular wording for both", async () => {
		const { plugin, tab } = await makeTab();
		plugin.store.set("A.md", { contentHash: "a", folds: [], dormant: [] });
		plugin.store.setEmbed(embed("A.md", "T.md"));
		tab.display();

		const notices = collectNotices();
		(tab.containerEl.querySelector("button") as HTMLButtonElement).click();
		clickByText(modalButtons(), "Forget all stored folds");
		notices.stop();

		expect(notices.messages).toEqual(["Cleared stored folds for 1 note and 1 embed."]);
	});

	it("a store holding only embeds is cleared and flushed, and the Notice reports 0 notes", async () => {
		const { plugin, tab } = await makeTab();
		plugin.store.setEmbed(embed("A.md", "T.md"));
		plugin.store.setEmbed(embed("A.md", "U.md"));
		await plugin.store.flush();
		tab.display();

		const notices = collectNotices();
		(tab.containerEl.querySelector("button") as HTMLButtonElement).click();
		clickByText(modalButtons(), "Forget all stored folds");
		notices.stop();

		expect(notices.messages).toEqual(["Cleared stored folds for 0 notes and 2 embeds."]);
		await plugin.store.flush();
		expect(((await plugin.loadData()) as Saved)).toEqual({ version: 1, files: {} });
	});

	it("with no embeds the wording is unchanged: plural, then singular", async () => {
		for (const [count, expected] of [
			[2, "Cleared stored folds for 2 notes."],
			[1, "Cleared stored folds for 1 note."],
		] as const) {
			const { plugin, tab } = await makeTab();
			for (let i = 0; i < count; i++) plugin.store.set(`N${i}.md`, { contentHash: "n", folds: [], dormant: [] });
			tab.display();
			const notices = collectNotices();
			(tab.containerEl.querySelector("button") as HTMLButtonElement).click();
			clickByText(modalButtons(), "Forget all stored folds");
			notices.stop();
			expect(notices.messages).toEqual([expected]);
			document.body.replaceChildren();
		}
	});

	const dismissals: { label: string; dismiss: () => void }[] = [
		{ label: "Cancel", dismiss: () => clickByText(modalButtons(), "Cancel") },
		{ label: "Escape", dismiss: () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })) },
		{
			label: "an outside click",
			dismiss: () => void (document.querySelector(".modal-container") as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })),
		},
	];
	it.each(dismissals)("$label leaves the embeds in memory and in data.json", async ({ dismiss }) => {
		const { plugin, tab } = await withEmbeds();

		const notices = collectNotices();
		(tab.containerEl.querySelector("button") as HTMLButtonElement).click();
		dismiss();
		notices.stop();

		expect(document.querySelectorAll(".modal-container")).toHaveLength(0);
		expect(notices.messages).toEqual([]);
		expect(plugin.store.embedSize).toBe(3);
		await plugin.store.flush();
		const saved = (await plugin.loadData()) as Saved;
		expect(saved?.embeds).toHaveLength(3);
		expect(Object.keys(saved?.files ?? {})).toEqual(["A.md", "B.md"]);
	});
});
