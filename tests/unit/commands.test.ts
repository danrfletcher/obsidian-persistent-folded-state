import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type Command, type PluginManifest } from "obsidian";
import { Editor as MockEditor, MarkdownView as MockMarkdownView, OtherView, TFile as MockTFile, Workspace as MockWorkspace } from "../mocks/obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import { FORGET_NOTE_FOLDS_COMMAND_ID, registerForgetNoteFoldsCommand } from "../../src/commands";
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

/** Bridges the real-typed `app.workspace` (so `plugin.app` keeps satisfying
 * `PersistentFoldedStatePlugin`'s own real "obsidian" types) to the mock's extra `setActiveView`
 * test hook — at runtime it's the exact same object either way, since the vitest alias points
 * both the "obsidian" specifier and this relative path at the one mock module. */
function setActiveView(plugin: PersistentFoldedStatePlugin, view: unknown): void {
	(plugin.app.workspace as unknown as InstanceType<typeof MockWorkspace>).setActiveView(view);
}

function makePlugin(): PersistentFoldedStatePlugin {
	return new PersistentFoldedStatePlugin(new App(), manifest);
}

/** Captures the one command `registerForgetNoteFoldsCommand` registers, bypassing the need for a
 * mock-only `getCommands()` on the real-typed `Plugin`. */
function getCommand(plugin: PersistentFoldedStatePlugin): Command {
	let registered: Command | undefined;
	plugin.addCommand = (command: Command) => {
		registered = command;
		return command;
	};
	registerForgetNoteFoldsCommand(plugin);
	if (!registered) throw new Error("command was not registered");
	return registered;
}

/** The command is registered with `checkCallback` (not `editorCheckCallback`), so it is offered
 * with no editor involved at all: this calls it exactly as Obsidian does, `(checking)`. */
function check(command: Command, checking: boolean): boolean | void {
	expect(command.editorCheckCallback).toBeUndefined();
	expect(command.editorCallback).toBeUndefined();
	expect(command.callback).toBeUndefined();
	return command.checkCallback?.(checking);
}

function markdownView(path: string, mode: "source" | "preview"): InstanceType<typeof MockMarkdownView> {
	const view = new MockMarkdownView();
	view.file = new MockTFile(path);
	view.mode = mode;
	return view;
}

/** Hand-written fold payload: valid `Anchor` shape, so it survives a load round trip too. */
const ANCHOR = { kind: "heading", indent: 0, text: "lesson 8", siblingIndex: 0, parentChain: [] };

function embed(host: string, target: string, subpath = "", occurrence = 0): EmbedFoldRecord {
	return { host, target, subpath, occurrence, contentHash: "h", folds: [ANCHOR], dormant: [] };
}

describe("forget-note-folds command: visibility (checkCallback)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("has the right id and an unprefixed name", () => {
		const command = getCommand(makePlugin());
		expect(command.id).toBe(FORGET_NOTE_FOLDS_COMMAND_ID);
		expect(command.id).toBe("forget-note-folds");
		expect(command.name).toBe("Forget stored folds for this note");
		expect(command.name.toLowerCase()).not.toContain("persistent folded state");
	});

	it("is visible (checking=true -> true) with a Markdown editor active", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		const command = getCommand(plugin);

		const view = new MockMarkdownView();
		view.file = new MockTFile("Tasks.md");
		setActiveView(plugin, view);

		expect(check(command, true)).toBe(true);
	});

	it.each([
		{ label: "Source mode", mode: "source" as const },
		{ label: "Live Preview (also reported as source by getMode)", mode: "source" as const },
		{ label: "Reading view", mode: "preview" as const },
	])("is visible for a Markdown view in $label", async ({ mode }) => {
		const plugin = makePlugin();
		await plugin.onload();
		const command = getCommand(plugin);

		const view = markdownView("Tasks.md", mode);
		expect(view.getMode()).toBe(mode);
		setActiveView(plugin, view);

		expect(check(command, true)).toBe(true);
	});

	it("is hidden (checking=true -> false) for a canvas/image/other non-editor view", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		const command = getCommand(plugin);

		setActiveView(plugin, new OtherView());

		expect(check(command, true)).toBe(false);
	});

	it("is hidden for the settings pane or an empty tab (no active view at all)", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		const command = getCommand(plugin);

		setActiveView(plugin, null);

		expect(check(command, true)).toBe(false);
	});

	it("is hidden for a Markdown view with no backing file", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		const command = getCommand(plugin);

		setActiveView(plugin, new MockMarkdownView()); // file is null

		expect(check(command, true)).toBe(false);
	});
});

describe("forget-note-folds command: running it (checkCallback with checking=false)", () => {
	it("removes only the active note's record, flushes, and shows a Notice", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		plugin.store.set("Tasks.md", { contentHash: "abc", folds: [{ kind: "heading" }], dormant: [] });
		plugin.store.set("Other.md", { contentHash: "def", folds: [], dormant: [] });
		const command = getCommand(plugin);

		const view = new MockMarkdownView();
		view.file = new MockTFile("Tasks.md");
		setActiveView(plugin, view);

		const notices = collectNotices();
		const result = check(command, false);

		expect(result).toBe(true);
		expect(plugin.store.get("Tasks.md")).toBeUndefined();
		expect(plugin.store.get("Other.md")).toEqual({ contentHash: "def", folds: [], dormant: [] });
		expect(notices.messages).toEqual(['Forgot stored folds for "Tasks".']);
		notices.stop();

		await vi.waitFor(async () => {
			const saved = (await plugin.loadData()) as { files: Record<string, unknown> };
			expect(Object.keys(saved.files)).toEqual(["Other.md"]);
		});
	});

	it("with no record stored for the note, is a no-op and shows a Notice saying so, and writes nothing", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		const command = getCommand(plugin);

		const view = new MockMarkdownView();
		view.file = new MockTFile("Untouched.md");
		setActiveView(plugin, view);

		const notices = collectNotices();
		const result = check(command, false);

		expect(result).toBe(true);
		expect(notices.messages).toEqual(['No stored folds were kept for "Untouched".']);
		notices.stop();

		const saved = await plugin.loadData();
		expect(saved).toBeNull(); // nothing changed, so nothing was written
	});

	it("never mutates the editor: the command only touches stored state", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		plugin.store.set("Tasks.md", { contentHash: "abc", folds: [{ kind: "heading" }], dormant: [] });
		const command = getCommand(plugin);

		const view = new MockMarkdownView();
		view.file = new MockTFile("Tasks.md");
		setActiveView(plugin, view);

		// The mock MarkdownView exposes no editor/fold API at all; running the command without
		// throwing demonstrates it never reaches for one to fold/unfold the open editor.
		expect(() => check(command, false)).not.toThrow();
	});
});

describe("forget-note-folds command: hosted embeds (G15)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	/** Two notes, five embed records: two hosts, one target embedded by both. */
	async function seeded(): Promise<{ plugin: PersistentFoldedStatePlugin; command: Command }> {
		const plugin = makePlugin();
		await plugin.onload();
		plugin.store.set("Host A.md", { contentHash: "a", folds: [ANCHOR], dormant: [] });
		plugin.store.set("Host B.md", { contentHash: "b", folds: [ANCHOR], dormant: [] });
		plugin.store.setEmbed(embed("Host A.md", "Source.md", "^abc", 0));
		plugin.store.setEmbed(embed("Host A.md", "Source.md", "^abc", 1));
		plugin.store.setEmbed(embed("Host A.md", "Other.md", "Heading", 0));
		plugin.store.setEmbed(embed("Host B.md", "Source.md", "^abc", 0));
		plugin.store.setEmbed(embed("Host B.md", "Host A.md", "", 0)); // Host A is only the target here
		await plugin.store.flush();
		return { plugin, command: getCommand(plugin) };
	}

	it.each(["source", "preview"] as const)(
		"from a %s view: clears the note's record and the embeds it hosts, and nothing else",
		async (mode) => {
			const { plugin, command } = await seeded();
			setActiveView(plugin, markdownView("Host A.md", mode));

			const notices = collectNotices();
			expect(check(command, false)).toBe(true);
			notices.stop();

			expect(plugin.store.get("Host A.md")).toBeUndefined();
			expect(plugin.store.get("Host B.md")).toBeDefined();
			expect(plugin.store.embedRecords().map((r) => [r.host, r.target, r.subpath, r.occurrence])).toEqual([
				["Host B.md", "Source.md", "^abc", 0],
				["Host B.md", "Host A.md", "", 0],
			]);
			expect(notices.messages).toEqual(['Forgot stored folds for "Host A" and 3 embeds in it.']);

			await vi.waitFor(async () => {
				const saved = (await plugin.loadData()) as { files: Record<string, unknown>; embeds: { host: string }[] };
				expect(Object.keys(saved.files)).toEqual(["Host B.md"]);
				expect(saved.embeds.map((r) => r.host)).toEqual(["Host B.md", "Host B.md"]);
			});
		}
	);

	it("writes once, immediately, for the note record and its embeds together", async () => {
		const { plugin, command } = await seeded();
		const saveData = vi.spyOn(plugin, "saveData");
		setActiveView(plugin, markdownView("Host A.md", "preview"));

		vi.useFakeTimers(); // a 150ms debounce could never fire here: only an immediate flush writes
		try {
			check(command, false);
			await vi.advanceTimersByTimeAsync(0);
			expect(saveData).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(500);
		} finally {
			vi.useRealTimers();
		}
		await plugin.store.flush(); // drains the chain; a second write here would be a bug
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("clears embeds only: the other direction (a note that is only a target) is untouched", async () => {
		const { plugin, command } = await seeded();
		// Source.md is the *target* of three embeds but hosts none and has no record.
		setActiveView(plugin, markdownView("Source.md", "preview"));

		const notices = collectNotices();
		check(command, false);
		notices.stop();

		expect(plugin.store.embedSize).toBe(5);
		expect(plugin.store.size).toBe(2);
		expect(notices.messages).toEqual(['No stored folds were kept for "Source".']);
	});

	it("a host with embeds but no note record still reports the embeds", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		plugin.store.setEmbed(embed("Only Embeds.md", "Source.md", "", 0));
		const command = getCommand(plugin);
		setActiveView(plugin, markdownView("Only Embeds.md", "preview"));

		const notices = collectNotices();
		check(command, false);
		notices.stop();

		expect(notices.messages).toEqual(['Forgot stored folds for "Only Embeds" and 1 embed in it.']);
		expect(plugin.store.embedSize).toBe(0);
	});

	it("with neither a note record nor an embed record, says nothing was kept and writes nothing", async () => {
		const { plugin, command } = await seeded();
		const saveData = vi.spyOn(plugin, "saveData");
		setActiveView(plugin, markdownView("Never Folded.md", "preview"));

		const notices = collectNotices();
		check(command, false);
		notices.stop();
		await plugin.store.flush();

		expect(notices.messages).toEqual(['No stored folds were kept for "Never Folded".']);
		expect(saveData).not.toHaveBeenCalled();
	});

	it("never reaches for the editor: a view with an editor that throws on any use still works", async () => {
		const { plugin, command } = await seeded();
		const view = markdownView("Host A.md", "preview");
		view.editor = new Proxy(new MockEditor(), {
			get(_target, prop) {
				throw new Error(`editor.${String(prop)} must not be touched`);
			},
		});
		setActiveView(plugin, view);

		expect(() => check(command, false)).not.toThrow();
		expect(plugin.store.get("Host A.md")).toBeUndefined();
	});
});
