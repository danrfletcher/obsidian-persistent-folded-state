/**
 * The always-on diagnostic log (ticket warkworth-46, PR-1, GP6, F4): pure builders and the cap
 * rule for `diagnostic-log.jsonl`. One JSON line per restore pass that changes stored data (or,
 * for `restoreOnOpen`, per pass), so any recurrence of "folds randomly open" can be traced to the
 * exact pass that caused it. Nothing here touches the disk, the clock of its own or Obsidian:
 * `src/diagnostic-log-writer.ts` is the only file that writes.
 *
 * F4: a line carries paths, counts, lengths, a timestamp and two enum codes, and nothing else. It
 * is built field by field from a typed record, never by serialising an object it was handed, and
 * the stored `folds`/`dormant` arrays are only ever counted (`recordCounts` reads `.length`), so
 * no note text, heading, anchor or fold text can reach a line. There is no setting to turn it off.
 *
 * `DiagnosticPass` and `DiagnosticOutcome` list every value the later PRs of this ticket will use
 * (the open-path wait, the settled/native-guard/baseline passes, the load-time duplicate
 * cleanup); a value outside the lists is a compile error and is also refused at run time.
 */

/** Which restore pass wrote the line. */
export const DIAGNOSTIC_PASSES = ["open", "settled", "baseline", "native-guard", "embed", "load-cleanup"] as const;
export type DiagnosticPass = (typeof DIAGNOSTIC_PASSES)[number];

/** What the pass did. */
export const DIAGNOSTIC_OUTCOMES = [
	"applied",
	"rematched",
	"waiting",
	"refused-empty",
	"gave-up",
	"read-failed",
	"cleaned",
] as const;
export type DiagnosticOutcome = (typeof DIAGNOSTIC_OUTCOMES)[number];

/** The exact key set of one line, in order. The F4 tests compare `Object.keys` against this. */
export const DIAGNOSTIC_LOG_FIELDS = [
	"t",
	"path",
	"pass",
	"editorLen",
	"diskLen",
	"foldsBefore",
	"dormantBefore",
	"foldsAfter",
	"dormantAfter",
	"outcome",
] as const;

/** The log never holds more than this many lines; the oldest are dropped first (F4, E16). */
export const DIAGNOSTIC_LOG_MAX_LINES = 1000;

/** What a pass reports. Only typed numeric, path and enum fields: there is deliberately nowhere
 * to put text. `diskLen` is -1 when the pass made no disk read. */
export interface DiagnosticEntry {
	path: string;
	pass: DiagnosticPass;
	editorLen: number;
	diskLen: number;
	foldsBefore: number;
	dormantBefore: number;
	foldsAfter: number;
	dormantAfter: number;
	outcome: DiagnosticOutcome;
}

/** A callback a restore pass is handed to log one entry. Fire and forget: it returns nothing, a
 * pass never waits on it, and `reportDiagnostic` swallows anything it throws. */
export type DiagnosticSink = (entry: DiagnosticEntry) => void;

/** How many folds and set-aside folds a stored record holds. */
export interface RecordCounts {
	folds: number;
	dormant: number;
}

/** Counts only: reads `.length` of the two lists and never touches what is in them. A missing
 * record counts as 0/0. */
export function recordCounts(
	record: { readonly folds: readonly unknown[]; readonly dormant: readonly unknown[] } | undefined | null,
): RecordCounts {
	return { folds: record?.folds.length ?? 0, dormant: record?.dormant.length ?? 0 };
}

/** True when two stored records differ in hash, folds or set-aside folds. Compared in memory
 * only; nothing of either record is kept or logged. */
export function recordChanged(
	a: { readonly contentHash: string; readonly folds: readonly unknown[]; readonly dormant: readonly unknown[] },
	b: { readonly contentHash: string; readonly folds: readonly unknown[]; readonly dormant: readonly unknown[] },
): boolean {
	return (
		a.contentHash !== b.contentHash ||
		JSON.stringify(a.folds) !== JSON.stringify(b.folds) ||
		JSON.stringify(a.dormant) !== JSON.stringify(b.dormant)
	);
}

/** Builds an entry from the stored record before and after a pass. */
export function diagnosticEntry(input: {
	path: string;
	pass: DiagnosticPass;
	outcome: DiagnosticOutcome;
	editorLen: number;
	/** -1 (the default) when the pass made no disk read. */
	diskLen?: number;
	before: RecordCounts;
	after: RecordCounts;
}): DiagnosticEntry {
	return {
		path: input.path,
		pass: input.pass,
		editorLen: input.editorLen,
		diskLen: input.diskLen ?? -1,
		foldsBefore: input.before.folds,
		dormantBefore: input.before.dormant,
		foldsAfter: input.after.folds,
		dormantAfter: input.after.dormant,
		outcome: input.outcome,
	};
}

/** Hands `entry` to `sink` if there is one. Never throws and never waits: a logging failure must
 * not break a restore pass (E16). */
export function reportDiagnostic(sink: DiagnosticSink | undefined, entry: DiagnosticEntry): void {
	if (!sink) return;
	try {
		sink(entry);
	} catch {
		// Deliberately ignored: the log is best effort.
	}
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (list as readonly string[]).includes(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * One physical line (no trailing newline) for `entry` at time `t`, or `null` when the entry is
 * not valid (an unknown pass or outcome, a non-numeric length, a non-string path or a bad time).
 * Built field by field, so an object with extra properties (at run time, past the type) still
 * produces exactly `DIAGNOSTIC_LOG_FIELDS`. JSON escaping keeps a path with quotes, newlines or
 * unicode on one line; U+2028/U+2029, which JSON leaves raw, are escaped too.
 */
export function buildLogLine(entry: DiagnosticEntry, t: Date): string | null {
	if (!isOneOf(DIAGNOSTIC_PASSES, entry.pass) || !isOneOf(DIAGNOSTIC_OUTCOMES, entry.outcome)) return null;
	if (typeof entry.path !== "string") return null;
	const numbers = [entry.editorLen, entry.diskLen, entry.foldsBefore, entry.dormantBefore, entry.foldsAfter, entry.dormantAfter];
	if (!numbers.every(isCount)) return null;
	if (Number.isNaN(t.getTime())) return null;

	const line = JSON.stringify({
		t: t.toISOString(),
		path: entry.path,
		pass: entry.pass,
		editorLen: Math.trunc(entry.editorLen),
		diskLen: Math.trunc(entry.diskLen),
		foldsBefore: Math.trunc(entry.foldsBefore),
		dormantBefore: Math.trunc(entry.dormantBefore),
		foldsAfter: Math.trunc(entry.foldsAfter),
		dormantAfter: Math.trunc(entry.dormantAfter),
		outcome: entry.outcome,
	});
	return line.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** The lines of a log file's text. Counts physical lines only and never parses them, so a corrupt
 * or truncated line is just another line. Blank lines are not lines. */
export function logLines(text: string): string[] {
	return text.split("\n").filter((line) => line !== "");
}

/** The newest `max` of `lines`; the oldest are dropped first. */
export function capLines(lines: readonly string[], max: number = DIAGNOSTIC_LOG_MAX_LINES): string[] {
	return lines.length > max ? lines.slice(lines.length - max) : [...lines];
}

/** The log text after appending `line` to `existing`, capped at `max` lines (oldest dropped
 * first). Each line, including the last, ends in a newline. */
export function appendLogLine(existing: string, line: string, max: number = DIAGNOSTIC_LOG_MAX_LINES): string {
	const lines = capLines([...logLines(existing), line], max);
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** `text` trimmed to its newest `max` lines (an over-cap file on load). Returns `text` itself
 * when it is already within the cap, so a file that needs no change is never rewritten. */
export function trimLogText(text: string, max: number = DIAGNOSTIC_LOG_MAX_LINES): string {
	const lines = logLines(text);
	if (lines.length <= max) return text;
	return `${capLines(lines, max).join("\n")}\n`;
}
