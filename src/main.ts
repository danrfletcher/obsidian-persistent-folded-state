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
 * `pruneOrphans` drops any stored entry whose file doesn't exist in the vault at all
 * (`this.app.vault.getAbstractFileByPath(path) === null`), cleaning up whatever a rename, move
 * or delete that happened outside Obsidian (or while it wasn't running) left behind.
 *
 * R1: that prune call runs inside `this.app.workspace.onLayoutReady(...)`, not right after
 * `this.store.load()` the way it first landed. Obsidian's own docs for the `Vault` "create"
 * event say the vault's file tree is still being populated when a plugin's `onload()` runs
 * ("'create' will not be fired for existing files when the vault is first loaded" is the
 * documented workaround — wrap the handler in `onLayoutReady`), so `getAbstractFileByPath` can
 * still return `null` for a note that genuinely exists, for every note in the vault, at the
 * exact moment `onload()` would otherwise have called this. Pruning on that false signal deleted
 * every stored fold on relaunch (GP4's own failure mode) rather than only the genuine orphans
 * this call is meant to clean up. `onLayoutReady` calls back immediately if layout is already
 * ready (so this is a no-op delay in that case) or once it becomes ready otherwise — either way,
 * `getAbstractFileByPath` is answering for real by the time this runs.
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
 *
 * PR-4 (embed recording, G1): `EmbedFoldRecorder` (src/embed-fold-recorder.ts) listens, with
 * capture-phase document listeners, for the user's own click on the fold arrow Obsidian already
 * shows inside an embed, and records it under the embed's key. It adds no command, no UI and no
 * element to the page. `onunload()` removes every listener it added (E9). The readers handed to it
 * only read: the host's text from its view, a target's text with `cachedRead`.
 *
 * PR-5 (embed restore, G2): `EmbedFoldRestorer` (src/embed-fold-restorer.ts) watches each
 * document for embeds rendering and puts the recorded folds back, through the embed's own fold
 * arrows. It never writes to the store or to any note, adds no command, UI or element, and is
 * disposed in `onunload()` alongside the recorder.
 *
 * PR-8 (embed lifecycle, G10, G11, G17): the same `vault` rename and delete listeners also call the
 * embed twins on the store (`handleEmbedRename`, `handleEmbedDelete`), and the `onLayoutReady` prune
 * also calls `pruneOrphanEmbeds`. A heading renamed inside Obsidian is noticed from the metadata
 * cache (`EmbedHeadingRenameTracker`, src/embed-heading-rename.ts), which only reads it. Nothing
 * here writes to a note, and none of it goes through the dormancy tracker.
 *
 * Warkworth-46 PR-1 (GP6, F4, F6): an always-on diagnostic log. `DiagnosticLogWriter`
 * (src/diagnostic-log-writer.ts) appends one JSON line per logged restore pass to
 * `diagnostic-log.jsonl` in this plugin's own folder, through the vault adapter, and the one new
 * command, "Copy diagnostic log", copies it. `restoreOnOpen`, `restoreSettledChange` (through the
 * editor watcher) and the embed restorer each get the writer's `log` as an optional sink; none
 * waits on it. No setting turns it off and no other UI is added.
 */
import { Events, Plugin } from "obsidian";
import type { TFile } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { FoldStore } from "./fold-store";
import { registerCopyDiagnosticLogCommand, registerForgetNoteFoldsCommand } from "./commands";
import { DiagnosticLogWriter } from "./diagnostic-log-writer";
import type { DiagnosticSink } from "./diagnostic-log";
import { PersistentFoldedStateSettingTab } from "./settings-tab";
import { createEditorWatcher } from "./editor-watcher";
import { restoreOnOpen } from "./open-restore";
import { EmbedFoldRecorder } from "./embed-fold-recorder";
import { EmbedFoldRestorer } from "./embed-fold-restorer";
import { EmbedDormancyTracker } from "./embed-dormancy";
import { EmbedHeadingRenameTracker, headingTargetsOf } from "./embed-heading-rename";
import type { EmbedHost } from "./embed-host";

/** Event name for the "settled non-user change" deliverable (E9/E10), triggered on
 * `PersistentFoldedStatePlugin.events` with `(path: string, text: string)`. */
export const SETTLED_NON_USER_CHANGE_EVENT = "settled-non-user-change";

export default class PersistentFoldedStatePlugin extends Plugin {
	store!: FoldStore;
	readonly events = new Events();
	/** R14: shared with every `createEditorWatcher`-created `ViewPlugin` instance; set once
	 * `onunload()` runs. See the file comment. */
	private readonly editorWatcherDisposed = { current: false };
	/** T19/T20/T22: test-only override for `scheduleNativeRestoreGuard`'s check schedule
	 * (`src/open-restore.ts`'s `NATIVE_RESTORE_GUARD_DELAYS_MS`), which is deliberately several
	 * seconds long in production to give a slow, real relaunch's native restore time to arrive.
	 * Set before calling `onload()`; left `undefined` (the default) in production. */
	guardDelaysMs?: readonly number[];
	/** PR-4: records the user's folds inside embeds. Created in `onload()`, disposed in `onunload()`. */
	private embedRecorder: EmbedFoldRecorder | null = null;
	/** PR-5: puts the recorded folds back as each embed renders. Created in `onload()`, disposed in `onunload()`. */
	private embedRestorer: EmbedFoldRestorer | null = null;
	/** PR-7: the dormancy tracker, kept so `onunload()` can cancel its pending second looks. */
	private dormancy: EmbedDormancyTracker | null = null;
	/** Warkworth-46 PR-1: the diagnostic log writer. Created in `onload()`, drained in `onunload()`. */
	diagnosticLog: DiagnosticLogWriter | null = null;

	async onload(): Promise<void> {
		this.store = new FoldStore({
			loadData: () => this.loadData(),
			saveData: (data) => this.saveData(data),
		});
		await this.store.load();

		// Warkworth-46 PR-1: the log lives in this plugin's own folder. `manifest.dir` is optional
		// in Obsidian's typings; the same folder is rebuilt from the config folder when absent.
		const logWriter = new DiagnosticLogWriter(
			this.app.vault.adapter,
			this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
		);
		this.diagnosticLog = logWriter;
		const diagnosticSink: DiagnosticSink = (entry) => logWriter.log(entry);

		// PR-8 (G17): notices a heading renamed inside Obsidian, so the embeds that link to it
		// follow it instead of looking retargeted. Reads the metadata cache only.
		const headingRenames = new EmbedHeadingRenameTracker({
			store: this.store,
			resolveLink: (linktext, sourcePath) => this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null,
			// PR-8 R1: embeds rendered before their records moved are looked at again.
			onMigrated: () => this.embedRestorer?.rescan(),
		});
		const seedHeadingBaselines = (targets: readonly string[]): void => {
			for (const target of targets) {
				const file = this.app.vault.getFileByPath(target);
				if (file !== null) headingRenames.seed(target, this.app.metadataCache.getFileCache(file));
			}
		};

		// G9 ("renamed outside Obsidian: not in v1"): drops any entry whose file no longer
		// exists in the vault at all — the only cleanup for a rename/move/delete that happened
		// outside Obsidian, or while it wasn't running. R1: deferred to onLayoutReady — see the
		// file comment for why running this straight after load() is unsafe.
		this.app.workspace.onLayoutReady(() => {
			this.store.pruneOrphans((path) => this.app.vault.getAbstractFileByPath(path) !== null);
			// PR-8 (G10, outside Obsidian): the same prune for embed records, whose host or
			// target is gone. A record whose host and every target still exist is kept.
			this.store.pruneOrphanEmbeds((path) => this.app.vault.getAbstractFileByPath(path) !== null);
			// PR-8 (G17): a baseline of the headings of every note a stored embed names by heading,
			// so a rename made before that note is next opened is still told from a hand edit.
			seedHeadingBaselines(headingRenames.storedHeadingTargets());
		});

		registerForgetNoteFoldsCommand(this);
		registerCopyDiagnosticLogCommand(this, logWriter);
		this.addSettingTab(new PersistentFoldedStateSettingTab(this.app, this));
		this.registerEditorExtension(
			createEditorWatcher({
				store: this.store,
				onSettledNonUserChange: (path, text) => this.events.trigger(SETTLED_NON_USER_CHANGE_EVENT, path, text),
				disposed: this.editorWatcherDisposed,
				diagnosticLog: diagnosticSink,
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

		// G1 (PR-4): record the user's own folds inside embeds, in the main window and in every
		// pop-out window. The recorder only reads the vault; it writes to the store alone.
		// PR-5 (G2): the restorer below reads them back as each embed renders, through the same
		// readers, and never writes.
		const readHostText = (host: { view: { getViewData(): string } }): string => host.view.getViewData();
		const readNote = async (path: string): Promise<string | null> => {
			const file = this.app.vault.getFileByPath(path);
			return file === null ? null : await this.app.vault.cachedRead(file);
		};
		const resolveLink = (linktext: string, sourcePath: string): string | null =>
			this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null;
		// Live Preview only: where in the host's text a rendered embed sits. Used just to tell
		// identical embeds apart; undocumented route, same as the file-open handler below.
		const positionOf = (host: EmbedHost, el: Element): number | null => {
			if (host.mode !== "live-preview") return null;
			const cm = (host.view.editor as unknown as { cm?: EditorView } | undefined)?.cm;
			return cm ? cm.posAtDOM(el) : null;
		};
		const recorder = new EmbedFoldRecorder({
			workspace: this.app.workspace,
			store: {
				getEmbed: (id) => this.store.getEmbed(id),
				// PR-8 R2: a heading embed first folded now gets its target's headings recorded
				// at once, so a rename of that heading before the target is next opened is still
				// told from a hand edit.
				setEmbed: (record) => {
					if (this.store.setEmbed(record)) seedHeadingBaselines(headingTargetsOf(record));
				},
			},
			readHostText,
			readNote,
			resolveLink,
			positionOf,
		});
		this.embedRecorder = recorder;
		recorder.attach(document);
		this.registerEvent(this.app.workspace.on("window-open", (_win, popout) => recorder.attach(popout.document)));
		this.registerEvent(this.app.workspace.on("window-close", (_win, popout) => recorder.detach(popout.document)));

		// PR-7 (G6, E6): a retargeted or broken embed's stored state goes dormant for 10 minutes,
		// then is forgotten. Read-only toward the vault; never called from a rename handler.
		const dormancy = new EmbedDormancyTracker({ store: this.store, readNote, resolveLink });
		this.registerEvent(
			this.app.workspace.on("file-open", (file: TFile | null) => {
				if (!file) return;
				// A link changed while the host was closed starts its clock at the next open. A
				// heading-linked record is held back for 10 s, so the tracker looks again after
				// that even when no embed of the host renders (R5).
				void dormancy.reconcileOnOpen(file.path);
			})
		);
		this.dormancy = dormancy;

		const restorer = new EmbedFoldRestorer({
			workspace: this.app.workspace,
			store: this.store,
			readHostText,
			readNote,
			resolveLink,
			positionOf,
			whenRecorded: () => recorder.whenIdle(),
			dormancy,
			diagnosticLog: diagnosticSink,
		});
		this.embedRestorer = restorer;
		restorer.attach(document);
		this.registerEvent(this.app.workspace.on("window-open", (_win, popout) => restorer.attach(popout.document)));
		this.registerEvent(this.app.workspace.on("window-close", (_win, popout) => restorer.detach(popout.document)));

		// G9/G10: re-key or remove the stored entry (and every entry nested beneath it, for a
		// folder) on a rename/move or delete inside Obsidian. `registerEvent` tears both down
		// automatically on unload.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.store.handleRename(oldPath, file.path);
				// PR-8 (G10): embed records follow the same rename, in their own section. A
				// rewritten link is a migration, never a retarget, so nothing here starts a dormant clock.
				this.store.handleEmbedRename(oldPath, file.path);
				headingRenames.handleRename(oldPath, file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.store.handleDelete(file.path);
				// PR-8 (G11): a deleted host or target takes its embed records with it.
				this.store.handleEmbedDelete(file.path);
				headingRenames.handleDelete(file.path);
			})
		);

		// PR-8 (G17): a note opened gets a heading baseline; every re-parse is checked for a
		// heading rename and for the links Obsidian rewrote because of one.
		this.registerEvent(
			this.app.workspace.on("file-open", (file: TFile | null) => {
				if (file) headingRenames.seed(file.path, this.app.metadataCache.getFileCache(file));
			})
		);
		this.registerEvent(
			this.app.metadataCache.on("changed", (file, _data, cache) => headingRenames.onChanged(file.path, cache))
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
					restoreOnOpen(cm, file.path, text, {
						store: this.store,
						// T8: resolved fresh on every scheduleNativeRestoreGuard check, not
						// just once here — see src/open-restore.ts's OpenRestoreDeps comment
						// for why a view captured only at file-open time was found, live,
						// never correcting a late native restore after a real relaunch.
						resolveView: (path) => {
							const current = this.app.workspace.activeEditor;
							if (!current || current.file?.path !== path) return null;
							return (current.editor as unknown as { cm?: EditorView } | undefined)?.cm ?? null;
						},
						onLayoutReady: (cb) => this.app.workspace.onLayoutReady(cb),
						guardDelaysMs: this.guardDelaysMs,
						diagnosticLog: diagnosticSink,
					}).catch((err: unknown) => {
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
		// E9: no embed listener or observer outlives the plugin, and nothing queued is recorded.
		this.embedRecorder?.dispose();
		this.embedRecorder = null;
		this.embedRestorer?.dispose();
		this.embedRestorer = null;
		this.dormancy?.dispose();
		this.dormancy = null;
		// Warkworth-46 PR-1: lines already queued are still written (drain never rejects); a
		// re-enabled plugin builds a new writer that keeps appending to the same file.
		void this.diagnosticLog?.drain();
		this.diagnosticLog = null;
		this.flushAtOnce();
	}

	private flushAtOnce(): void {
		this.store.flush().catch((err: unknown) => {
			console.error("persistent-folded-state: flush failed", err);
		});
	}
}
