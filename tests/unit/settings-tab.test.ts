import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type PluginManifest } from "obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import { PersistentFoldedStateSettingTab } from "../../src/settings-tab";
import { collectNotices } from "../helpers";

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
