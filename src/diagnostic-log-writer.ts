/**
 * The one file that writes the diagnostic log (ticket warkworth-46, PR-1, F3, F4, E16). It
 * appends the lines `src/diagnostic-log.ts` builds to `diagnostic-log.jsonl` in the plugin's own
 * folder, through the vault adapter, and builds that path from nothing but the plugin folder it is
 * given (`manifest.dir`) and the constant `DIAGNOSTIC_LOG_FILE`. No other file in `src/` may write
 * through the adapter (pinned in tests/unit/fence.test.ts).
 *
 * Fire and forget: `log()` returns at once and a restore pass never waits on the disk. Writes run
 * one at a time down a single promise chain (the pattern FoldStore's flush chain uses), so two
 * passes that log in the same tick both land, in call order, each as one whole line. A failing
 * write never throws out of the writer: it is reported once with `console.warn` and the next
 * write starts from a fresh read of the file.
 *
 * Every writer for the same adapter and file shares one chain (`chainFor`). A plugin disabled and
 * re-enabled makes a new writer while the old one may still have lines queued; the new writer's
 * first write waits behind them, so it loads the file only after they have landed and its line
 * count is right (the 1,000-line cap holds across a re-enable).
 *
 * The cap counts physical lines and never parses them, so a corrupt or truncated line is kept and
 * copied as it is. The file is read once (to count its lines and trim an over-cap file) and then
 * only appended to, until it reaches the cap, when each append rewrites the newest lines.
 */
import {
	DIAGNOSTIC_LOG_MAX_LINES,
	appendLogLine,
	buildLogLine,
	logLines,
	trimLogText,
	type DiagnosticEntry,
} from "./diagnostic-log";

/** The log's file name inside the plugin folder. */
export const DIAGNOSTIC_LOG_FILE = "diagnostic-log.jsonl";

/** The four vault adapter calls the log uses (Obsidian's `DataAdapter` satisfies this). */
export interface DiagnosticLogAdapter {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	append(path: string, data: string): Promise<void>;
}

export interface DiagnosticLogWriterOptions {
	/** Clock for the `t` field. Defaults to the real time. */
	now?: () => Date;
	/** Where the one-time failure report goes. Defaults to `console.warn`. */
	warn?: (message: string, err: unknown) => void;
	/** Line cap. Defaults to 1,000; only a test passes another. */
	maxLines?: number;
	/** The longest `readAll` waits for queued writes before reading the file as it is. Defaults
	 * to `READ_WAIT_MS`; only a test passes another. */
	readWaitMs?: number;
}

/** How long `readAll` waits on a queued write before giving up on it and reading anyway, so
 * "Copy diagnostic log" always ends in a Notice even if an adapter write never settles. */
export const READ_WAIT_MS = 3000;

/** The chain every writer for one adapter and file appends to. */
const chains = new WeakMap<object, Map<string, Promise<void>>>();

function chainFor(adapter: object, path: string): { get(): Promise<void>; set(next: Promise<void>): void } {
	let byPath = chains.get(adapter);
	if (!byPath) {
		byPath = new Map();
		chains.set(adapter, byPath);
	}
	const map = byPath;
	return {
		get: () => map.get(path) ?? Promise.resolve(),
		set: (next) => void map.set(path, next),
	};
}

/** What the writer knows about the file between writes. */
interface FileState {
	exists: boolean;
	lineCount: number;
	/** False when the last line was cut short, so the next append starts on a new line. */
	endsWithNewline: boolean;
}

export class DiagnosticLogWriter {
	/** The log file, inside the plugin folder. */
	readonly path: string;
	private readonly sharedChain: { get(): Promise<void>; set(next: Promise<void>): void };
	private state: FileState | null = null;
	private warned = false;
	private readonly now: () => Date;
	private readonly warn: (message: string, err: unknown) => void;
	private readonly maxLines: number;
	private readonly readWaitMs: number;

	constructor(
		private readonly adapter: DiagnosticLogAdapter,
		pluginDir: string,
		options: DiagnosticLogWriterOptions = {},
	) {
		this.path = `${pluginDir}/${DIAGNOSTIC_LOG_FILE}`;
		this.now = options.now ?? (() => new Date());
		this.warn = options.warn ?? ((message, err) => console.warn(message, err));
		this.maxLines = options.maxLines ?? DIAGNOSTIC_LOG_MAX_LINES;
		this.readWaitMs = options.readWaitMs ?? READ_WAIT_MS;
		this.sharedChain = chainFor(adapter, this.path);
	}

	private get chain(): Promise<void> {
		return this.sharedChain.get();
	}

	private set chain(next: Promise<void>) {
		this.sharedChain.set(next);
	}

	/** Queues one line for `entry`. Returns at once and never throws. An invalid entry is dropped. */
	log(entry: DiagnosticEntry): void {
		let line: string | null;
		try {
			line = buildLogLine(entry, this.now());
		} catch {
			return;
		}
		if (line === null) return;
		const next = line;
		this.chain = this.chain.then(() => this.append(next)).catch((err: unknown) => this.failed(err));
	}

	/** Resolves once every line queued so far has been written (or has failed). Never rejects. */
	drain(): Promise<void> {
		return this.chain;
	}

	/** The whole file as it is on disk once everything queued has been written, or `null` when
	 * there is no file. Waits at most `readWaitMs` for the queue: a write that never settles
	 * does not stop the read, which then returns the file as it is. Rejects only if the read
	 * itself fails. */
	async readAll(): Promise<string | null> {
		let timer: number | undefined;
		const timedOut = new Promise<void>((resolve) => {
			timer = window.setTimeout(resolve, this.readWaitMs);
		});
		try {
			await Promise.race([this.chain, timedOut]);
		} finally {
			window.clearTimeout(timer);
		}
		if (!(await this.adapter.exists(this.path))) return null;
		return this.adapter.read(this.path);
	}

	private failed(err: unknown): void {
		// The file's state is unknown after a failure: the next write starts from a fresh read.
		this.state = null;
		if (this.warned) return;
		this.warned = true;
		this.warn("persistent-folded-state: diagnostic log write failed", err);
	}

	private async load(): Promise<FileState> {
		if (!(await this.adapter.exists(this.path))) return { exists: false, lineCount: 0, endsWithNewline: true };
		const text = await this.adapter.read(this.path);
		const trimmed = trimLogText(text, this.maxLines);
		if (trimmed !== text) await this.adapter.write(this.path, trimmed);
		return { exists: true, lineCount: logLines(trimmed).length, endsWithNewline: trimmed === "" || trimmed.endsWith("\n") };
	}

	private async append(line: string): Promise<void> {
		const state = this.state ?? (await this.load());
		this.state = state;

		if (!state.exists) {
			// First write: create the file.
			await this.adapter.write(this.path, `${line}\n`);
			this.state = { exists: true, lineCount: 1, endsWithNewline: true };
			return;
		}
		if (state.lineCount >= this.maxLines) {
			// At the cap: the oldest line goes, the new one is last.
			const next = appendLogLine(await this.adapter.read(this.path), line, this.maxLines);
			await this.adapter.write(this.path, next);
			this.state = { exists: true, lineCount: logLines(next).length, endsWithNewline: true };
			return;
		}
		await this.adapter.append(this.path, `${state.endsWithNewline ? "" : "\n"}${line}\n`);
		this.state = { exists: true, lineCount: state.lineCount + 1, endsWithNewline: true };
	}
}
