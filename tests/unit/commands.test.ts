import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type Command, type PluginManifest } from "obsidian";
import { MarkdownView as MockMarkdownView, OtherView, TFile as MockTFile, Workspace as MockWorkspace } from "../mocks/obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import { FORGET_NOTE_FOLDS_COMMAND_ID, registerForgetNoteFoldsCommand } from "../../src/commands";
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

/** `editorCheckCallback`'s real declared signature takes `(checking, editor, ctx)`, but this
 * command's own implementation only ever reads `checking` (see the file comment in
 * `src/commands.ts`); this loosens the call so tests don't need to fabricate an `Editor`. */
function check(command: Command, checking: boolean): boolean | void {
	const callback = command.editorCheckCallback as ((checking: boolean) => boolean | void) | undefined;
	return callback?.(checking);
}

describe("forget-note-folds command: visibility (editorCheckCallback)", () => {
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

describe("forget-note-folds command: running it (editorCheckCallback with checking=false)", () => {
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
