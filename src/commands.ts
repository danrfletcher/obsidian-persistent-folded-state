/**
 * G12's command palette entry: "Forget stored folds for this note". Registered with
 * `editorCheckCallback` (not `editorCallback`) so the visibility check is explicit and testable
 * on its own, rather than relying on however Obsidian's own editor-command gating happens to
 * behave for a canvas, an image, the settings pane or an empty tab — all of which simply have no
 * active `MarkdownView`, so `getActiveViewOfType` returning null is enough to hide the command.
 */
import { MarkdownView, Notice } from "obsidian";
import type PersistentFoldedStatePlugin from "./main";

export const FORGET_NOTE_FOLDS_COMMAND_ID = "forget-note-folds";

export function registerForgetNoteFoldsCommand(plugin: PersistentFoldedStatePlugin): void {
	plugin.addCommand({
		id: FORGET_NOTE_FOLDS_COMMAND_ID,
		// No plugin-name prefix: Obsidian's command palette no longer displays one, and the
		// command id is already namespaced by the plugin id automatically.
		name: "Forget stored folds for this note",
		editorCheckCallback: (checking: boolean): boolean => {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view || !view.file) return false;
			if (checking) return true;

			const file = view.file;
			const removed = plugin.store.forget(file.path);
			new Notice(
				removed
					? `Forgot stored folds for "${file.basename}".`
					: `No stored folds were kept for "${file.basename}".`
			);
			return true;
		},
	});
}
