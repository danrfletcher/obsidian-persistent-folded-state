/**
 * PR-1: the plugin shell, the persistence layer (`FoldStore`) and a minimal UI entry (the
 * "Forget stored folds for this note" command plus the settings tab's "Forget all stored folds"
 * button) so this PR is testable on its own. Recording, the reload hook, anchors, matching and
 * restore all land in later PRs.
 *
 * PR-2 adds the editor watcher (`src/editor-watcher.ts`): a CM6 extension, registered once here
 * through `registerEditorExtension`, that records the user's own fold/unfold effects into the
 * store (G1) and classifies every other transaction as a user or non-user document change (E9).
 * It never dispatches anything itself (observe-only) and never touches the vault — restore lands
 * in PR-5.
 */
import { Plugin } from "obsidian";
import { FoldStore } from "./fold-store";
import { registerForgetNoteFoldsCommand } from "./commands";
import { PersistentFoldedStateSettingTab } from "./settings-tab";
import { createEditorWatcher } from "./editor-watcher";

export default class PersistentFoldedStatePlugin extends Plugin {
	store!: FoldStore;

	async onload(): Promise<void> {
		this.store = new FoldStore({
			loadData: () => this.loadData(),
			saveData: (data) => this.saveData(data),
		});
		await this.store.load();

		registerForgetNoteFoldsCommand(this);
		this.addSettingTab(new PersistentFoldedStateSettingTab(this.app, this));
		this.registerEditorExtension(createEditorWatcher({ store: this.store }));

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
