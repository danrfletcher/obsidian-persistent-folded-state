/**
 * Warkworth-46 PR-3: the pieces the integration tests share to run the real editor watcher behind
 * the real wait/guard (src/load-wait.ts, src/load-wait-host.ts) against the mock vault. Nothing
 * here stubs a pass: the guard reads the note through the mock vault's `adapter.read` exactly as
 * the plugin does, and the log is the real `DiagnosticLogWriter` over an in-memory adapter.
 */
import type { EditorView } from "@codemirror/view";
import type { App as ObsidianApp } from "obsidian";
import { App, MemoryAdapter, Vault as MockVault } from "./mocks/obsidian";
import { DiagnosticLogWriter } from "../src/diagnostic-log-writer";
import { DIAGNOSTIC_LOG_FIELDS, logLines } from "../src/diagnostic-log";
import { PassGate } from "../src/load-wait";
import { createLoadWaitIo } from "../src/load-wait-host";
import type { EditorWatcherDeps } from "../src/editor-watcher";

export const LOG_DIR = ".obsidian/plugins/persistent-folded-state";
export const LOG_PATH = `${LOG_DIR}/diagnostic-log.jsonl`;

export interface GuardRig {
	app: App;
	vault: MockVault;
	/** Put into `createEditorWatcher({ ... })`. */
	watcherDeps: Pick<EditorWatcherDeps, "loadGuard" | "diagnosticLog" | "window">;
	gate: PassGate<EditorView>;
	logAdapter: MemoryAdapter;
	log: DiagnosticLogWriter;
	/** Drains the writer and returns every line written, parsed. Each line has exactly the schema's keys. */
	lines(): Promise<Record<string, unknown>[]>;
	/** The log file as written, for "no note text" checks. */
	raw(): Promise<string>;
}

export function makeGuardRig(): GuardRig {
	const app = new App();
	const vault = app.vault as unknown as MockVault;
	const logAdapter = new MemoryAdapter();
	const log = new DiagnosticLogWriter(logAdapter, LOG_DIR, { now: () => new Date("2026-10-28T10:00:00.000Z"), warn: () => {} });
	const gate = new PassGate<EditorView>();
	return {
		app,
		vault,
		gate,
		logAdapter,
		log,
		watcherDeps: {
			window,
			diagnosticLog: (entry) => log.log(entry),
			loadGuard: { gate, makeIo: (view) => createLoadWaitIo({ app: app as unknown as ObsidianApp, view, window }) },
		},
		async lines() {
			await log.drain();
			const parsed = logLines(logAdapter.files.get(LOG_PATH) ?? "").map((line) => JSON.parse(line) as Record<string, unknown>);
			for (const line of parsed) {
				if (JSON.stringify(Object.keys(line)) !== JSON.stringify([...DIAGNOSTIC_LOG_FIELDS])) throw new Error(`log line breaks PR-1's schema: ${JSON.stringify(Object.keys(line))}`);
			}
			return parsed;
		},
		async raw() {
			await log.drain();
			return logAdapter.files.get(LOG_PATH) ?? "";
		},
	};
}
