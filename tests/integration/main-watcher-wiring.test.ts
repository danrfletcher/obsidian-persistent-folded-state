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
import { EditorState, Transaction } from "@codemirror/state";
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

	it("T1/T4: a userEvent:\"set\" transaction (Obsidian's real external-reload shape) also fires the settled event", async () => {
		// Live-confirmed in the container (docs/reload-shape.md): an external write to the note
		// on disk makes Obsidian dispatch a transaction annotated userEvent:"set", not a bare
		// un-annotated one. Before this fix the classifier treated any annotation as "user" and
		// the settled event never fired on a real external write (T1/T4). This drives the exact
		// shape through the real plugin wiring end to end.
		vi.useFakeTimers();
		const plugin = new PersistentFoldedStatePlugin(new App(), manifest);
		const registerEditorExtension = vi.spyOn(plugin, "registerEditorExtension");

		await plugin.onload();
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

		view.dispatch({
			changes: { from: 0, to: 0, insert: "<!-- external write -->\n" },
			annotations: Transaction.userEvent.of("set"),
		});
		expect(listener).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(150);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener).toHaveBeenCalledWith("Tasks.md", view.state.doc.toString());

		view.destroy();
		document.body.replaceChildren();
		vi.useRealTimers();
	});

	it(
		"T2: onload() calls Workspace.updateOptions() after registering, so a pane already open " +
			"across a disable/re-enable cycle is reconfigured onto the fresh store rather than " +
			"left running the stale extension from before the disable",
		async () => {
			const app = new App();
			const plugin = new PersistentFoldedStatePlugin(app, manifest);
			const registerEditorExtension = vi.spyOn(plugin, "registerEditorExtension");
			const updateOptions = vi.spyOn(app.workspace, "updateOptions");

			// First enable.
			await plugin.onload();
			expect(updateOptions).toHaveBeenCalledTimes(1);
			const extensionBeforeDisable = registerEditorExtension.mock.calls[0][0];
			const storeBeforeDisable = plugin.store;

			// Disable, then re-enable — the same plugin object, the same already-open pane's
			// extension (`extensionBeforeDisable`) is what real Obsidian would need to swap out
			// for `app.workspace.updateOptions()` to have any effect on that pane.
			plugin.unload();
			await plugin.onload();
			expect(updateOptions).toHaveBeenCalledTimes(2); // called again on re-enable, not just once ever
			const extensionAfterReenable = registerEditorExtension.mock.calls[1][0];
			expect(extensionAfterReenable).not.toBe(extensionBeforeDisable); // a genuinely fresh extension
			expect(plugin.store).not.toBe(storeBeforeDisable); // and a genuinely fresh store

			// Simulate what calling `updateOptions()` is documented to cause: Obsidian swaps the
			// already-open pane from `extensionBeforeDisable` onto `extensionAfterReenable`. A
			// settled non-user change through that reconfigured pane must land in the plugin's
			// *current* store, not the one the stale pre-disable extension closed over.
			vi.useFakeTimers();
			const view = new EditorView({
				state: EditorState.create({
					doc: "# Heading\nbody",
					extensions: [
						codeFolding(),
						extensionAfterReenable as never,
						editorInfoField.init(() => ({ file: { path: "Tasks.md", extension: "md" } })),
					],
				}),
				parent: document.body,
			});
			view.dispatch({
				changes: { from: 0, to: 0, insert: "<!-- external write after re-enable -->\n" },
				annotations: Transaction.userEvent.of("set"),
			});
			await vi.advanceTimersByTimeAsync(150);

			expect(plugin.store.get("Tasks.md")).toBeDefined(); // the fresh store saw the change
			expect(storeBeforeDisable.get("Tasks.md")).toBeUndefined(); // the orphaned old store never does

			view.destroy();
			document.body.replaceChildren();
			vi.useRealTimers();
		},
	);
});
