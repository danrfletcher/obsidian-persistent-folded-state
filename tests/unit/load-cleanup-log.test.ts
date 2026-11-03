/**
 * Warkworth-46 PR-4 (E14, F4): the load-time cleanup writes one diagnostic line per cleaned record,
 * with pass `load-cleanup`, outcome `cleaned`, the path and the four counts, and no anchor text.
 * The diagnostic writer is replaced by a fake sink; `DiagnosticLogWriter` itself is covered by
 * tests/unit/diagnostic-log-writer.test.ts, and the line it builds from an entry is checked here
 * through `buildLogLine`.
 */
import { describe, expect, it, vi } from "vitest";
import { FoldStore, STORE_VERSION } from "../../src/fold-store";
import { DIAGNOSTIC_LOG_FIELDS, buildLogLine, type DiagnosticEntry } from "../../src/diagnostic-log";

const SECRET_TEXT = "ZEBRA-SECRET lesson text";
const anchor = (text: string, siblingIndex: number) => ({ kind: "task", indent: 0, text, siblingIndex, parentChain: [] });
const A = anchor(SECRET_TEXT, 0);
const B = anchor("another-secret heading", 1);
const C = anchor("third-secret", 2);
const NOW = 100_000;

function openWith(data: unknown, diagnosticLog: (entry: DiagnosticEntry) => void, now = NOW) {
	const saveData = vi.fn(async (_data: unknown) => undefined);
	const store = new FoldStore({ loadData: async () => data, saveData, now: () => now, diagnosticLog });
	return { store, saveData };
}

describe("FoldStore.load: the load-cleanup log line (E14, F4)", () => {
	it("a cleaned note writes exactly one line with the exact fields", async () => {
		const lines: DiagnosticEntry[] = [];
		const { store } = openWith(
			{ version: STORE_VERSION, files: { "Notes/Lesson.md": { contentHash: "abc", folds: [A, B], dormant: [{ ...A, dormantSince: NOW - 1 }, { ...C, dormantSince: NOW - 2 }] } } },
			(entry) => lines.push(entry),
		);
		await store.load();
		expect(lines).toEqual([
			{ path: "Notes/Lesson.md", pass: "load-cleanup", editorLen: -1, diskLen: -1, foldsBefore: 2, dormantBefore: 2, foldsAfter: 2, dormantAfter: 1, outcome: "cleaned" },
		]);
	});

	it("the built line has exactly the log's field set, and no anchor text anywhere in it", async () => {
		const lines: DiagnosticEntry[] = [];
		const { store } = openWith(
			{ version: STORE_VERSION, files: { "Notes/Lesson.md": { contentHash: "abc", folds: [A, B], dormant: [{ ...A, dormantSince: NOW - 1 }, { ...C, dormantSince: NOW - 2 }] } } },
			(entry) => lines.push(entry),
		);
		await store.load();
		const line = buildLogLine(lines[0], new Date(NOW));
		expect(line).not.toBeNull();
		expect(Object.keys(JSON.parse(line as string))).toEqual([...DIAGNOSTIC_LOG_FIELDS]);
		for (const text of [SECRET_TEXT, "another-secret", "third-secret", "ZEBRA"]) expect(line).not.toContain(text);
		expect(Object.keys(lines[0]).sort()).toEqual(DIAGNOSTIC_LOG_FIELDS.filter((f) => f !== "t").sort());
		expect(JSON.stringify(lines)).not.toContain("ZEBRA");
	});

	it("one line per cleaned record, a clean neighbour writes none", async () => {
		const lines: DiagnosticEntry[] = [];
		const { store } = openWith(
			{
				version: STORE_VERSION,
				files: {
					"A.md": { contentHash: "a", folds: [A], dormant: [{ ...A, dormantSince: NOW }] },
					"B.md": { contentHash: "b", folds: [B], dormant: [{ ...C, dormantSince: NOW }] },
					"C.md": { contentHash: "c", folds: [A, B], dormant: [{ ...A, dormantSince: NOW }, { ...B, dormantSince: NOW }] },
				},
			},
			(entry) => lines.push(entry),
		);
		await store.load();
		expect(lines.map((l) => [l.path, l.foldsBefore, l.dormantBefore, l.foldsAfter, l.dormantAfter])).toEqual([
			["A.md", 1, 1, 1, 0],
			["C.md", 2, 2, 2, 0],
		]);
		expect(lines.every((l) => l.pass === "load-cleanup" && l.outcome === "cleaned")).toBe(true);
	});

	it("a cleaned embed record logs its host path with the embed's own counts", async () => {
		const lines: DiagnosticEntry[] = [];
		const { store } = openWith(
			{
				version: STORE_VERSION,
				files: {},
				embeds: [{ host: "Host.md", target: "Source.md", subpath: "^a", occurrence: 0, contentHash: "h", folds: [A, B], dormant: [{ ...A, dormantSince: NOW }] }],
			},
			(entry) => lines.push(entry),
		);
		await store.load();
		expect(lines).toEqual([
			{ path: "Host.md", pass: "load-cleanup", editorLen: -1, diskLen: -1, foldsBefore: 2, dormantBefore: 1, foldsAfter: 2, dormantAfter: 0, outcome: "cleaned" },
		]);
	});

	it("an embed record that is cleaned and then dropped whole by expiry still logs, with after-counts 0/0", async () => {
		const lines: DiagnosticEntry[] = [];
		// A load a day after the Gone record was stamped dormant: far past the forget window.
		const LATER = NOW + 24 * 60 * 60 * 1000;
		const EXPIRED = NOW;
		const { store, saveData } = openWith(
			{
				version: STORE_VERSION,
				files: {},
				embeds: [
					// Overlap (A in both lists) and a whole-embed dormantSince far past the window.
					{ host: "Gone.md", target: "Source.md", subpath: "^a", occurrence: 0, contentHash: "h", dormantSince: EXPIRED, folds: [A, B], dormant: [{ ...A, dormantSince: LATER }] },
					// Overlap, still inside the window: kept, logged with its real after-counts.
					{ host: "Kept.md", target: "Source.md", subpath: "^b", occurrence: 0, contentHash: "h", folds: [A], dormant: [{ ...A, dormantSince: LATER }] },
				],
			},
			(entry) => lines.push(entry),
			LATER,
		);
		await store.load();
		expect(store.getEmbed({ host: "Gone.md", target: "Source.md", subpath: "^a", occurrence: 0 })).toBeUndefined();
		expect(lines).toEqual([
			{ path: "Gone.md", pass: "load-cleanup", editorLen: -1, diskLen: -1, foldsBefore: 2, dormantBefore: 1, foldsAfter: 0, dormantAfter: 0, outcome: "cleaned" },
			{ path: "Kept.md", pass: "load-cleanup", editorLen: -1, diskLen: -1, foldsBefore: 1, dormantBefore: 1, foldsAfter: 1, dormantAfter: 0, outcome: "cleaned" },
		]);
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("clean data writes no line", async () => {
		const sink = vi.fn();
		const { store, saveData } = openWith({ version: STORE_VERSION, files: { "A.md": { contentHash: "a", folds: [A], dormant: [{ ...C, dormantSince: NOW }] } } }, sink);
		await store.load();
		expect(sink).not.toHaveBeenCalled();
		expect(saveData).not.toHaveBeenCalled();
	});

	it("a sink that throws does not stop the load: the data is still cleaned and written", async () => {
		const sink = vi.fn(() => {
			throw new Error("log failed");
		});
		const { store, saveData } = openWith({ version: STORE_VERSION, files: { "A.md": { contentHash: "a", folds: [A], dormant: [{ ...A, dormantSince: NOW }] } } }, sink);
		await expect(store.load()).resolves.toBeUndefined();
		expect(sink).toHaveBeenCalledTimes(1);
		expect(store.get("A.md")?.dormant).toEqual([]);
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("a store with no diagnostic sink at all still cleans", async () => {
		const saveData = vi.fn(async (_data: unknown) => undefined);
		const store = new FoldStore({ loadData: async () => ({ version: STORE_VERSION, files: { "A.md": { contentHash: "a", folds: [A], dormant: [{ ...A, dormantSince: NOW }] } } }), saveData, now: () => NOW });
		await store.load();
		expect(store.get("A.md")?.dormant).toEqual([]);
		expect(saveData).toHaveBeenCalledTimes(1);
	});
});
