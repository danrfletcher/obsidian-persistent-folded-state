/**
 * Warkworth-46 PR-1: the pure half of the diagnostic log. No mocks: every test calls the real
 * builders with explicit inputs. Covers the line shape (GP6), the enums, the keys-only rule (F4),
 * the 1,000-line cap (E16) and escaping.
 */
import { describe, expect, it } from "vitest";
import {
	DIAGNOSTIC_LOG_FIELDS,
	DIAGNOSTIC_LOG_MAX_LINES,
	DIAGNOSTIC_OUTCOMES,
	DIAGNOSTIC_PASSES,
	appendLogLine,
	buildLogLine,
	capLines,
	diagnosticEntry,
	logLines,
	recordChanged,
	recordCounts,
	reportDiagnostic,
	trimLogText,
	type DiagnosticEntry,
	type DiagnosticOutcome,
	type DiagnosticPass,
} from "../../src/diagnostic-log";

const T = new Date("2026-10-28T14:21:44.123Z");

function entry(over: Partial<DiagnosticEntry> = {}): DiagnosticEntry {
	return {
		path: "Notes/Tasks.md",
		pass: "open",
		editorLen: 1200,
		diskLen: -1,
		foldsBefore: 3,
		dormantBefore: 1,
		foldsAfter: 4,
		dormantAfter: 0,
		outcome: "applied",
		...over,
	};
}

describe("buildLogLine: shape (GP6)", () => {
	it("is one JSON line whose keys are exactly the field list, in order", () => {
		const line = buildLogLine(entry(), T);
		expect(line).not.toBeNull();
		expect(line).not.toContain("\n");
		const parsed = JSON.parse(line as string) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual([...DIAGNOSTIC_LOG_FIELDS]);
		expect(Object.keys(parsed)).toEqual([
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
		]);
	});

	it("writes t as an ISO string and carries every value through", () => {
		const parsed = JSON.parse(buildLogLine(entry({ diskLen: 1190 }), T) as string) as Record<string, unknown>;
		expect(parsed).toEqual({
			t: "2026-10-28T14:21:44.123Z",
			path: "Notes/Tasks.md",
			pass: "open",
			editorLen: 1200,
			diskLen: 1190,
			foldsBefore: 3,
			dormantBefore: 1,
			foldsAfter: 4,
			dormantAfter: 0,
			outcome: "applied",
		});
	});
});

describe("buildLogLine: enums", () => {
	it("accepts exactly the six passes and the seven outcomes", () => {
		expect([...DIAGNOSTIC_PASSES]).toEqual(["open", "settled", "baseline", "native-guard", "embed", "load-cleanup"]);
		expect([...DIAGNOSTIC_OUTCOMES]).toEqual([
			"applied",
			"rematched",
			"waiting",
			"refused-empty",
			"gave-up",
			"read-failed",
			"cleaned",
		]);
		for (const pass of DIAGNOSTIC_PASSES) expect(buildLogLine(entry({ pass }), T)).not.toBeNull();
		for (const outcome of DIAGNOSTIC_OUTCOMES) expect(buildLogLine(entry({ outcome }), T)).not.toBeNull();
	});

	it("refuses an unknown pass or outcome at run time", () => {
		expect(buildLogLine(entry({ pass: "other" as DiagnosticPass }), T)).toBeNull();
		expect(buildLogLine(entry({ outcome: "mystery" as DiagnosticOutcome }), T)).toBeNull();
		expect(buildLogLine(entry({ pass: undefined as unknown as DiagnosticPass }), T)).toBeNull();
	});

	it("is a compile error to use an unknown value", () => {
		// @ts-expect-error "other" is not a DiagnosticPass
		const badPass: DiagnosticPass = "other";
		// @ts-expect-error "mystery" is not a DiagnosticOutcome
		const badOutcome: DiagnosticOutcome = "mystery";
		expect([badPass, badOutcome]).toHaveLength(2);
	});

	it("refuses a non-numeric length, a non-string path or an invalid time", () => {
		expect(buildLogLine(entry({ editorLen: Number.NaN }), T)).toBeNull();
		expect(buildLogLine(entry({ diskLen: "9" as unknown as number }), T)).toBeNull();
		expect(buildLogLine(entry({ path: 5 as unknown as string }), T)).toBeNull();
		expect(buildLogLine(entry(), new Date(Number.NaN))).toBeNull();
	});
});

describe("buildLogLine: keys only, never text (F4)", () => {
	const MARKER = "UNIQUE-MARKER-9f3b1c";
	const HEADING = "Secret heading text";

	it("a record whose folds and dormant hold anchors with heading text, and a note body with a marker, reach the line only as counts", () => {
		const anchor = { kind: "heading", indent: 0, text: HEADING, siblingIndex: 0, parentChain: [HEADING] };
		const record = { contentHash: "abc", folds: [anchor, anchor], dormant: [{ ...anchor, text: MARKER, dormantSince: 5 }] };
		const body = `# ${HEADING}\n\n${MARKER} is in the note body\n`;
		const built = diagnosticEntry({
			path: "Notes/Tasks.md",
			pass: "settled",
			outcome: "rematched",
			editorLen: body.length,
			before: recordCounts(record),
			after: recordCounts(record),
		});
		const line = buildLogLine(built, T) as string;

		expect(line).not.toContain(MARKER);
		expect(line).not.toContain(HEADING);
		expect(line).not.toContain("parentChain");
		const parsed = JSON.parse(line) as Record<string, unknown>;
		expect(parsed.foldsBefore).toBe(2);
		expect(parsed.dormantBefore).toBe(1);
		expect(parsed.editorLen).toBe(body.length);
	});

	it("an entry carrying extra text-bearing properties past the types still produces exactly the field list", () => {
		const sneaky = {
			...entry(),
			text: MARKER,
			heading: HEADING,
			anchor: { text: MARKER },
			content: MARKER,
			folds: [{ text: MARKER }],
		} as DiagnosticEntry;
		const line = buildLogLine(sneaky, T) as string;
		expect(Object.keys(JSON.parse(line) as object)).toEqual([...DIAGNOSTIC_LOG_FIELDS]);
		expect(line).not.toContain(MARKER);
		expect(line).not.toContain(HEADING);
		for (const banned of ["text", "heading", "anchor", "content"]) {
			expect(Object.keys(JSON.parse(line) as object)).not.toContain(banned);
		}
	});

	it("recordCounts reads only the two lengths, and a missing record counts as zero", () => {
		expect(recordCounts({ folds: [1, 2, 3], dormant: [] })).toEqual({ folds: 3, dormant: 0 });
		expect(recordCounts(undefined)).toEqual({ folds: 0, dormant: 0 });
		expect(recordCounts(null)).toEqual({ folds: 0, dormant: 0 });
	});

	it("diagnosticEntry defaults diskLen to -1 (no disk read)", () => {
		const built = diagnosticEntry({
			path: "a.md",
			pass: "open",
			outcome: "applied",
			editorLen: 4,
			before: { folds: 0, dormant: 0 },
			after: { folds: 0, dormant: 0 },
		});
		expect(built.diskLen).toBe(-1);
		expect(Object.keys(built).sort()).toEqual(DIAGNOSTIC_LOG_FIELDS.filter((k) => k !== "t").sort());
	});
});

describe("buildLogLine: escaping keeps one physical line", () => {
	it.each([
		["unicode", "Notes/日本語 – café 🙂.md"],
		["spaces", "My Notes/a  b .md"],
		["quotes", 'Notes/"quoted" \'single\'.md'],
		["newlines", "Notes/line\nbreak\r\nhere.md"],
		["backslashes", "Notes\\win\\path.md"],
		["line separators", "Notes/a\u2028b\u2029c.md"],
	])("a path with %s round-trips and stays on one line", (_label, path) => {
		const line = buildLogLine(entry({ path }), T) as string;
		expect(line.split("\n")).toHaveLength(1);
		expect(line).not.toMatch(/[\r\u2028\u2029]/);
		expect((JSON.parse(line) as { path: string }).path).toBe(path);
		expect(logLines(`${line}\n${line}\n`)).toHaveLength(2);
	});
});

describe("the cap (F4, E16)", () => {
	const lines = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `{"n":${from + i}}`);
	const NEW = '{"new":true}';

	it(`the cap is ${DIAGNOSTIC_LOG_MAX_LINES} lines`, () => {
		expect(DIAGNOSTIC_LOG_MAX_LINES).toBe(1000);
	});

	it.each([
		{ existing: 0, expectedLen: 1, firstDropped: false },
		{ existing: 1, expectedLen: 2, firstDropped: false },
		{ existing: 999, expectedLen: 1000, firstDropped: false },
		{ existing: 1000, expectedLen: 1000, firstDropped: true },
		{ existing: 1500, expectedLen: 1000, firstDropped: true },
	])("appending one line to $existing lines leaves $expectedLen, newest last, oldest dropped first", ({ existing, expectedLen, firstDropped }) => {
		const text = lines(existing).map((l) => `${l}\n`).join("");
		const out = logLines(appendLogLine(text, NEW));
		expect(out).toHaveLength(expectedLen);
		expect(out[out.length - 1]).toBe(NEW);
		if (existing > 0) {
			// The survivors are the newest existing lines, in order.
			const kept = out.slice(0, -1);
			expect(kept).toEqual(lines(existing).slice(existing - kept.length));
			expect(out.includes(lines(existing)[0])).toBe(!firstDropped);
		}
	});

	it("an over-cap file on load is trimmed to the newest 1,000 lines", () => {
		const text = lines(1500).map((l) => `${l}\n`).join("");
		const trimmed = logLines(trimLogText(text));
		expect(trimmed).toHaveLength(1000);
		expect(trimmed[0]).toBe('{"n":500}');
		expect(trimmed[999]).toBe('{"n":1499}');
	});

	it("a file within the cap is returned as it is, so it is never rewritten", () => {
		const text = lines(1000).map((l) => `${l}\n`).join("");
		expect(trimLogText(text)).toBe(text);
		expect(trimLogText("")).toBe("");
		expect(trimLogText("no newline")).toBe("no newline");
	});

	it("capLines honours a smaller max", () => {
		expect(capLines(["a", "b", "c"], 2)).toEqual(["b", "c"]);
		expect(capLines(["a"], 2)).toEqual(["a"]);
	});

	it("corrupt and truncated lines are kept as they are: the cap counts lines and never parses them", () => {
		const text = 'not json\n{"half":\n{"ok":1}\n{"trunc';
		const out = logLines(appendLogLine(text, NEW));
		expect(out).toEqual(['not json', '{"half":', '{"ok":1}', '{"trunc', NEW]);
		expect(() => logLines(text)).not.toThrow();
		expect(() => trimLogText(text)).not.toThrow();
	});
});

describe("recordChanged / reportDiagnostic", () => {
	const base = { contentHash: "h", folds: [{ a: 1 }], dormant: [] as unknown[] };

	it("sees a changed hash, folds or dormant, and nothing else", () => {
		expect(recordChanged(base, { ...base, folds: [{ a: 1 }] })).toBe(false);
		expect(recordChanged(base, { ...base, contentHash: "h2" })).toBe(true);
		expect(recordChanged(base, { ...base, folds: [] })).toBe(true);
		expect(recordChanged(base, { ...base, dormant: [{ a: 1 }] })).toBe(true);
	});

	it("reportDiagnostic passes the entry to the sink, ignores a missing sink and swallows a throwing one", () => {
		const seen: DiagnosticEntry[] = [];
		reportDiagnostic((e) => seen.push(e), entry());
		expect(seen).toEqual([entry()]);
		expect(() => reportDiagnostic(undefined, entry())).not.toThrow();
		expect(() =>
			reportDiagnostic(() => {
				throw new Error("sink exploded");
			}, entry()),
		).not.toThrow();
	});
});
