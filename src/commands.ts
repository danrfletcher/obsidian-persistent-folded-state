/**
 * G12/G15's command palette entry: "Forget stored folds for this note". Registered with
 * `checkCallback` (not `editorCheckCallback`, which Obsidian only offers while an editor has
 * focus) so it is also available from a Reading view host. The visibility check is explicit and
 * testable on its own: a canvas, an image, the settings pane or an empty tab have no active
 * `MarkdownView`, so `getActiveViewOfType` returning null is enough to hide the command, while a
 * Markdown view in Source mode, Live Preview or Reading view all pass. Running it clears the
 * note's own record and every embed record the note hosts (records where it is only the embed
 * *target* are other notes' state and stay), and touches nothing on screen.
 */
import { MarkdownView, Notice } from "obsidian";
import type PersistentFoldedStatePlugin from "./main";

export const FORGET_NOTE_FOLDS_COMMAND_ID = "forget-note-folds";

function countEmbeds(count: number): string {
	return count === 1 ? "1 embed" : `${count} embeds`;
}

export function registerForgetNoteFoldsCommand(plugin: PersistentFoldedStatePlugin): void {
	plugin.addCommand({
		id: FORGET_NOTE_FOLDS_COMMAND_ID,
		// No plugin-name prefix: Obsidian's command palette no longer displays one, and the
		// command id is already namespaced by the plugin id automatically.
		name: "Forget stored folds for this note",
		checkCallback: (checking: boolean): boolean => {
			const view = plugin.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view || !view.file) return false;
			if (checking) return true;

			const file = view.file;
			const { note, embeds } = plugin.store.forgetNote(file.path);
			if (!note && embeds === 0) {
				new Notice(`No stored folds were kept for "${file.basename}".`);
			} else if (embeds === 0) {
				new Notice(`Forgot stored folds for "${file.basename}".`);
			} else {
				new Notice(`Forgot stored folds for "${file.basename}" and ${countEmbeds(embeds)} in it.`);
			}
			return true;
		},
	});
}
