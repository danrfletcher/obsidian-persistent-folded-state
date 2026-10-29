import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type Command, type PluginManifest } from "obsidian";
import { Editor as MockEditor, MarkdownView as MockMarkdownView, OtherView, TFile as MockTFile, Workspace as MockWorkspace } from "../mocks/obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import {
	COPY_DIAGNOSTIC_LOG_COMMAND_ID,
	FORGET_NOTE_FOLDS_COMMAND_ID,
	registerCopyDiagnosticLogCommand,
	registerForgetNoteFoldsCommand,
} from "../../src/commands";
import { DiagnosticLogWriter } from "../../src/diagnostic-log-writer";
import { MemoryAdapter } from "../mocks/obsidian";
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

// --- "Copy diagnostic log" (warkworth-46 PR-1, GP6) ---------------------------------------------

describe("copy-diagnostic-log command", () => {
	const DIR = ".obsidian/plugins/persistent-folded-state";
	const LOG_PATH = `${DIR}/diagnostic-log.jsonl`;
	const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

	function setup(writeText: () => Promise<void> | void = () => undefined) {
		const writeTextMock = vi.fn<(text: string) => Promise<void> | void>(writeText);
		Object.defineProperty(navigator, "clipboard", { value: { writeText: writeTextMock }, configurable: true });
		const adapter = new MemoryAdapter();
		const writer = new DiagnosticLogWriter(adapter, DIR, { now: () => new Date("2026-10-28T10:00:00.000Z") });
		const plugin = makePlugin();
		let command: Command | undefined;
		plugin.addCommand = (c: Command) => {
			command = c;
			return c;
		};
		registerCopyDiagnosticLogCommand(plugin, writer);
		if (!command) throw new Error("command was not registered");
		return { adapter, writer, command, writeTextMock };
	}

	/** Runs the command the way Obsidian does and waits for its async body. */
	async function run(command: Command, writer: DiagnosticLogWriter): Promise<string[]> {
		const notices = collectNotices();
		command.callback?.();
		await writer.drain();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));
		notices.stop();
		return notices.messages;
	}

	afterEach(() => {
		if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
		else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
	});

	it("has the right id and name, and is a plain callback available without an open note", () => {
		const { command } = setup();
		expect(command.id).toBe(COPY_DIAGNOSTIC_LOG_COMMAND_ID);
		expect(command.id).toBe("copy-diagnostic-log");
		expect(command.name).toBe("Copy diagnostic log");
		expect(command.checkCallback).toBeUndefined();
		expect(command.editorCallback).toBeUndefined();
	});

	it("copies the whole file through navigator.clipboard.writeText and shows a Notice", async () => {
		const { adapter, writer, command, writeTextMock } = setup();
		const text = '{"line":1}\n{"line":2}\ncorrupt, kept as is\n';
		adapter.files.set(LOG_PATH, text);

		const messages = await run(command, writer);

		expect(writeTextMock).toHaveBeenCalledTimes(1);
		expect(writeTextMock).toHaveBeenCalledWith(text);
		expect(messages).toEqual(["Copied the diagnostic log (3 lines)."]);
	});

	it("copies lines queued a moment ago too: it waits for the writer's queue", async () => {
		const { writer, command, writeTextMock } = setup();
		writer.log({
			path: "Notes/Tasks.md",
			pass: "open",
			editorLen: 10,
			diskLen: -1,
			foldsBefore: 1,
			dormantBefore: 0,
			foldsAfter: 1,
			dormantAfter: 0,
			outcome: "applied",
		});

		const messages = await run(command, writer);

		const copied = writeTextMock.mock.calls[0][0] as string;
		expect(copied.trim().split("\n")).toHaveLength(1);
		expect(JSON.parse(copied)).toMatchObject({ path: "Notes/Tasks.md", pass: "open", outcome: "applied" });
		expect(messages).toEqual(["Copied the diagnostic log (1 line)."]);
	});

	it("a missing file shows the empty-log Notice and copies nothing", async () => {
		const { writer, command, writeTextMock } = setup();
		const messages = await run(command, writer);
		expect(messages).toEqual(["The diagnostic log is empty. Nothing was copied."]);
		expect(writeTextMock).not.toHaveBeenCalled();
	});

	it("an empty file shows the empty-log Notice and copies nothing", async () => {
		const { adapter, writer, command, writeTextMock } = setup();
		adapter.files.set(LOG_PATH, "");
		const messages = await run(command, writer);
		expect(messages).toEqual(["The diagnostic log is empty. Nothing was copied."]);
		expect(writeTextMock).not.toHaveBeenCalled();
	});

	it("a rejecting clipboard shows a Notice and does not throw", async () => {
		const { adapter, writer, command, writeTextMock } = setup(() => Promise.reject(new Error("denied")));
		adapter.files.set(LOG_PATH, '{"a":1}\n');
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			const messages = await run(command, writer);
			expect(writeTextMock).toHaveBeenCalledTimes(1);
			expect(messages).toEqual(["Could not copy the diagnostic log to the clipboard."]);
			expect(unhandled).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", unhandled);
		}
	});

	it("a clipboard that throws synchronously also ends in a Notice", async () => {
		const { adapter, writer, command } = setup(() => {
			throw new Error("no clipboard");
		});
		adapter.files.set(LOG_PATH, '{"a":1}\n');
		expect(await run(command, writer)).toEqual(["Could not copy the diagnostic log to the clipboard."]);
	});

	it("a file that cannot be read shows a Notice and copies nothing", async () => {
		const { adapter, writer, command, writeTextMock } = setup();
		adapter.files.set(LOG_PATH, '{"a":1}\n');
		adapter.readFailWith = new Error("EACCES");
		expect(await run(command, writer)).toEqual(["Could not read the diagnostic log."]);
		expect(writeTextMock).not.toHaveBeenCalled();
	});

	it("onload registers it through the plugin, after the forget command", async () => {
		const plugin = makePlugin();
		await plugin.onload();
		expect(plugin.diagnosticLog).not.toBeNull();
		expect((plugin as unknown as { getCommands(): Command[] }).getCommands().map((c) => c.id)).toEqual([
			FORGET_NOTE_FOLDS_COMMAND_ID,
			COPY_DIAGNOSTIC_LOG_COMMAND_ID,
		]);
		plugin.onunload();
		expect(plugin.diagnosticLog).toBeNull();
	});
});
