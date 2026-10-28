/**
 * Warkworth-46 PR-3 (E19): the embed passes do not judge a note that read as "" while its file is
 * not empty. Over the same mocked world as embed-dormancy.test.ts: a real FoldStore, the real
 * restorer and the real EmbedDormancyTracker. `disk` stands in for `adapter.read` + `adapter.stat`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedDormancyTracker } from "../../src/embed-dormancy";
import type { EmbedFoldRestorer } from "../../src/embed-fold-restorer";
import type { DiagnosticEntry } from "../../src/diagnostic-log";
import { LESSONS_NOTE, LESSONS_TEXT, SOURCE, SOURCE_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";
import type { RenderedHost } from "../fixtures/embed-recording-world";
import { attachRestorer, foldedRows, settleRestore } from "../fixtures/embed-restore-world";

const HOST = "Salesforce Tech Test Rocketship Course.md";
const LESSON_8 = "![[Competitive Coding Fundamentals#^0169a6]]";

interface Rig {
	w: World;
	restorer: EmbedFoldRestorer;
	/** What `readNote` returns per path; a path missing here is read through the world's vault. */
	reads: Map<string, string>;
	/** What the disk really holds per path (what `confirmEmpty` consults). */
	disk: Map<string, string>;
	log: DiagnosticEntry[];
	confirmCalls: string[];
	failDisk: { value: boolean };
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

function rig(): Rig {
	const w = new World();
	w.addNote(SOURCE, SOURCE_TEXT);
	w.addNote(LESSONS_NOTE, LESSONS_TEXT);
	const reads = new Map<string, string>();
	const disk = new Map<string, string>([
		[SOURCE, SOURCE_TEXT],
		[LESSONS_NOTE, LESSONS_TEXT],
	]);
	const log: DiagnosticEntry[] = [];
	const confirmCalls: string[] = [];
	const failDisk = { value: false };
	const readNote = async (path: string): Promise<string | null> => {
		const forced = reads.get(path);
		if (forced !== undefined) return forced;
		const file = w.app.vault.getFileByPath(path);
		return file === null ? null : await w.app.vault.cachedRead(file);
	};
	const confirmEmpty = async (path: string): Promise<boolean> => {
		confirmCalls.push(path);
		if (failDisk.value) throw new Error("EIO");
		return (disk.get(path) ?? "") === "";
	};
	const resolveLink = (linktext: string, sourcePath: string): string | null => w.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null;
	const diagnosticLog = (entry: DiagnosticEntry): void => void log.push(entry);
	const dormancy = new EmbedDormancyTracker({ store: w.store, readNote, resolveLink: (t) => resolveLink(t, HOST), confirmEmpty, diagnosticLog });
	const restorer = attachRestorer(w, { dormancy, confirmEmpty, diagnosticLog });
	const made = { w, restorer, reads, disk, log, confirmCalls, failDisk };
	rigs.push(made);
	return made;
}

async function openAndFold(r: Rig): Promise<RenderedHost> {
	const host = r.w.addHost(HOST, "live-preview", `${LESSON_8}\n`);
	await settleRestore(r.w, r.restorer);
	r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
	await r.w.settle();
	await vi.advanceTimersByTimeAsync(150);
	return host;
}

const records = (r: Rig) => r.w.store.embedRecords().filter((rec) => rec.host === HOST);
const embedLines = (r: Rig) => r.log.filter((l) => l.pass === "embed");

describe("the embed passes behind the load guard (PR-3, E19)", () => {
	it("a target note that reads as \"\" while its file is not empty is not judged: no record goes dormant, the fold stays, one refused-empty line", async () => {
		const r = rig();
		const host = await openAndFold(r);
		const before = JSON.stringify(records(r));
		expect(records(r)).toHaveLength(1);

		r.reads.set(SOURCE, ""); // the cache has not loaded the target yet; the disk still holds it
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);

		expect(JSON.stringify(records(r))).toBe(before); // not stamped dormant, not rewritten
		expect("dormantSince" in records(r)[0]).toBe(false);
		// One line per look at the host (the render pass and its second look), nothing else.
		expect(new Set(embedLines(r).map((l) => l.outcome))).toEqual(new Set(["refused-empty"]));
		expect(embedLines(r).length).toBeLessThanOrEqual(2);
		expect(embedLines(r)[0]).toMatchObject({ path: HOST, foldsBefore: 1, foldsAfter: 1 });
		expect(r.confirmCalls).toContain(SOURCE);

		// The target loads: the next render restores as normal.
		r.reads.delete(SOURCE);
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect(JSON.stringify(records(r))).toBe(before);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);
	});

	it("a target that really is empty on disk is still a broken embed and goes dormant (E6)", async () => {
		const r = rig();
		const host = await openAndFold(r);
		r.reads.set(SOURCE, "");
		r.disk.set(SOURCE, "");
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect(records(r)[0].dormantSince).toBeTypeOf("number");
		expect(embedLines(r)).toEqual([]);
	});

	it("a disk that cannot be read is read-failed: nothing is stamped dormant", async () => {
		const r = rig();
		const host = await openAndFold(r);
		const before = JSON.stringify(records(r));
		r.reads.set(SOURCE, "");
		r.failDisk.value = true;
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect(JSON.stringify(records(r))).toBe(before);
		expect(new Set(embedLines(r).map((l) => l.outcome))).toEqual(new Set(["read-failed"]));
	});

	it("a host that reads as \"\" while its file is not empty reconciles nothing and rewrites nothing, then is looked at again", async () => {
		const r = rig();
		const host = await openAndFold(r);
		const before = JSON.stringify(records(r));
		r.disk.set(HOST, `${LESSON_8}\n`);

		host.view.data = ""; // the host's own text has not loaded: the link is "absent" only because of that
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect(JSON.stringify(records(r))).toBe(before);
		expect(embedLines(r).map((l) => l.outcome)).toEqual(["refused-empty"]);

		// Time passes, still not loaded: the host is looked at again, but the log keeps to one line.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(JSON.stringify(records(r))).toBe(before);
		expect(embedLines(r)).toHaveLength(1);
		expect(r.confirmCalls.filter((p) => p === HOST).length).toBeGreaterThan(1);

		// The host loads: the second look restores the fold.
		host.view.data = `${LESSON_8}\n`;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(JSON.stringify(records(r))).toBe(before);
	});

	it("the log holds no note text", async () => {
		const r = rig();
		const host = await openAndFold(r);
		r.reads.set(SOURCE, "");
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		const raw = JSON.stringify(r.log);
		expect(raw).not.toBe("[]");
		for (const secret of ["Lesson 8", "Collections", "0169a6"]) expect(raw).not.toContain(secret);
	});
});
