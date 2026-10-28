/**
 * The shared "wait until the editor really holds the note" guard (ticket warkworth-46, PR-2).
 *
 * Proven live (Dan's real vault, 2026-10-28): at `file-open` a fresh pane's CM6 document is
 * still `""`; the note's full text lands about 35 ms later. A restore pass that runs on that
 * empty text matches every stored fold against nothing, sets them all aside and stores
 * `hashText("")`. This module decides when a pane is safe to restore against, so no pass has to
 * guess: a pass runs only once the pane shows the right note with its real text.
 *
 * Pure decision logic, in the same style as `matcher.ts` and `dormant.ts`: no Obsidian import
 * and no CodeMirror import. Everything outside the decision (reading the disk, hearing about
 * editor changes and vault events, timers, the pane's file path) is handed in as a `LoadWaitIo`,
 * which `src/load-wait-host.ts` builds for the real app and tests build by hand.
 *
 * "Loaded" (`isEditorLoaded`): the pane's file path equals the pass's path AND the editor text
 * equals the text on disk once `\r\n?` is turned into `\n` and a leading UTF-8 BOM is dropped on
 * both sides (a CRLF note shows up in the editor with LF, and a BOM on disk is not shown), or the user has edited the pane (E8: their edit ends the wait and the
 * pane's own text is used from then on).
 *
 * A `LoadWait` is one wait: `idle -> waiting -> ready | gave-up | read-failed | cancelled`.
 * - The disk text is read once through `io.readDisk` and read again only when the file's
 *   `modify` event fires during the wait. It is used for the loaded comparison and nothing else:
 *   it is never matched against anything.
 * - It re-checks on every editor text change for its pane, once the first read is back, and on a
 *   slow recheck timer (`LOAD_WAIT_RECHECK_MS`). The timer only covers a route that gives no
 *   change event for the text (`EditorView.setState` replaces the state and its listeners
 *   without telling either), and it is also how a wait notices its pane has gone.
 * - It gives up `LOAD_WAIT_GIVE_UP_MS` after it starts. That is the only limit: no shorter
 *   threshold, no guess about how much of the text has arrived.
 * - A deleted or renamed file, or a read that rejects, ends it as `read-failed`.
 *
 * `LoadWaitRegistry` keys waits by the pane (the `EditorView`), never by path, so two panes on one
 * note never share a wait (E17), and starting a wait for a pane cancels that pane's earlier one.
 * A cancelled wait clears its timers and listeners and never reports anything else. The restore
 * passes that come later (settled change, first-open baseline, native-restore guard) use the same
 * registry and the same `LoadWaitIo`; nothing here is specific to the open pass.
 */

/** A wait gives up this long after it starts (Q8). */
export const LOAD_WAIT_GIVE_UP_MS = 30_000;

/** How often a waiting pane is looked at again with no event at all. */
export const LOAD_WAIT_RECHECK_MS = 500;

/** `\r\n` and a lone `\r` become `\n`, the same line-ending rule `hashText` uses, and one leading
 * UTF-8 BOM (U+FEFF) is dropped: `adapter.read` keeps it, the editor does not show it (T1). */
export function normaliseLineEndings(text: string): string {
	return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export interface LoadedInput {
	/** The file the pane is showing right now, or null when it cannot be told. */
	paneFilePath: string | null;
	/** The note the pass is for. */
	passPath: string;
	editorText: string;
	diskText: string;
	/** True once the user has edited this pane since the wait started. */
	userEdited: boolean;
}

/** True when the pane holds the pass's note with its real text, or the user edited the pane. A
 * file that is empty on disk and an empty editor agree, so that counts as loaded at once. */
export function isEditorLoaded(input: LoadedInput): boolean {
	if (input.userEdited) return true;
	if (input.paneFilePath !== input.passPath) return false;
	return normaliseLineEndings(input.editorText) === normaliseLineEndings(input.diskText);
}

export type LoadWaitState = "idle" | "waiting" | "ready" | "gave-up" | "read-failed" | "cancelled";

/** How a wait ended. Texts are for the caller's pass and log only; the log reads their lengths. */
export type LoadWaitResult =
	| { state: "ready"; editorText: string; diskText: string | null; userEdited: boolean }
	| { state: "gave-up"; editorText: string; diskText: string | null }
	| { state: "read-failed"; editorText: string }
	| { state: "cancelled" };

export type Unsubscribe = () => void;

/** What a wait needs from the outside world. */
export interface LoadWaitIo {
	/** The file the pane is showing now, or null. */
	paneFilePath(): string | null;
	/** The pane's current text. */
	editorText(): string;
	/** False once the pane has gone away (closed). */
	isAlive(): boolean;
	/** The note's text on disk, read fresh (never from a cache). Rejects when it cannot be read. */
	readDisk(path: string): Promise<string>;
	/** Calls `cb` after every change to the pane's text; `userEdit` is true for the user's own typing. */
	onEditorChange(cb: (change: { userEdit: boolean }) => void): Unsubscribe;
	/** Calls `cb` when `path` is modified, or deleted or renamed away ("gone"). */
	onFileEvent(path: string, cb: (event: "modify" | "gone") => void): Unsubscribe;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

export interface LoadWaitHooks {
	/** Called once, when the first check finds the pane not loaded yet. */
	onNotLoaded?: (info: { editorText: string; diskText: string }) => void;
}

export class LoadWait {
	state: LoadWaitState = "idle";
	/** Settles once, when the wait ends in any way. Never rejects. */
	readonly done: Promise<LoadWaitResult>;
	/** How many times the disk has been read for this wait (1 + one per `modify` event). */
	diskReads = 0;

	private resolveDone!: (result: LoadWaitResult) => void;
	private diskText: string | null = null;
	private userEdited = false;
	private readGeneration = 0;
	private reportedNotLoaded = false;
	private giveUpTimer: unknown = null;
	private recheckTimer: unknown = null;
	private cleanups: Unsubscribe[] = [];

	constructor(
		readonly path: string,
		private readonly io: LoadWaitIo,
		private readonly hooks: LoadWaitHooks = {},
	) {
		this.done = new Promise<LoadWaitResult>((resolve) => {
			this.resolveDone = resolve;
		});
	}

	/** Starts waiting: reads the disk once and listens. A wait that is not `idle` is left alone. */
	start(): void {
		if (this.state !== "idle") return;
		this.state = "waiting";
		this.cleanups.push(
			this.io.onEditorChange(({ userEdit }) => {
				if (userEdit) this.userEdited = true;
				this.check();
			}),
			this.io.onFileEvent(this.path, (event) => {
				if (event === "gone") this.finish({ state: "read-failed", editorText: this.safeEditorText() });
				else this.readDisk();
			}),
		);
		this.giveUpTimer = this.io.setTimer(() => this.giveUp(), LOAD_WAIT_GIVE_UP_MS);
		this.armRecheck();
		this.readDisk();
	}

	/** Ends a wait that has not ended yet; it reports `cancelled` and does nothing else, ever. */
	cancel(): void {
		if (this.state !== "idle" && this.state !== "waiting") return;
		this.finish({ state: "cancelled" });
	}

	private readDisk(): void {
		const generation = ++this.readGeneration;
		this.diskReads++;
		let read: Promise<string>;
		try {
			read = this.io.readDisk(this.path);
		} catch (err) {
			read = Promise.reject(err instanceof Error ? err : new Error("disk read failed"));
		}
		read.then(
			(text) => {
				if (this.state !== "waiting" || generation !== this.readGeneration) return;
				this.diskText = text;
				this.check();
			},
			() => {
				if (this.state !== "waiting" || generation !== this.readGeneration) return;
				this.finish({ state: "read-failed", editorText: this.safeEditorText() });
			},
		);
	}

	private check(): void {
		if (this.state !== "waiting") return;
		if (!this.io.isAlive()) {
			this.cancel();
			return;
		}
		const editorText = this.io.editorText();
		if (this.userEdited) {
			this.finish({ state: "ready", editorText, diskText: this.diskText, userEdited: true });
			return;
		}
		if (this.diskText === null) return; // the first read is not back yet
		const loaded = isEditorLoaded({
			paneFilePath: this.io.paneFilePath(),
			passPath: this.path,
			editorText,
			diskText: this.diskText,
			userEdited: false,
		});
		if (loaded) {
			this.finish({ state: "ready", editorText, diskText: this.diskText, userEdited: false });
			return;
		}
		if (!this.reportedNotLoaded) {
			this.reportedNotLoaded = true;
			try {
				this.hooks.onNotLoaded?.({ editorText, diskText: this.diskText });
			} catch {
				// A hook failing never changes the wait.
			}
		}
	}

	private giveUp(): void {
		this.giveUpTimer = null;
		this.check(); // text that arrived since the last look still counts
		if (this.state !== "waiting") return;
		this.finish({ state: "gave-up", editorText: this.safeEditorText(), diskText: this.diskText });
	}

	private armRecheck(): void {
		this.recheckTimer = this.io.setTimer(() => {
			this.recheckTimer = null;
			this.check();
			if (this.state === "waiting") this.armRecheck();
		}, LOAD_WAIT_RECHECK_MS);
	}

	private safeEditorText(): string {
		try {
			return this.io.editorText();
		} catch {
			return "";
		}
	}

	private finish(result: LoadWaitResult): void {
		if (this.state !== "idle" && this.state !== "waiting") return;
		this.state = result.state;
		if (this.giveUpTimer !== null) this.io.clearTimer(this.giveUpTimer);
		if (this.recheckTimer !== null) this.io.clearTimer(this.recheckTimer);
		this.giveUpTimer = null;
		this.recheckTimer = null;
		const cleanups = this.cleanups;
		this.cleanups = [];
		for (const cleanup of cleanups) {
			try {
				cleanup();
			} catch {
				// Removing a listener from a pane that is already gone is not an error.
			}
		}
		this.resolveDone(result);
	}
}

/** One live wait per pane, keyed by the pane's own object (the `EditorView`), never by path. */
export class LoadWaitRegistry<K extends object> {
	private readonly waits = new Map<K, LoadWait>();

	/** Starts a wait for `key`'s pane and cancels any wait that pane already had. */
	start(key: K, path: string, io: LoadWaitIo, hooks?: LoadWaitHooks): LoadWait {
		this.cancel(key);
		const wait = new LoadWait(path, io, hooks);
		this.waits.set(key, wait);
		void wait.done.then(() => {
			if (this.waits.get(key) === wait) this.waits.delete(key);
		});
		wait.start();
		return wait;
	}

	/** Cancels `key`'s pending wait, if it has one. Other panes' waits are not touched. */
	cancel(key: K): boolean {
		const wait = this.waits.get(key);
		if (!wait) return false;
		this.waits.delete(key);
		wait.cancel();
		return true;
	}

	/** Cancels every pending wait (the plugin unloading). */
	cancelAll(): void {
		const all = [...this.waits.values()];
		this.waits.clear();
		for (const wait of all) wait.cancel();
	}

	get(key: K): LoadWait | undefined {
		return this.waits.get(key);
	}

	get size(): number {
		return this.waits.size;
	}
}
