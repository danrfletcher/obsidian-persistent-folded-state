/**
 * PR-1: the plugin shell, the persistence layer (`FoldStore`) and a minimal UI entry (the
 * "Forget stored folds for this note" command plus the settings tab's "Forget all stored folds"
 * button) so this PR is testable on its own. Recording, the reload hook, anchors, matching and
 * restore all land in later PRs.
 *
 * PR-2 adds the editor watcher (`src/editor-watcher.ts`): a CM6 extension, registered once here
 * through `registerEditorExtension`, that records the user's own fold/unfold effects into the
 * store (G1) and classifies every other transaction as a user or non-user document change (E9).
 * At that point it never dispatched anything itself (observe-only) and never touched the vault —
 * restore was deferred to PR-5.
 *
 * R3: deliverable (1), the "settled non-user change" event, needs a subscription point a later
 * PR (and the real-Obsidian E10 probe) can actually observe from outside the editor watcher.
 * `events` is a plain Obsidian `Events` instance — the same base class `Vault`/`Workspace`/
 * `MetadataCache` already use — rather than a bespoke emitter, so `plugin.events.on(...)` behaves
 * exactly like every other Obsidian event. No command and no UI are added for it (F10); it is
 * wired to the editor watcher's `onSettledNonUserChange` callback below and nowhere else.
 *
 * PR-5: the editor watcher's own extension now also runs the restore pass on every settled
 * non-user change (src/fold-restorer.ts, driven from inside src/editor-watcher.ts) — snapshot
 * the stored anchors, match them against the settled text, dispatch tagged fold effects. That
 * restore is wired entirely inside `createEditorWatcher`'s own `ViewPlugin`, keyed off the same
 * `store` already passed in below, so nothing changes here in main.ts: no new dependency, no
 * new event, no new command (F10 still holds — the registered command list is unchanged).
 *
 * T2 (PR-6): `registerEditorExtension` only appends to this plugin's own extension array — per
 * obsidian.d.ts's own doc comment ("Once this array is modified, calling
 * Workspace.updateOptions() will apply the changes"), nothing reconfigures an *already-open*
 * pane's CM6 extensions until something calls `Workspace.updateOptions()`. Without that call, a
 * pane that was already open when the plugin was disabled keeps running the `ViewPlugin`
 * instance from before the disable — closed over the previous `onload()`'s now-orphaned
 * `FoldStore` — for the rest of the Obsidian session: it never sees the fresh store, so no
 * external change on that pane is ever recorded by the plugin the user can actually observe
 * (`this.store`) again. `onload()` calls `updateOptions()` itself, right after registering,
 * instead of assuming `registerEditorExtension` already does it.
 *
 * R14 (PR-6): `editorWatcherDisposed` is the `disposed` flag `createEditorWatcher` shares across
 * every `ViewPlugin` instance it creates (src/editor-watcher.ts). `onunload()` sets
 * `.current = true` on it, once, so any first-open-baseline grace-recheck timer still pending at
 * that moment (src/editor-watcher.ts's `scheduleFirstOpenGraceRecheck`) becomes a no-op instead
 * of writing to this now-orphaned `this.store` — guarding against the narrow case where the
 * plugin is disabled and re-enabled within that same short (~150ms) window.
 *
 * PR-7 (G9/G10): a rename/move re-keys the stored entry (and every entry nested beneath it, for
 * a folder) via `this.app.vault.on("rename", ...)`; a delete removes it (and every nested entry)
 * via `this.app.vault.on("delete", ...)`. Both call straight into `FoldStore`'s own thin
 * wrappers (`handleRename`/`handleDelete` — src/fold-store.ts), which flush at once. Registered
 * through `registerEvent` so they're automatically torn down on unload, same as every other
 * Obsidian-managed registration in this file.
 *
 * PR-7 (G9, "renamed outside Obsidian: not in v1"): there is no listener for that case — instead,
 * right after `this.store.load()`, `pruneOrphans` drops any stored entry whose file doesn't
 * exist in the vault at all (`this.app.vault.getAbstractFileByPath(path) === null`), cleaning up
 * whatever a rename, move or delete that happened outside Obsidian (or while it wasn't running)
 * left behind.
 *
 * PR-7 (G8/E4, open restore): `this.app.workspace.on("file-open", ...)` is the hook, deliberately
 * *not* the editor watcher's own `ViewPlugin` constructor (src/editor-watcher.ts) that the
 * sibling "no entry yet" baseline case (E5/G15, PR-6) already uses — unlike that case, a pane
 * can be constructed by CM6 for reasons that have nothing to do with a user opening a file (a
 * test harness building a view directly against an already-seeded store, most concretely), and
 * this feature's own full re-match-and-replace pass is too heavy-handed to run on every such
 * construction. "A file actually became the active one" is a strictly narrower, Obsidian-level
 * signal only `workspace`'s own `file-open` event carries. Resolving the live CM6 `EditorView`
 * from there has no supported public API (`MarkdownFileInfo.editor` is `obsidian.d.ts`'s
 * abstract CM5/CM6 bridge, not the view itself) — `(info.editor as unknown as { cm?: EditorView
 * }).cm` is the same undocumented-but-widely-used route the broader plugin community relies on
 * for this; flagged here as a judgement call rather than hidden. The actual decision (hash
 * compare, re-match, replace native restore) is `src/open-restore.ts`'s `restoreOnOpen`, fully
 * testable on its own against a directly constructed `EditorView` — this handler is deliberately
 * thin glue around it.
 */
import { Events, Plugin } from "obsidian";
import type { TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { FoldStore } from "./fold-store";
import { registerForgetNoteFoldsCommand } from "./commands";
import { PersistentFoldedStateSettingTab } from "./settings-tab";
import { createEditorWatcher } from "./editor-watcher";
import { restoreOnOpen } from "./open-restore";

/** Event name for the "settled non-user change" deliverable (E9/E10), triggered on
 * `PersistentFoldedStatePlugin.events` with `(path: string, text: string)`. */
export const SETTLED_NON_USER_CHANGE_EVENT = "settled-non-user-change";

export default class PersistentFoldedStatePlugin extends Plugin {
	store!: FoldStore;
	readonly events = new Events();
	/** R14: shared with every `createEditorWatcher`-created `ViewPlugin` instance; set once
	 * `onunload()` runs. See the file comment. */
	private readonly editorWatcherDisposed = { current: false };

	async onload(): Promise<void> {
		this.store = new FoldStore({
			loadData: () => this.loadData(),
			saveData: (data) => this.saveData(data),
		});
		await this.store.load();

		// G9 ("renamed outside Obsidian: not in v1"): drops any entry whose file no longer
		// exists in the vault at all — the only cleanup for a rename/move/delete that happened
		// outside Obsidian, or while it wasn't running.
		this.store.pruneOrphans((path) => this.app.vault.getAbstractFileByPath(path) !== null);

		registerForgetNoteFoldsCommand(this);
		this.addSettingTab(new PersistentFoldedStateSettingTab(this.app, this));
		this.registerEditorExtension(
			createEditorWatcher({
				store: this.store,
				onSettledNonUserChange: (path, text) => this.events.trigger(SETTLED_NON_USER_CHANGE_EVENT, path, text),
				disposed: this.editorWatcherDisposed,
			})
		);
		// T2: forces every already-open pane onto the extension just registered above (and
		// thus the fresh `this.store` it closes over) right now, rather than depending on
		// whatever else might eventually call `updateOptions()` — in particular, a pane that
		// was already open across a disable/re-enable cycle, which is otherwise never
		// reconfigured for the rest of the session (see the file comment's T2 entry).
		this.app.workspace.updateOptions();

		// E12: a mobile app kill, backgrounding the app or switching tabs can all end a session
		// without `onunload` ever running — flush at once (not after the 150ms debounce) on each.
		// `flushAtOnce` logs rather than throwing on a rejection (e.g. a full disk): the store has
		// already re-marked itself dirty so a later flush retries, and these call sites have
		// nowhere to propagate a rejection to (a DOM event handler, `onunload`).
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") this.flushAtOnce();
		});
		this.registerDomEvent(window, "pagehide", () => this.flushAtOnce());

		// G9/G10: re-key or remove the stored entry (and every entry nested beneath it, for a
		// folder) on a rename/move or delete inside Obsidian. `registerEvent` tears both down
		// automatically on unload.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.store.handleRename(oldPath, file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.store.handleDelete(file.path);
			})
		);

		// G8/E4 (open restore): thin glue — see the file comment above. The actual decision
		// lives entirely in src/open-restore.ts's restoreOnOpen.
		this.registerEvent(
			this.app.workspace.on("file-open", (file: TFile | null) => {
				if (!file) return;
				try {
					const info = this.app.workspace.activeEditor;
					if (!info || info.file?.path !== file.path) return;
					const cm = (info.editor as unknown as { cm?: EditorView } | undefined)?.cm;
					if (!cm) return;
					const text = cm.state.doc.toString();
					restoreOnOpen(cm, file.path, text, { store: this.store }).catch((err: unknown) => {
						console.error("persistent-folded-state: open restore failed", err);
					});
				} catch (err) {
					console.error("persistent-folded-state: file-open restore failed", err);
				}
			})
		);
	}

	onunload(): void {
		// R14: must run before `flushAtOnce()` can do anything async — see the file comment.
		this.editorWatcherDisposed.current = true;
		this.flushAtOnce();
	}

	private flushAtOnce(): void {
		this.store.flush().catch((err: unknown) => {
			console.error("persistent-folded-state: flush failed", err);
		});
	}
}
