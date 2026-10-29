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
 *
 * Warkworth-46 PR-3 adds the other passes' side, in this same module (there is no second guard):
 * - `guardPass` / `checkPass`: the one decision rule (proceed / wait / refuse / read-failed) every
 *   guarded pass applies to the pane it is about to restore, table-tested in
 *   tests/unit/load-wait.test.ts.
 * - `PassGate`: a pass that must wait (settled change, first-open baseline) leaves its handlers
 *   with the gate, keyed by the pane's `EditorView` in a `WeakMap`, and the gate runs them when the
 *   wait ends with real text. Because the state is keyed by the view and not held by the
 *   `ViewPlugin` instance, a pane whose text arrives through `EditorView.setState` (which
 *   recreates every `ViewPlugin` instance, E2) is still found: the new instance asks the gate to
 *   look again at once.
 * - `runSerialised`: one restore pass at a time per pane, so the open pass and a settled pass
 *   released by the same text landing never write the store at the same moment.
 */

import type { DiagnosticOutcome } from "./diagnostic-log";

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

/** The restore passes that ask the guard (PR-2 and PR-3): the log's `pass` codes, minus `load-cleanup`. */
export type GuardPass = "open" | "settled" | "baseline" | "native-guard" | "embed";

/** What a pass does with the pane it was asked about. `refuse` is `wait` for a pane that is empty
 * while the note is not: the pass is refused outright and logged as `refused-empty`. */
export type GuardDecision = "proceed" | "wait" | "refuse" | "read-failed";

export interface GuardInput extends Omit<LoadedInput, "diskText"> {
	/** The note's text on disk, or null when the read failed. */
	diskText: string | null;
}

export interface GuardVerdict {
	pass: GuardPass;
	decision: GuardDecision;
	/** The log's outcome code for a pass that does not proceed; null for `proceed`. */
	outcome: DiagnosticOutcome | null;
}

/**
 * The one rule every guarded pass follows (settled, baseline, native-guard, embed, and the open
 * pass through `LoadWait`), in this order:
 *  1. the user has edited the pane: proceed on the pane's own text (E8);
 *  2. the disk read failed: read-failed, nothing changes (E12);
 *  3. the pane shows another file: wait (E5);
 *  4. editor and disk agree after line-ending normalisation: proceed (an empty note agrees with an
 *     empty editor, so it is a real change, E6);
 *  5. the editor is empty and the note is not: refuse (E1, E3);
 *  6. otherwise the text is half there: wait (E4).
 * Nothing in the rule depends on `pass`; it is in the verdict so the caller logs the right line.
 */
export function guardPass(pass: GuardPass, input: GuardInput): GuardVerdict {
	const verdict = (decision: GuardDecision, outcome: DiagnosticOutcome | null): GuardVerdict => ({ pass, decision, outcome });
	if (input.userEdited) return verdict("proceed", null);
	if (input.diskText === null) return verdict("read-failed", "read-failed");
	if (isEditorLoaded({ ...input, diskText: input.diskText })) return verdict("proceed", null);
	if (input.paneFilePath === input.passPath && normaliseLineEndings(input.editorText) === "") return verdict("refuse", "refused-empty");
	return verdict("wait", "waiting");
}

/** A guard check: the verdict, and the two lengths the log line reports (-1 for a read that failed). */
export interface GuardCheck {
	verdict: GuardVerdict;
	editorLen: number;
	diskLen: number;
}

/** Reads the note from disk (`io.readDisk`, never a cache) and applies `guardPass` to `editorText`.
 * Never throws: a read that rejects, or throws, is a `read-failed` verdict. */
export async function checkPass(pass: GuardPass, path: string, editorText: string, io: LoadWaitIo): Promise<GuardCheck> {
	let diskText: string | null = null;
	try {
		diskText = await io.readDisk(path);
	} catch {
		diskText = null;
	}
	let paneFilePath: string | null = null;
	try {
		paneFilePath = io.paneFilePath();
	} catch {
		paneFilePath = null;
	}
	const verdict = guardPass(pass, { paneFilePath, passPath: path, editorText, diskText, userEdited: false });
	return { verdict, editorLen: editorText.length, diskLen: diskText?.length ?? -1 };
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

	/** Looks at the pane again now. For a route that gives no change event (`EditorView.setState`). */
	recheck(): void {
		this.check();
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

/** What a pass that had to wait leaves with the `PassGate`. */
export interface HoldHandlers {
	/** The wait ended with the pane holding the note's real text, or with the user's edit (then
	 * `userEdited` is true and `editorText` is the pane's own text). Called once. */
	ready(info: { editorText: string; diskLen: number; userEdited: boolean }): void;
	/** The wait ended without real text (30 s, or the note could not be read). Nothing was changed. */
	ended(info: { state: "gave-up" | "read-failed"; editorLen: number; diskLen: number }): void;
}

interface Hold {
	path: string;
	wait: LoadWait;
	/** One handler set per pass kind, in the order the passes first asked. A later ask by the same
	 * kind replaces the earlier one, so the last settled text wins and the pass runs once. */
	handlers: Map<GuardPass, HoldHandlers>;
}

/**
 * The pending waits of the settled-change and first-open-baseline passes (PR-3). One wait per pane,
 * shared by whichever passes are waiting on it, and keyed by the pane's own object (the
 * `EditorView`) in a `WeakMap`, never held by a `ViewPlugin` instance: `EditorView.setState`
 * recreates every instance without a transaction, and the wait must outlive that (E2).
 *
 * It is deliberately separate from the open pass's `LoadWaitRegistry` (src/main.ts): starting a
 * wait for a pane cancels that pane's earlier one, and a settled pass must not cancel an open pass.
 */
export class PassGate<K extends object> {
	private readonly waits = new LoadWaitRegistry<K>();
	private readonly holds = new WeakMap<K, Hold>();

	/**
	 * Leaves `handlers` to run when `key`'s pane holds `path`'s real text. If the pane already has a
	 * wait for that path, no second one starts (its 30 s clock keeps running) and the pass kind's
	 * handlers are replaced. Returns true when this call started a new wait.
	 */
	hold(pass: GuardPass, key: K, path: string, io: LoadWaitIo, handlers: HoldHandlers): boolean {
		const existing = this.holds.get(key);
		if (existing !== undefined && existing.path === path && existing.wait.state === "waiting") {
			existing.handlers.set(pass, handlers);
			return false;
		}
		const hold: Hold = { path, wait: undefined as unknown as LoadWait, handlers: new Map([[pass, handlers]]) };
		this.holds.set(key, hold);
		hold.wait = this.waits.start(key, path, io);
		void hold.wait.done.then((result) => this.settle(key, hold, result));
		return true;
	}

	/** True while `key`'s pane has a wait that has not ended. */
	isHolding(key: K): boolean {
		return this.holds.get(key)?.wait.state === "waiting";
	}

	/** Looks at `key`'s pending wait again now, if it has one (a new `ViewPlugin` instance after
	 * `setState`, or any later update to the pane). A no-op for a pane with no wait. */
	recheck(key: K): void {
		this.holds.get(key)?.wait.recheck();
	}

	/** Cancels `key`'s pending wait. Its handlers run nothing and write no log line. */
	cancel(key: K): void {
		this.waits.cancel(key);
	}

	/** Cancels every pending wait (the plugin unloading). */
	cancelAll(): void {
		this.waits.cancelAll();
	}

	private settle(key: K, hold: Hold, result: LoadWaitResult): void {
		if (this.holds.get(key) === hold) this.holds.delete(key);
		const run = (fn: () => void): void => {
			try {
				fn();
			} catch (err) {
				console.error("persistent-folded-state: a restore pass waiting for the note failed", err);
			}
		};
		for (const handlers of hold.handlers.values()) {
			if (result.state === "ready") {
				run(() => handlers.ready({ editorText: result.editorText, diskLen: result.diskText?.length ?? -1, userEdited: result.userEdited }));
			} else if (result.state === "gave-up") {
				run(() => handlers.ended({ state: "gave-up", editorLen: result.editorText.length, diskLen: result.diskText?.length ?? -1 }));
			} else if (result.state === "read-failed") {
				run(() => handlers.ended({ state: "read-failed", editorLen: result.editorText.length, diskLen: -1 }));
			}
			// cancelled: nothing runs, nothing is logged.
		}
	}
}

const paneQueues = new WeakMap<object, Promise<void>>();

/**
 * Runs `task` after every task already queued for `key`'s pane has finished, and resolves with its
 * result. A restore pass reads the store, awaits the matcher and writes a delta back; two passes
 * for one pane running at once (the open pass and a settled pass that the same text landing
 * released) would each write from a snapshot the other had already changed. A task that rejects
 * does not stop the ones queued behind it.
 */
export function runSerialised<T>(key: object, task: () => Promise<T>): Promise<T> {
	const previous = paneQueues.get(key) ?? Promise.resolve();
	const run = previous.then(() => task());
	paneQueues.set(
		key,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}
