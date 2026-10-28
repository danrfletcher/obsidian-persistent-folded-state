/**
 * Fence checks for recorded embed folds (PR-4): F7 (no write to the host or the source note),
 * F10 (no touch of Obsidian's localStorage fold store), F1 (no added controls or classes on an
 * embed), F8 (command list and settings tab unchanged), run across a full click sequence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import type { PluginManifest } from "obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import { COPY_DIAGNOSTIC_LOG_COMMAND_ID, FORGET_NOTE_FOLDS_COMMAND_ID } from "../../src/commands";
import { HEADED_NOTE, HEADED_TEXT, LESSONS_NOTE, LESSONS_TEXT, SOURCE, SOURCE_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";
import type { Mode } from "../fixtures/embed-recording-world";

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
afterEach(() => {
	for (const w of worlds.splice(0)) w.recorder.dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

const NOTES: [string, string][] = [
	[SOURCE, SOURCE_TEXT],
	[LESSONS_NOTE, LESSONS_TEXT],
	[HEADED_NOTE, HEADED_TEXT],
];

async function contentOf(w: World, path: string): Promise<string> {
	const file = w.app.vault.getFileByPath(path);
	return file === null ? "" : await w.app.vault.cachedRead(file);
}

/** A full click sequence: folds, unfolds and a re-fold in block, heading and whole-note embeds,
 * two identical embeds, and a nested embed. */
async function clickEverything(w: World, mode: Mode): Promise<void> {
	w.addNote("Outer.md", "- [ ] Outer item\n  - [ ] Outer sub\n\n![[Lessons]]\n");
	const host = w.addHost("Host.md", mode, "![[Competitive Coding Fundamentals#^0169a6]]\n\n![[Lessons]]\n\n![[Lessons]]\n\n![[Headed#Lesson 8]]\n\n![[Outer]]\n");
	const [block, whole, second, heading, outer] = host.embeds;
	w.realClick(arrowFor(block, "Lesson 8"));
	w.realClick(arrowFor(block, "Count word frequency"));
	w.realClick(arrowFor(whole, "Lesson 2"));
	w.realClick(arrowFor(second, "Lesson 3"));
	w.realClick(arrowFor(heading, "Lesson 8"));
	w.realClick(arrowFor(outer, "Outer item"));
	w.realClick(arrowFor(outer.querySelector<HTMLElement>(".internal-embed")!, "Lesson 1"));
	w.realClick(arrowFor(block, "Lesson 8"));
	w.realClick(arrowFor(whole, "Lesson 2"));
	w.realClick(arrowFor(whole, "Lesson 2"));
	await w.settle();
	await w.store.flush();
}

describe.each(["live-preview", "reading-view"] as const)("%s: fences hold across a full click sequence", (mode) => {
	it("F7: no vault.modify, vault.process or processFrontMatter call, and every note's content is unchanged", async () => {
		const w = new World();
		worlds.push(w);
		for (const [path, text] of NOTES) w.addNote(path, text);
		const modify = vi.fn();
		const process = vi.fn();
		const processFrontMatter = vi.fn();
		Object.assign(w.app.vault, { modify, process, create: modify, append: modify, adapter: { write: modify } });
		Object.assign(w.app, { fileManager: { processFrontMatter } });
		const before = await Promise.all(NOTES.map(([path]) => contentOf(w, path)));

		await clickEverything(w, mode);

		expect(w.store.embedSize).toBeGreaterThan(0);
		expect(modify).not.toHaveBeenCalled();
		expect(process).not.toHaveBeenCalled();
		expect(processFrontMatter).not.toHaveBeenCalled();
		expect(await Promise.all(NOTES.map(([path]) => contentOf(w, path)))).toEqual(before);
		expect(await contentOf(w, "Host.md")).toBe(
			"![[Competitive Coding Fundamentals#^0169a6]]\n\n![[Lessons]]\n\n![[Lessons]]\n\n![[Headed#Lesson 8]]\n\n![[Outer]]\n"
		);
	});

	it("F10: no write to Obsidian's localStorage fold store, and localStorage's methods are not patched", async () => {
		const setItem = vi.spyOn(Storage.prototype, "setItem");
		const removeItem = vi.spyOn(Storage.prototype, "removeItem");
		const clear = vi.spyOn(Storage.prototype, "clear");
		const methods = { setItem: Storage.prototype.setItem, removeItem: Storage.prototype.removeItem, getItem: Storage.prototype.getItem };
		const w = new World();
		worlds.push(w);
		for (const [path, text] of NOTES) w.addNote(path, text);

		await clickEverything(w, mode);

		expect(w.store.embedSize).toBeGreaterThan(0);
		expect(setItem).not.toHaveBeenCalled();
		expect(removeItem).not.toHaveBeenCalled();
		expect(clear).not.toHaveBeenCalled();
		expect(Storage.prototype.setItem).toBe(methods.setItem);
		expect(Storage.prototype.removeItem).toBe(methods.removeItem);
		expect(Storage.prototype.getItem).toBe(methods.getItem);
		expect(Object.getOwnPropertyNames(window.localStorage)).toEqual([]);
	});

	it("F1: the embed's DOM gains no element, attribute or class from the plugin, beyond what Obsidian's own click does", async () => {
		const w = new World({}, { attach: false });
		worlds.push(w);
		for (const [path, text] of NOTES) w.addNote(path, text);
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const embed = host.embeds[0];
		const shape = (): string => {
			const parts: string[] = [];
			for (const el of [embed, ...Array.from(embed.querySelectorAll("*"))]) {
				const classes = Array.from(el.classList).filter((c) => c !== "is-collapsed").sort();
				const attrs = el.getAttributeNames().filter((a) => a !== "class").sort();
				parts.push(`${el.tagName}.${classes.join(".")}[${attrs.join(",")}]`);
			}
			return parts.join("\n");
		};
		const before = shape();
		const html = embed.outerHTML;

		w.recorder.attach(document);
		expect(embed.outerHTML).toBe(html);
		w.realClick(arrowFor(embed, "Lesson 2"));
		w.realClick(arrowFor(embed, "Lesson 3"));
		w.realClick(arrowFor(embed, "Lesson 2"));
		await w.settle();

		expect(shape()).toBe(before);
		expect(document.body.querySelectorAll("style, link, button").length).toBe(0);
	});
});

describe("F8: the registered commands and settings tab are unchanged by this PR", () => {
	it("two commands (forget note folds, copy diagnostic log), one settings tab, no embed command", async () => {
		const plugin = new PersistentFoldedStatePlugin(new App(), manifest);
		const mock = plugin as unknown as { getCommands(): { id: string }[]; getSettingTabs(): unknown[] };

		await plugin.onload();

		// Warkworth-46 PR-1 (F6): narrowed from one command to these two; any embed command still fails.
		expect(mock.getCommands().map((c) => c.id)).toEqual([FORGET_NOTE_FOLDS_COMMAND_ID, COPY_DIAGNOSTIC_LOG_COMMAND_ID]);
		expect(mock.getSettingTabs()).toHaveLength(1);
		plugin.unload();
	});
});
