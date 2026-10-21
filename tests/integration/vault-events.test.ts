/**
 * PR-7 (G9/G10): fake `rename` and `delete` vault events driven through the real plugin wiring
 * (`app.vault.trigger(...)`, not a direct `FoldStore.handleRename`/`handleDelete` call), with
 * fake timers, asserting the saved `data.json` content. `FoldStore.handleRename`/`handleDelete`
 * flush at once (not after the usual 150ms debounce) — this file proves that against the real
 * `Plugin`/`Vault` wiring, including the "rename arriving while a debounced flush is pending"
 * case, not just the pure re-key/removal rules already covered by
 * `tests/unit/vault-lifecycle.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type PluginManifest } from "obsidian";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges } from "@codemirror/language";
import { TFile as MockTFile, Vault as MockVault, Workspace as MockWorkspace, editorInfoField } from "../mocks/obsidian";
import PersistentFoldedStatePlugin from "../../src/main";

function setExists(app: App, path: string): void {
	(app.vault as unknown as MockVault).setExists(path);
}

function triggerRename(app: App, newPath: string, oldPath: string): void {
	(app.vault as unknown as MockVault).trigger("rename", new MockTFile(newPath), oldPath);
}

function triggerDelete(app: App, path: string): void {
	(app.vault as unknown as MockVault).trigger("delete", new MockTFile(path));
}

const manifest: PluginManifest = {
	id: "persistent-folded-state",
	name: "Persistent Folded State",
	version: "0.1.0",
	minAppVersion: "1.13.0",
	description: "test",
	author: "Dan Fletcher",
	isDesktopOnly: false,
};

function makePlugin(app: App, stored: { value: unknown }): PersistentFoldedStatePlugin {
	const plugin = new PersistentFoldedStatePlugin(app, manifest);
	plugin.loadData = async () => stored.value;
	plugin.saveData = async (data: unknown) => {
		stored.value = data;
	};
	return plugin;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("vault-events: rename (G9)", () => {
	it("re-keys the stored entry to the new path and persists it, in the same folder", async () => {
		const app = new App();
		const stored = {
			value: {
				version: 1,
				files: { "Projects/Quarry/Tasks.md": { contentHash: "abc", folds: [], dormant: [] } },
			},
		};
		setExists(app, "Projects/Quarry/Tasks.md");
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		triggerRename(app, "Projects/Quarry/Tasks Q4.md", "Projects/Quarry/Tasks.md");
		await plugin.store.flush();

		expect(stored.value).toEqual({
			version: 1,
			files: { "Projects/Quarry/Tasks Q4.md": { contentHash: "abc", folds: [], dormant: [] } },
		});
	});

	it("re-keys every stored note beneath a renamed/moved folder", async () => {
		const app = new App();
		const stored = {
			value: {
				version: 1,
				files: {
					"Projects/Quarry/Tasks.md": { contentHash: "a", folds: [], dormant: [] },
					"Projects/Quarry/Sub/Notes.md": { contentHash: "b", folds: [], dormant: [] },
					"Other.md": { contentHash: "c", folds: [], dormant: [] },
				},
			},
		};
		for (const path of Object.keys((stored.value as { files: Record<string, unknown> }).files)) setExists(app, path);
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		triggerRename(app, "Archive/Quarry", "Projects/Quarry");
		await plugin.store.flush();

		const files = (stored.value as { files: Record<string, unknown> }).files;
		expect(Object.keys(files).sort()).toEqual(["Archive/Quarry/Sub/Notes.md", "Archive/Quarry/Tasks.md", "Other.md"]);
	});

	it("a rename onto a path that already has a stored entry replaces that entry, and the old key no longer exists", async () => {
		const app = new App();
		const stored = {
			value: {
				version: 1,
				files: {
					"A.md": { contentHash: "a-hash", folds: [], dormant: [] },
					"B.md": { contentHash: "b-hash", folds: [], dormant: [] },
				},
			},
		};
		setExists(app, "A.md");
		setExists(app, "B.md");
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		triggerRename(app, "B.md", "A.md");
		await plugin.store.flush();

		expect(stored.value).toEqual({ version: 1, files: { "B.md": { contentHash: "a-hash", folds: [], dormant: [] } } });
	});

	it("a rename of a path with no stored entry does nothing and does not throw, or write", async () => {
		const app = new App();
		const stored = { value: { version: 1, files: { "Other.md": { contentHash: "x", folds: [], dormant: [] } } } };
		setExists(app, "Other.md");
		const plugin = makePlugin(app, stored);
		await plugin.onload();
		const saveData = vi.spyOn(plugin, "saveData");

		expect(() => triggerRename(app, "Elsewhere.md", "Missing.md")).not.toThrow();
		await plugin.store.flush();
		expect(saveData).not.toHaveBeenCalled();
	});

	it("a rename arriving while a debounced flush is pending: no write lands under the old key afterwards", async () => {
		vi.useFakeTimers();
		const app = new App();
		setExists(app, "A.md");
		const stored = { value: null as unknown };
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		// Schedules the ordinary 150ms debounced flush (FoldStore.set), still pending.
		plugin.store.set("A.md", { contentHash: "fresh", folds: [], dormant: [] });
		expect(stored.value).toBeNull(); // not written yet

		// The rename arrives before that timer fires, and flushes at once.
		triggerRename(app, "B.md", "A.md");
		await plugin.store.flush();
		expect(stored.value).toEqual({ version: 1, files: { "B.md": { contentHash: "fresh", folds: [], dormant: [] } } });

		// Letting the original (now-cancelled) debounce timer's moment pass must not revive "A.md"
		// or otherwise change what's on disk.
		await vi.advanceTimersByTimeAsync(200);
		expect(stored.value).toEqual({ version: 1, files: { "B.md": { contentHash: "fresh", folds: [], dormant: [] } } });
	});

	it(
		"R2: a rename arriving while a settle timer is pending for the old path leaves no entry " +
			"under the old key once that timer fires",
		async () => {
			vi.useFakeTimers();
			const app = new App();
			setExists(app, "A.md");
			const stored = {
				value: { version: 1, files: { "A.md": { contentHash: "unrelated", folds: [], dormant: [] } } } as unknown,
			};
			const plugin = makePlugin(app, stored);
			const registerEditorExtension = vi.spyOn(plugin, "registerEditorExtension");
			await plugin.onload();
			const watcherExtension = registerEditorExtension.mock.calls[0][0];

			// Real Obsidian mutates a renamed file's own TFile.path in place, so a pane already
			// showing it reflects the rename immediately too — modelled here as a mutable file
			// reference the mock editorInfoField reads (the same object every read), rather than
			// a fresh object computed from a plain variable each time.
			const fileRef = { path: "A.md", extension: "md" };
			const view = new EditorView({
				state: EditorState.create({
					doc: "line one\nline two",
					extensions: [codeFolding(), watcherExtension as never, editorInfoField.init(() => ({ file: fileRef }))],
				}),
				parent: document.body,
			});

			// A settled non-user change starts the 150ms settle timer for "A.md" (src/editor-watcher.ts).
			view.dispatch({ changes: { from: 0, to: 0, insert: "x" }, annotations: Transaction.userEvent.of("set") });

			// The rename arrives before that timer fires.
			fileRef.path = "B.md";
			triggerRename(app, "B.md", "A.md");
			await plugin.store.flush();
			expect(stored.value).toEqual({ version: 1, files: { "B.md": { contentHash: "unrelated", folds: [], dormant: [] } } });

			// Letting the settle timer (and whatever debounce it might otherwise schedule) elapse
			// must never land a fresh write under the stale "A.md" key (src/fold-restorer.ts's
			// own E5/G15 "no entry" baseline branch would otherwise do exactly that).
			await vi.advanceTimersByTimeAsync(500);
			await plugin.store.flush();

			const files = (stored.value as { files: Record<string, unknown> }).files;
			expect(files["A.md"]).toBeUndefined();
			expect(Object.keys(files)).toEqual(["B.md"]);

			view.destroy();
			document.body.replaceChildren();
			vi.useRealTimers();
		},
	);
});

describe("vault-events: rename inside a settle window (R7, PR-7)", () => {
	it("re-targets the pending restore to the renamed path: the stored fold is applied and kept under the new key", async () => {
		vi.useFakeTimers();
		const app = new App();
		setExists(app, "A.md");
		const stored = {
			value: {
				version: 1,
				files: {
					"A.md": {
						contentHash: "stale",
						folds: [{ kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] }],
						dormant: [],
					},
				},
			} as unknown,
		};
		const plugin = makePlugin(app, stored);
		const registerEditorExtension = vi.spyOn(plugin, "registerEditorExtension");
		await plugin.onload();
		const watcherExtension = registerEditorExtension.mock.calls[0][0];

		const fileRef = { path: "A.md", extension: "md" };
		const view = new EditorView({
			state: EditorState.create({
				doc: "# Tuesday\nbody\n# Wednesday\nother",
				extensions: [codeFolding(), watcherExtension as never, editorInfoField.init(() => ({ file: fileRef }))],
			}),
			parent: document.body,
		});

		// An external rewrite (Obsidian's reload shape: userEvent "set") starts the 150ms settle for "A.md".
		view.dispatch({
			changes: { from: view.state.doc.length, insert: " more" },
			annotations: Transaction.userEvent.of("set"),
		});
		expect(foldedRanges(view.state).size).toBe(0);

		// The rename lands before the timer fires; the pane now shows the same text under "B.md".
		fileRef.path = "B.md";
		triggerRename(app, "B.md", "A.md");
		await vi.advanceTimersByTimeAsync(500);
		await plugin.store.flush();

		// The restore ran for B.md: the heading is folded (it used to be dropped, leaving the note unfolded).
		const folded: [number, number][] = [];
		foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => void folded.push([from, to]));
		expect(folded).toEqual([[9, 14]]); // end of "# Tuesday" .. end of "body"

		const files = (stored.value as { files: Record<string, { contentHash: string; folds: unknown[] }> }).files;
		expect(Object.keys(files)).toEqual(["B.md"]);
		expect(files["B.md"].folds).toHaveLength(1);
		expect(files["B.md"].contentHash).not.toBe("stale"); // refreshed against the new text

		view.destroy();
		document.body.replaceChildren();
	});

	it("still drops the pending restore when the pane moved to a different file (different text)", async () => {
		vi.useFakeTimers();
		const app = new App();
		setExists(app, "A.md");
		const stored = {
			value: {
				version: 1,
				files: {
					"A.md": {
						contentHash: "stale",
						folds: [{ kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] }],
						dormant: [],
					},
				},
			} as unknown,
		};
		const plugin = makePlugin(app, stored);
		const registerEditorExtension = vi.spyOn(plugin, "registerEditorExtension");
		await plugin.onload();
		const watcherExtension = registerEditorExtension.mock.calls[0][0];

		const fileRef = { path: "A.md", extension: "md" };
		const view = new EditorView({
			state: EditorState.create({
				doc: "# Tuesday\nbody\n# Wednesday\nother",
				extensions: [codeFolding(), watcherExtension as never, editorInfoField.init(() => ({ file: fileRef }))],
			}),
			parent: document.body,
		});
		view.dispatch({
			changes: { from: view.state.doc.length, insert: " more" },
			annotations: Transaction.userEvent.of("set"),
		});

		// The pane switches to another file: same view, different path, and its text changed too.
		fileRef.path = "C.md";
		// (userEvent "input": an un-annotated replace would itself be a new non-user change and
		// start its own settle for C.md, which is not what is under test.)
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: "# Elsewhere\nx" },
			annotations: Transaction.userEvent.of("input"),
		});
		await vi.advanceTimersByTimeAsync(500);
		await plugin.store.flush();

		expect(foldedRanges(view.state).size).toBe(0);
		const files = (stored.value as { files: Record<string, unknown> }).files;
		expect(Object.keys(files)).toEqual(["A.md"]); // nothing invented for C.md

		view.destroy();
		document.body.replaceChildren();
	});
});

describe("vault-events: delete (G10)", () => {
	it("removes the stored folds, dormant folds and content hash for a deleted file", async () => {
		const app = new App();
		const stored = {
			value: {
				version: 1,
				files: {
					"A.md": {
						contentHash: "abc",
						folds: [{ kind: "heading", indent: 0, text: "x", siblingIndex: 0, parentChain: [] }],
						dormant: [{ kind: "heading", indent: 0, text: "y", siblingIndex: 0, parentChain: [] }],
					},
				},
			},
		};
		setExists(app, "A.md");
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		triggerDelete(app, "A.md");
		await plugin.store.flush();

		expect(stored.value).toEqual({ version: 1, files: {} });
	});

	it("deleting a folder removes the stored folds of every note beneath it", async () => {
		const app = new App();
		const stored = {
			value: {
				version: 1,
				files: {
					"Projects/Quarry/Tasks.md": { contentHash: "a", folds: [], dormant: [] },
					"Projects/Quarry/Sub/Notes.md": { contentHash: "b", folds: [], dormant: [] },
					"Other.md": { contentHash: "c", folds: [], dormant: [] },
				},
			},
		};
		for (const path of Object.keys((stored.value as { files: Record<string, unknown> }).files)) setExists(app, path);
		const plugin = makePlugin(app, stored);
		await plugin.onload();

		triggerDelete(app, "Projects/Quarry");
		await plugin.store.flush();

		expect(stored.value).toEqual({ version: 1, files: { "Other.md": { contentHash: "c", folds: [], dormant: [] } } });
	});

	it("a delete of a path with no stored entry does nothing and does not throw, or write", async () => {
		const app = new App();
		const stored = { value: { version: 1, files: { "Other.md": { contentHash: "x", folds: [], dormant: [] } } } };
		setExists(app, "Other.md");
		const plugin = makePlugin(app, stored);
		await plugin.onload();
		const saveData = vi.spyOn(plugin, "saveData");

		expect(() => triggerDelete(app, "Missing.md")).not.toThrow();
		await plugin.store.flush();
		expect(saveData).not.toHaveBeenCalled();
	});
});

describe('vault-events: prune at load (G9, "renamed outside Obsidian: not in v1")', () => {
	it("keeps entries whose files exist, removes the rest, and tolerates a missing/corrupt data.json (E8)", async () => {
		const app = new App();
		setExists(app, "Exists.md");
		// "Gone.md" is deliberately not registered as existing.
		const stored = {
			value: {
				version: 1,
				files: {
					"Exists.md": { contentHash: "a", folds: [], dormant: [] },
					"Gone.md": { contentHash: "b", folds: [], dormant: [] },
				},
			},
		};
		const plugin = makePlugin(app, stored);
		await plugin.onload();
		(app.workspace as unknown as MockWorkspace).triggerLayoutReady();
		await plugin.store.flush();

		expect(plugin.store.get("Exists.md")).toBeDefined();
		expect(plugin.store.get("Gone.md")).toBeUndefined();
		expect(stored.value).toEqual({ version: 1, files: { "Exists.md": { contentHash: "a", folds: [], dormant: [] } } });
	});

	it("a missing data.json still loads and onloads without throwing", async () => {
		const app = new App();
		const stored = { value: null as unknown };
		const plugin = makePlugin(app, stored);
		await expect(plugin.onload()).resolves.toBeUndefined();
		(app.workspace as unknown as MockWorkspace).triggerLayoutReady();
		await plugin.store.flush();
		expect(plugin.store.size).toBe(0);
	});

	it("a corrupt (rejecting) loadData still onloads without throwing, and prune is a no-op", async () => {
		const app = new App();
		const plugin = new PersistentFoldedStatePlugin(app, manifest);
		plugin.loadData = async () => {
			throw new SyntaxError("Unexpected end of JSON input");
		};
		plugin.saveData = async () => undefined;
		await expect(plugin.onload()).resolves.toBeUndefined();
		(app.workspace as unknown as MockWorkspace).triggerLayoutReady();
		await plugin.store.flush();
		expect(plugin.store.size).toBe(0);
	});

	it("R1: does not run, and removes nothing, before layout is ready", async () => {
		const app = new App();
		setExists(app, "Exists.md");
		// "Gone.md" is deliberately not registered as existing — at the real moment this matters
		// (onload, before Obsidian's own startup has finished populating the vault's file tree),
		// `getAbstractFileByPath` would return null for "Exists.md" too, not just "Gone.md"; this
		// mock's `setExists` state is unaffected by layout readiness, so this test instead proves
		// the narrower, directly observable claim: pruning simply hasn't run yet at all.
		const stored: { value: unknown } = {
			value: {
				version: 1,
				files: {
					"Exists.md": { contentHash: "a", folds: [], dormant: [] },
					"Gone.md": { contentHash: "b", folds: [], dormant: [] },
				},
			},
		};
		const saveData = vi.fn(async (data: unknown) => {
			stored.value = data;
		});
		const plugin = makePlugin(app, stored);
		plugin.saveData = saveData;
		await plugin.onload();

		// Layout is not yet ready: pruneOrphans must not have run (and so must not have written
		// data.json either) — both entries are still exactly as they were loaded.
		expect(plugin.store.get("Exists.md")).toBeDefined();
		expect(plugin.store.get("Gone.md")).toBeDefined();
		expect(saveData).not.toHaveBeenCalled();

		(app.workspace as unknown as MockWorkspace).triggerLayoutReady();
		await plugin.store.flush();

		expect(plugin.store.get("Exists.md")).toBeDefined();
		expect(plugin.store.get("Gone.md")).toBeUndefined();
		expect(stored.value).toEqual({ version: 1, files: { "Exists.md": { contentHash: "a", folds: [], dormant: [] } } });
	});
});
