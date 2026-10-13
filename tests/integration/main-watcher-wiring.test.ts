/**
 * R3: the "settled non-user change" event (deliverable (1)) must be observable on the real
 * plugin, not just inside the editor watcher's own unit tests. `src/main.ts` wires
 * `createEditorWatcher`'s `onSettledNonUserChange` callback to `plugin.events.trigger(...)`
 * (`SETTLED_NON_USER_CHANGE_EVENT`) — this test exercises that real wiring end to end: it calls
 * `plugin.onload()`, captures the exact extension `registerEditorExtension` was given (the mock
 * `Plugin.registerEditorExtension` is a no-op, so nothing short of capturing and using it for
 * real would exercise anything), builds a real `EditorState`/`EditorView` from that extension,
 * dispatches a non-user transaction through it, and asserts a listener on `plugin.events`
 * actually fires. Nothing here is a mocked setter or a faked input: the only thing the mock
 * stands in for is Obsidian's own plumbing of "apply this extension to the real editor", which
 * this test performs itself instead.
 */
import { describe, expect, it, vi } from "vitest";
import { App, type PluginManifest } from "obsidian";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import PersistentFoldedStatePlugin, { SETTLED_NON_USER_CHANGE_EVENT } from "../../src/main";

const manifest: PluginManifest = {
	id: "persistent-folded-state",
	name: "Persistent Folded State",
	version: "0.1.0",
	minAppVersion: "1.13.0",
	description: "test",
	author: "Dan Fletcher",
	isDesktopOnly: false,
};

describe("R3: plugin.events exposes the settled-non-user-change event for real", () => {
	it("a settled non-user change dispatched through the registered extension fires plugin.events", async () => {
		vi.useFakeTimers();
		const plugin = new PersistentFoldedStatePlugin(new App(), manifest);
		const registerEditorExtension = vi.spyOn(plugin, "registerEditorExtension");

		await plugin.onload();
		expect(registerEditorExtension).toHaveBeenCalledTimes(1);
		const watcherExtension = registerEditorExtension.mock.calls[0][0];

		const listener = vi.fn();
		plugin.events.on(SETTLED_NON_USER_CHANGE_EVENT, listener);

		const view = new EditorView({
			state: EditorState.create({
				doc: "# Heading\nbody",
				extensions: [
					codeFolding(),
					watcherExtension as never,
					editorInfoField.init(() => ({ file: { path: "Tasks.md", extension: "md" } })),
				],
			}),
			parent: document.body,
		});

		// A document-changing transaction with no userEvent annotation: the reload shape (E9/E10).
		view.dispatch({ changes: { from: 0, to: 0, insert: "injected externally" } });
		expect(listener).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(150);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith("Tasks.md", view.state.doc.toString());

		view.destroy();
		document.body.replaceChildren();
		vi.useRealTimers();
	});
});
