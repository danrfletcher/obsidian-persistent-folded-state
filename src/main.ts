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
 */
import { Events, Plugin } from "obsidian";
import { FoldStore } from "./fold-store";
import { registerForgetNoteFoldsCommand } from "./commands";
import { PersistentFoldedStateSettingTab } from "./settings-tab";
import { createEditorWatcher } from "./editor-watcher";

/** Event name for the "settled non-user change" deliverable (E9/E10), triggered on
 * `PersistentFoldedStatePlugin.events` with `(path: string, text: string)`. */
export const SETTLED_NON_USER_CHANGE_EVENT = "settled-non-user-change";

export default class PersistentFoldedStatePlugin extends Plugin {
	store!: FoldStore;
	readonly events = new Events();

	async onload(): Promise<void> {
		this.store = new FoldStore({
			loadData: () => this.loadData(),
			saveData: (data) => this.saveData(data),
		});
		await this.store.load();

		registerForgetNoteFoldsCommand(this);
		this.addSettingTab(new PersistentFoldedStateSettingTab(this.app, this));
		this.registerEditorExtension(
			createEditorWatcher({
				store: this.store,
				onSettledNonUserChange: (path, text) => this.events.trigger(SETTLED_NON_USER_CHANGE_EVENT, path, text),
			})
		);

		// E12: a mobile app kill, backgrounding the app or switching tabs can all end a session
		// without `onunload` ever running — flush at once (not after the 150ms debounce) on each.
		// `flushAtOnce` logs rather than throwing on a rejection (e.g. a full disk): the store has
		// already re-marked itself dirty so a later flush retries, and these call sites have
		// nowhere to propagate a rejection to (a DOM event handler, `onunload`).
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") this.flushAtOnce();
		});
		this.registerDomEvent(window, "pagehide", () => this.flushAtOnce());
	}

	onunload(): void {
		this.flushAtOnce();
	}

	private flushAtOnce(): void {
		this.store.flush().catch((err: unknown) => {
			console.error("persistent-folded-state: flush failed", err);
		});
	}
}
