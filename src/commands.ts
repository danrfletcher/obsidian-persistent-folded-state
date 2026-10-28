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
import { logLines } from "./diagnostic-log";
import type PersistentFoldedStatePlugin from "./main";

export const FORGET_NOTE_FOLDS_COMMAND_ID = "forget-note-folds";
export const COPY_DIAGNOSTIC_LOG_COMMAND_ID = "copy-diagnostic-log";

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

/** The source of the log's text: `DiagnosticLogWriter.readAll` (null when there is no file). */
export interface DiagnosticLogReader {
	readAll(): Promise<string | null>;
}

/**
 * GP6's command palette entry: "Copy diagnostic log" (ticket warkworth-46, PR-1). Copies the whole
 * `diagnostic-log.jsonl` through `navigator.clipboard.writeText` and says so in a Notice. A
 * missing or empty file copies nothing and the Notice says the log is empty. A read or clipboard
 * failure also ends in a Notice, never a throw. Always available (a plain `callback`): it needs
 * no open note.
 */
export function registerCopyDiagnosticLogCommand(plugin: PersistentFoldedStatePlugin, log: DiagnosticLogReader): void {
	const copy = async (): Promise<void> => {
		let text: string | null;
		try {
			text = await log.readAll();
		} catch {
			new Notice("Could not read the diagnostic log.");
			return;
		}
		if (text === null || text.trim() === "") {
			new Notice("The diagnostic log is empty. Nothing was copied.");
			return;
		}
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			new Notice("Could not copy the diagnostic log to the clipboard.");
			return;
		}
		const lines = logLines(text).length;
		new Notice(`Copied the diagnostic log (${lines === 1 ? "1 line" : `${lines} lines`}).`);
	};
	plugin.addCommand({
		id: COPY_DIAGNOSTIC_LOG_COMMAND_ID,
		name: "Copy diagnostic log",
		callback: () => {
			void copy();
		},
	});
}
