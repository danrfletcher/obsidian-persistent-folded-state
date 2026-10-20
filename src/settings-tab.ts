/**
 * G12's settings tab: exactly one control (a `Setting` with one destructive button) and nothing
 * else (F7) — no other settings, headings or toggles.
 *
 * Uses the classic imperative `display()` API rather than 1.13.0's declarative
 * `getSettingDefinitions()`. For a tab this simple either would do, but `display()` matches this
 * project's established convention (see `obsidian-inline-agents`'s `AgentConsoleSettingTab`) and
 * keeps the whole tab in one place without introducing a second settings-rendering style the
 * project would need again once a later tab needs real DOM control. Trade-off, accepted: this
 * tab won't appear in Obsidian's own in-app settings search on 1.13.0+. The project's own lint
 * config disallows suppressing an `obsidianmd/*` rule with an inline eslint-disable comment
 * (eslint-comments/no-restricted-disable), so this trade-off is recorded as a file-scoped rule
 * override in `eslint.config.mjs` instead, next to this same justification.
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PersistentFoldedStatePlugin from "./main";
import { ForgetAllFoldsModal } from "./forget-modal";

export class PersistentFoldedStateSettingTab extends PluginSettingTab {
	/** Guards against a double click opening two confirmation modals at once. */
	private modalOpen = false;

	constructor(app: App, private readonly plugin: PersistentFoldedStatePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Forget all stored folds")
			.setDesc("Clears every note's stored fold state on this device. This cannot be undone.")
			.addButton((button) =>
				button
					.setButtonText("Forget all stored folds")
					.setDestructive()
					.onClick(() => {
						if (this.modalOpen) return;
						this.modalOpen = true;

						const modal = new ForgetAllFoldsModal(this.app, () => {
							const count = this.plugin.store.forgetAll();
							new Notice(count === 1 ? "Cleared stored folds for 1 note." : `Cleared stored folds for ${count} notes.`);
						});
						const originalOnClose = modal.onClose.bind(modal);
						modal.onClose = () => {
							originalOnClose();
							this.modalOpen = false;
						};
						modal.open();
					})
			);
	}
}
