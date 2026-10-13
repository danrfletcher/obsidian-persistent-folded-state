/**
 * G12's confirmation modal for the settings tab's "Forget all stored folds" button. Cancel,
 * Escape and clicking outside all leave the store untouched (handled by the base `Modal`); only
 * the destructive confirm button calls `onConfirm`.
 */
import { App, Modal, Setting } from "obsidian";

export class ForgetAllFoldsModal extends Modal {
	constructor(app: App, private readonly onConfirm: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Forget all stored folds?");
		contentEl.createEl("p", {
			text: "This clears every note's stored fold state on this device. It cannot be undone.",
		});
		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setDestructive()
					.setButtonText("Forget all stored folds")
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
