/**
 * The embed restore's diagnostic log lines (ticket warkworth-46, PR-1, GP6, F4): an `embed` line
 * is logged only when a pass changes an embed's stored record, its `path` is the host's, and it
 * carries counts only. Same rig as embed-source-edit.test.ts: a real restorer and recorder over
 * the mocked Obsidian app, with the log sink either collecting entries or going through the real
 * writer into the fake in-memory adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbedFoldRestorer } from "../../src/embed-fold-restorer";
import { DIAGNOSTIC_LOG_FIELDS, logLines, type DiagnosticEntry } from "../../src/diagnostic-log";
import { DiagnosticLogWriter } from "../../src/diagnostic-log-writer";
import { MemoryAdapter } from "../mocks/obsidian";
import { LESSONS_NOTE, LESSONS_TEXT, SOURCE, SOURCE_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";
import type { Mode, RenderedHost } from "../fixtures/embed-recording-world";
import { attachRestorer, foldedRows, settleRestore } from "../fixtures/embed-restore-world";

const ROCKETSHIP = "Salesforce Tech Test Rocketship Course.md";
const HOST_TEXT = ["![[Competitive Coding Fundamentals#^0169a6]]", "", "![[Lessons]]", "", "![[Competitive Coding Fundamentals#^bbb222]]", ""].join("\n");
const LESSON_8_LINE = "- [ ] Lesson 8: Collections and frequency counting ^0169a6";
const REVISED = "- [ ] Lesson 8 (revised): Collections and frequency counting ^0169a6";
const MODES: Mode[] = ["live-preview", "reading-view"];

interface Rig {
	w: World;
	restorer: EmbedFoldRestorer;
}
const rigs: Rig[] = [];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const { w, restorer } of rigs.splice(0)) {
		restorer.dispose();
		w.recorder.dispose();
	}
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function rig(diagnosticLog: (entry: DiagnosticEntry) => void): Rig {
	const w = new World();
	w.addNote(SOURCE, SOURCE_TEXT);
	w.addNote(LESSONS_NOTE, LESSONS_TEXT);
	const restorer = attachRestorer(w, { diagnosticLog });
	const made = { w, restorer };
	rigs.push(made);
	return made;
}

async function openAndFold(r: Rig, mode: Mode): Promise<RenderedHost> {
	const host = r.w.addHost(ROCKETSHIP, mode, HOST_TEXT);
	await settleRestore(r.w, r.restorer);
	r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
	await r.w.settle();
	await vi.advanceTimersByTimeAsync(150);
	return host;
}

function editSource(r: Rig, host: RenderedHost, text: string): void {
	r.w.addNote(SOURCE, text);
	for (const embed of host.embeds) if ((embed.getAttribute("src") ?? "").startsWith(SOURCE.replace(/\.md$/, ""))) r.w.rerender(embed, host.path);
}

describe.each(MODES)("%s host: the embed restore logs only when it changes stored data", (mode) => {
	it("opening and re-rendering an embed whose slice is unchanged logs nothing", async () => {
		const entries: DiagnosticEntry[] = [];
		const r = rig((e) => entries.push(e));
		const host = await openAndFold(r, mode);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);

		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);

		expect(entries).toEqual([]);
	});

	it("a source edit that is re-matched logs one `embed` line whose path is the host's", async () => {
		const entries: DiagnosticEntry[] = [];
		const r = rig((e) => entries.push(e));
		const host = await openAndFold(r, mode);

		editSource(r, host, SOURCE_TEXT.replace(LESSON_8_LINE, REVISED));
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual(["Lesson 8 (revised): Collections and frequency counting"]);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toEqual({
			path: ROCKETSHIP, // the host, not the embedded note
			pass: "embed",
			editorLen: HOST_TEXT.length,
			diskLen: -1,
			foldsBefore: 1,
			dormantBefore: 0,
			foldsAfter: 1,
			dormantAfter: 0,
			outcome: "rematched",
		});
	});

	it("through the real writer the line has exactly the field list and no note, heading or anchor text", async () => {
		const adapter = new MemoryAdapter();
		const writer = new DiagnosticLogWriter(adapter, "plugin-dir", { now: () => new Date("2026-10-28T10:00:00.000Z") });
		const r = rig((e) => writer.log(e));
		const host = await openAndFold(r, mode);

		editSource(r, host, SOURCE_TEXT.replace(LESSON_8_LINE, REVISED));
		await settleRestore(r.w, r.restorer);
		await vi.advanceTimersByTimeAsync(0);
		await writer.drain();

		const raw = adapter.files.get("plugin-dir/diagnostic-log.jsonl") as string;
		const lines = logLines(raw);
		expect(lines).toHaveLength(1);
		expect(Object.keys(JSON.parse(lines[0]) as object)).toEqual([...DIAGNOSTIC_LOG_FIELDS]);
		for (const secret of ["Lesson", "lesson", "Collections", "collections", "0169a6", "Competitive"]) expect(raw).not.toContain(secret);
	});

	it("E16: a log sink that throws does not stop the restore or the record refresh", async () => {
		const r = rig(() => {
			throw new Error("sink exploded");
		});
		const host = await openAndFold(r, mode);

		editSource(r, host, SOURCE_TEXT.replace(LESSON_8_LINE, REVISED));
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual(["Lesson 8 (revised): Collections and frequency counting"]);
		expect(r.w.store.embedRecords()[0].folds.map((f) => f.text)).toEqual(["lesson 8 (revised): collections and frequency counting ^0169a6"]);
	});
});
