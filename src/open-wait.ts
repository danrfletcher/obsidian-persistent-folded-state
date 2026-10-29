/**
 * The open pass behind a wait (ticket warkworth-46, PR-2): `restoreOnOpen` runs only once the pane
 * shows the right note with its real text. `file-open` fires while a fresh pane's document is
 * still empty (the text lands about 35 ms later), so the pass used to match every stored fold
 * against `""`, set them all aside and store `hashText("")`.
 *
 * `restoreOnOpenWhenLoaded` starts a wait (src/load-wait.ts) for `(view, path)` and, when it
 * reports `ready`, calls `restoreOnOpen` with the editor's text from that moment. Every other end
 * of the wait leaves the store and the editor alone:
 * - `gave-up` (30 s) and `read-failed` write one diagnostic line each and nothing else;
 * - `cancelled` (a newer file-open for the pane, the pane closing, the plugin unloading) writes
 *   nothing at all, not even a log line.
 * A wait that finds the pane not loaded on its first look writes one `waiting` line, so the log
 * shows the gap that used to wipe the folds. All lines are `pass: "open"` with counts and lengths
 * only; the store counts are the same before and after because nothing here writes to it.
 *
 * `restoreOnOpen` itself, including the native-restore guard it starts, is unchanged: that guard
 * now starts only after the wait ends because it is called from inside `restoreOnOpen`.
 */
import type { EditorView } from "@codemirror/view";
import { diagnosticEntry, recordCounts, reportDiagnostic, type DiagnosticOutcome } from "./diagnostic-log";
import { runSerialised, type LoadWaitIo, type LoadWaitRegistry } from "./load-wait";
import { restoreOnOpen, type OpenRestoreDeps } from "./open-restore";

export interface OpenWaitDeps extends OpenRestoreDeps {
	/** The registry that keeps one live wait per pane. */
	registry: LoadWaitRegistry<EditorView>;
	/** Builds the wait's view of the outside world for this pane. */
	makeIo: (view: EditorView, path: string) => LoadWaitIo;
}

/**
 * Waits until `view` holds `path`'s real text, then runs `restoreOnOpen`. Never throws into the
 * caller's event handler path except through the returned promise, which carries `restoreOnOpen`'s
 * own failure (the caller logs it).
 */
export async function restoreOnOpenWhenLoaded(view: EditorView, path: string, deps: OpenWaitDeps): Promise<void> {
	const { store, registry } = deps;
	if (!store.get(path)) {
		// Nothing stored to restore. The pane is showing a different file now, so an earlier
		// wait for it is stale.
		registry.cancel(view);
		return;
	}

	const log = (outcome: DiagnosticOutcome, editorLen: number, diskLen: number): void => {
		const counts = recordCounts(store.get(path));
		reportDiagnostic(
			deps.diagnosticLog,
			diagnosticEntry({ path, pass: "open", outcome, editorLen, diskLen, before: counts, after: counts }),
		);
	};

	const wait = registry.start(view, path, deps.makeIo(view, path), {
		onNotLoaded: ({ editorText, diskText }) => log("waiting", editorText.length, diskText.length),
	});
	const result = await wait.done;

	switch (result.state) {
		case "ready":
			// Warkworth-46 PR-3: one pass at a time per pane. A settled pass released by the same
			// text landing waits for this one, so the two never write the store together.
			await runSerialised(view, () => restoreOnOpen(view, path, result.editorText, { ...deps, diskLen: result.diskText?.length }));
			return;
		case "gave-up":
			log("gave-up", result.editorText.length, result.diskText?.length ?? -1);
			return;
		case "read-failed":
			log("read-failed", result.editorText.length, -1);
			return;
		default:
			return; // cancelled: no pass, no store write, no log line
	}
}
