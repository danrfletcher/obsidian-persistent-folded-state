/**
 * An embed whose source note changed (ticket warkworth-21, PR-6: G3, G4, E2, E3, E5, F2, F6, F7).
 * A host with several embeds on a jsdom DOM shaped as the real-Obsidian probe recorded it, over the
 * mocked Obsidian app (tests/mocks/obsidian.ts), a real FoldStore, the real recorder and the real
 * restorer. The folds are made the way Dan makes them (a trusted click, recorded by the recorder);
 * a source edit is the new text put in the vault plus the embed re-rendering from it, which is
 * what Obsidian does on a modify (docs/embed-probe.md: one render burst, element not replaced).
 * Fake timers drive the 150 ms render window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbedFoldRestorer } from "../../src/embed-fold-restorer";
import { sliceEmbed } from "../../src/embed-slice";
import { FoldStore } from "../../src/fold-store";
import * as similarityModule from "../../src/similarity";
import { LESSONS_NOTE, LESSONS_TEXT, SOURCE, SOURCE_TEXT, World, arrowFor, ownArrows } from "../fixtures/embed-recording-world";
import type { Mode, RenderedHost } from "../fixtures/embed-recording-world";
import { attachRestorer, drain, foldedRows, settleRestore } from "../fixtures/embed-restore-world";

const ROCKETSHIP = "Salesforce Tech Test Rocketship Course.md";
const HOST_TEXT = ["![[Competitive Coding Fundamentals#^0169a6]]", "", "![[Lessons]]", "", "![[Competitive Coding Fundamentals#^bbb222]]", ""].join("\n");
const LESSON_8_LINE = "- [ ] Lesson 8: Collections and frequency counting ^0169a6";
const MODES: Mode[] = ["live-preview", "reading-view"];

interface Rig {
	w: World;
	restorer: EmbedFoldRestorer;
	reads: string[];
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

function rig(restorerOverrides: Parameters<typeof attachRestorer>[1] = {}): Rig {
	const w = new World();
	w.addNote(SOURCE, SOURCE_TEXT);
	w.addNote(LESSONS_NOTE, LESSONS_TEXT);
	const reads: string[] = [];
	const restorer = attachRestorer(w, {
		readNote: async (path) => {
			reads.push(path);
			const file = w.app.vault.getFileByPath(path);
			return file === null ? null : await w.app.vault.cachedRead(file);
		},
		...restorerOverrides,
	});
	const made = { w, restorer, reads };
	rigs.push(made);
	return made;
}

/** Opens the host, lets the embeds render and restore, folds Lesson 8 in the first embed and waits
 * for the recording to reach the store. */
async function openAndFold(r: Rig, mode: Mode): Promise<RenderedHost> {
	const host = r.w.addHost(ROCKETSHIP, mode, HOST_TEXT);
	await settleRestore(r.w, r.restorer);
	r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
	await r.w.settle();
	await vi.advanceTimersByTimeAsync(150);
	return host;
}

/** The source note is edited: the vault has the new text and every embed of it re-renders. */
function editSource(r: Rig, host: RenderedHost, mode: Mode, text: string, path = SOURCE): void {
	r.w.addNote(path, text);
	for (const embed of host.embeds) if ((embed.getAttribute("src") ?? "").startsWith(path.replace(/\.md$/, ""))) r.w.rerender(embed, host.path);
	void mode;
}

const sliceHashOf = (text: string, subpath: string): string => sliceEmbed(text, subpath)?.hash ?? "";
const recordOf = (r: Rig) => r.w.store.embedRecords()[0];

describe.each(MODES)("%s host: G4, the source is edited while an embed of it is visible", (mode) => {
	it("the embed re-renders expanded and, once the render settles, Lesson 8 is folded again", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);

		const edited = SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Lesson 8 (revised): Collections and frequency counting ^0169a6");
		editSource(r, host, mode, edited);
		expect(foldedRows(host.embeds[0])).toEqual([]); // just re-rendered: nothing folded yet

		await vi.advanceTimersByTimeAsync(100); // inside the 150 ms window: still waiting
		expect(foldedRows(host.embeds[0])).toEqual([]);
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual(["Lesson 8 (revised): Collections and frequency counting"]);
		// An unfolded sibling in the same embed (its sub-tasks) is not folded by the re-render.
		expect(ownArrows(host.embeds[0]).filter((a) => a.classList.contains("is-collapsed"))).toHaveLength(1);
	});

	it("after the re-match the record holds the new anchor and the new slice's hash, so a second edit matches against the latest state", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const oldHash = recordOf(r).contentHash;
		expect(oldHash).toBe(sliceHashOf(SOURCE_TEXT, "^0169a6"));

		const v2 = SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Lesson 8 (revised): Collections and frequency counting ^0169a6");
		editSource(r, host, mode, v2);
		await settleRestore(r.w, r.restorer);
		expect(recordOf(r).contentHash).toBe(sliceHashOf(v2, "^0169a6"));
		expect(recordOf(r).folds.map((f) => f.text)).toEqual(["lesson 8 (revised): collections and frequency counting ^0169a6"]);

		const v3 = v2.replace("Lesson 8 (revised):", "Lesson 8 (revised again):");
		editSource(r, host, mode, v3);
		await settleRestore(r.w, r.restorer);
		expect(foldedRows(host.embeds[0])).toEqual(["Lesson 8 (revised again): Collections and frequency counting"]);
		expect(recordOf(r).folds.map((f) => f.text)).toEqual(["lesson 8 (revised again): collections and frequency counting ^0169a6"]);
		expect(recordOf(r).contentHash).toBe(sliceHashOf(v3, "^0169a6"));
		expect(r.w.store.embedSize).toBe(1);
	});

	it("the refreshed record is flushed to disk by the store's own 150 ms timer, which is not the render window", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const savedBefore = r.w.saved.length;

		editSource(r, host, mode, SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Lesson 8 (revised): Collections and frequency counting ^0169a6"));
		await vi.advanceTimersByTimeAsync(0);
		await r.restorer.whenIdle();
		await vi.advanceTimersByTimeAsync(149); // render window not yet over: no pass, no write
		expect(r.w.saved.length).toBe(savedBefore);
		await vi.advanceTimersByTimeAsync(1); // the window closes, the pass writes to the store
		await drain(r.w, r.restorer);
		expect(r.w.saved.length).toBe(savedBefore); // …and the store's flush is a timer of its own
		await vi.advanceTimersByTimeAsync(150);
		expect(r.w.saved.length).toBe(savedBefore + 1);
		const onDisk = r.w.saved[r.w.saved.length - 1] as { embeds: { folds: { text: string }[] }[] };
		expect(onDisk.embeds[0].folds.map((f) => f.text)).toEqual(["lesson 8 (revised): collections and frequency counting ^0169a6"]);
	});
});

describe.each(MODES)("%s host: E5, two quick source edits make one re-match from the last settled text", (mode) => {
	it("two edits 100 ms apart: one pass, matched against the second text", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		r.reads.length = 0;
		const similarity = vi.spyOn(similarityModule, "similarity");

		const first = SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Lesson 8 (first draft): Collections and frequency counting ^0169a6");
		const second = SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Lesson 8 (second draft): Collections and frequency counting ^0169a6");
		editSource(r, host, mode, first);
		await vi.advanceTimersByTimeAsync(100);
		expect(r.reads).toEqual([]); // the window is still open: nothing has been read for either edit
		editSource(r, host, mode, second);
		await settleRestore(r.w, r.restorer);

		const readsForTwoEdits = r.reads.length;
		expect(similarity.mock.calls.every(([a, b]) => !String(a).includes("first draft") && !String(b).includes("first draft"))).toBe(true);
		expect(foldedRows(host.embeds[0])).toEqual(["Lesson 8 (second draft): Collections and frequency counting"]);
		expect(recordOf(r).folds.map((f) => f.text)).toEqual(["lesson 8 (second draft): collections and frequency counting ^0169a6"]);

		// The same embed edited once does exactly as many reads: the second edit cost none.
		const single = rig();
		const singleHost = await openAndFold(single, mode);
		single.reads.length = 0;
		editSource(single, singleHost, mode, second);
		await settleRestore(single.w, single.restorer);
		expect(single.reads.length).toBeGreaterThan(0);
		expect(readsForTwoEdits).toBe(single.reads.length);
	});
});

describe.each(MODES)("%s host: a slice that did not change is not touched", (mode) => {
	it("an edit elsewhere in the target leaves the slice byte-identical: no matcher, no store write, no flush, no extra click", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const record = JSON.stringify(recordOf(r));
		const savedBefore = r.w.saved.length;
		const similarity = vi.spyOn(similarityModule, "similarity");
		const setEmbed = vi.spyOn(r.w.store, "setEmbed");

		// Lesson 9 is outside ^0169a6's block; so is the whole of the note's heading.
		const edited = SOURCE_TEXT.replace("Lesson 9: Graphs", "Lesson 9: Graphs and trees").replace("# Competitive Coding Fundamentals", "# Competitive Coding Fundamentals (2nd ed.)");
		expect(sliceHashOf(edited, "^0169a6")).toBe(sliceHashOf(SOURCE_TEXT, "^0169a6"));
		editSource(r, host, mode, edited);
		await settleRestore(r.w, r.restorer);
		await vi.advanceTimersByTimeAsync(500);

		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]); // re-applied from the stored set
		expect(similarity).not.toHaveBeenCalled();
		expect(setEmbed).not.toHaveBeenCalled();
		expect(JSON.stringify(recordOf(r))).toBe(record);
		expect(r.w.saved.length).toBe(savedBefore);
	});

	it("a pass over an embed that is already in the stored state clicks nothing", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const clicks = vi.fn();
		for (const arrow of ownArrows(host.embeds[0])) arrow.addEventListener("click", clicks);

		host.embeds[0].classList.remove("is-loaded"); // a render signal with the DOM unchanged
		host.embeds[0].classList.add("is-loaded");
		await settleRestore(r.w, r.restorer);

		expect(clicks).not.toHaveBeenCalled();
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);
	});
});

describe.each(MODES)("%s host: the slice is gone or empty", (mode) => {
	it("the target block no longer exists: nothing is folded and the stored state is left as it was", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const record = JSON.stringify(recordOf(r));
		const setEmbed = vi.spyOn(r.w.store, "setEmbed");
		const forgetEmbed = vi.spyOn(r.w.store, "forgetEmbed");

		editSource(r, host, mode, SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Lesson 8: Collections and frequency counting"));
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual([]);
		expect(JSON.stringify(recordOf(r))).toBe(record);
		expect(setEmbed).not.toHaveBeenCalled();
		expect(forgetEmbed).not.toHaveBeenCalled();
	});

	it("the whole source is emptied: nothing is folded and the stored state is left as it was", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const record = JSON.stringify(recordOf(r));

		editSource(r, host, mode, "");
		await settleRestore(r.w, r.restorer);

		expect(JSON.stringify(recordOf(r))).toBe(record);
		expect(ownArrows(host.embeds[0])).toHaveLength(0);
	});

	it("the edit leaves nothing the stored fold can be placed on: it stays unfolded, the fold goes dormant and nothing is added (F6, G14)", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const before = recordOf(r);

		editSource(r, host, mode, SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Zebra migration patterns ^0169a6"));
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual([]);
		// PR-7: the unplaced fold is kept, dormant, with the time it went dormant; no block is added.
		const after = recordOf(r);
		expect(after.folds).toEqual([]);
		expect(after.dormant).toHaveLength(1);
		expect(after.dormant[0]).toMatchObject({ ...before.folds[0], dormantSince: expect.any(Number) });
	});
});

describe.each(MODES)("%s host: E3, Dan's click while a source edit is being re-matched wins", (mode) => {
	it("a click made mid-match is the only thing recorded, and the refresh does not overwrite it", async () => {
		let onYield: () => Promise<void> = async () => undefined;
		const r = rig({
			matcherOptions: {
				chunkSize: 1,
				yieldToHost: async () => {
					await onYield();
				},
			},
		});
		const host = r.w.addHost(ROCKETSHIP, mode, "![[Lessons]]\n");
		await settleRestore(r.w, r.restorer);
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 3"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		expect(recordOf(r).folds.map((f) => f.text)).toEqual(["lesson 2: maps", "lesson 3: graphs"]);

		// The source is edited so that both stored folds need comparing; Lesson 2 is unfolded by Dan
		// while that comparing happens.
		r.w.addNote(LESSONS_NOTE, LESSONS_TEXT.replace("Lesson 2: Maps", "Lesson 2: Maps and sets").replace("Lesson 3: Graphs", "Lesson 3: Graphs and trees"));
		r.w.rerender(host.embeds[0], ROCKETSHIP);
		let clicked = false;
		onYield = async () => {
			if (clicked) return;
			clicked = true;
			// Obsidian restored Lesson 2 itself after the re-render, and Dan unfolds it.
			r.w.renderToggle(arrowFor(host.embeds[0], "Lesson 2"), true);
			r.w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
			await r.w.recorder.whenIdle();
		};
		const lesson2Clicks = vi.fn();
		arrowFor(host.embeds[0], "Lesson 2").addEventListener("click", lesson2Clicks);
		await settleRestore(r.w, r.restorer);

		expect(clicked).toBe(true);
		expect(lesson2Clicks).toHaveBeenCalledTimes(1); // only Dan's: the restore never folded it again
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 3"]);
		// His unfold is recorded; Lesson 3 follows the source; nothing else is in the record.
		expect(recordOf(r).folds.map((f) => f.text)).toEqual(["lesson 3: graphs and trees"]);
		expect(recordOf(r).contentHash).toBe(sliceHashOf(LESSONS_TEXT.replace("Lesson 2: Maps", "Lesson 2: Maps and sets").replace("Lesson 3: Graphs", "Lesson 3: Graphs and trees"), ""));
	});
});

describe.each(MODES)("%s host: the source is edited while the host is closed (GP6)", (mode) => {
	it("nothing runs while it is closed; the re-match happens when the host next renders the embed", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		host.view.containerEl.remove();
		await drain(r.w, r.restorer);
		const record = JSON.stringify(recordOf(r));
		r.reads.length = 0;
		const savedBefore = r.w.saved.length;

		// "git pull": the file on disk is rewritten, with the folded line renamed.
		r.w.addNote(SOURCE, SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Lesson 8 (revised): Collections and frequency counting ^0169a6"));
		await vi.advanceTimersByTimeAsync(5000);
		await drain(r.w, r.restorer);
		expect(r.reads).toEqual([]); // no note was read
		expect(JSON.stringify(recordOf(r))).toBe(record);
		expect(r.w.saved.length).toBe(savedBefore);

		const reopened = r.w.addHost(ROCKETSHIP, mode, HOST_TEXT);
		await settleRestore(r.w, r.restorer);
		expect(foldedRows(reopened.embeds[0])).toEqual(["Lesson 8 (revised): Collections and frequency counting"]);
		expect(ownArrows(reopened.embeds[0]).filter((a) => a.classList.contains("is-collapsed"))).toHaveLength(1); // its sibling is unfolded
		expect(recordOf(r).folds.map((f) => f.text)).toEqual(["lesson 8 (revised): collections and frequency counting ^0169a6"]);
	});
});

describe.each(MODES)("%s host: the fence holds through a source edit", (mode) => {
	it("F2/F7: the source note's own state is never read or changed, and no note is written", async () => {
		const r = rig();
		r.w.store.set(SOURCE, {
			contentHash: "note-hash",
			folds: [{ kind: "task", indent: 0, text: "lesson 7: sorting ^aaa111", siblingIndex: 0, parentChain: [] }],
			dormant: [],
		});
		const host = await openAndFold(r, mode);
		const noteLevel = JSON.stringify(r.w.store.get(SOURCE));
		const get = vi.spyOn(FoldStore.prototype, "get");
		const hostBefore = await r.w.app.vault.cachedRead(r.w.app.vault.getFileByPath(ROCKETSHIP) as never);

		const edited = SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Lesson 8 (revised): Collections and frequency counting ^0169a6");
		editSource(r, host, mode, edited);
		await settleRestore(r.w, r.restorer);

		expect(get).not.toHaveBeenCalled(); // the restore never reads a note's own state
		expect(JSON.stringify(r.w.store.get(SOURCE))).toBe(noteLevel);
		expect(await r.w.app.vault.cachedRead(r.w.app.vault.getFileByPath(SOURCE) as never)).toBe(edited);
		expect(await r.w.app.vault.cachedRead(r.w.app.vault.getFileByPath(ROCKETSHIP) as never)).toBe(hostBefore);
		expect(r.w.app.vault).not.toHaveProperty("modify");
	});

	it("F6/G16: a re-render never folds a block with no stored fold", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		editSource(r, host, mode, SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Lesson 8 (revised): Collections and frequency counting ^0169a6"));
		await settleRestore(r.w, r.restorer);
		// Only the first embed has a record; the other embeds of the same note show no folds.
		expect(foldedRows(host.embeds[2])).toEqual([]);
		expect(foldedRows(host.embeds[1])).toEqual([]);
		expect(r.w.store.embedSize).toBe(1);
	});

	it("F1: the re-match adds no element, class or control to the page", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		editSource(r, host, mode, SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Lesson 8 (revised): Collections and frequency counting ^0169a6"));
		const count = document.body.querySelectorAll("*").length;
		const classes = new Set(Array.from(document.body.querySelectorAll("*")).flatMap((e) => Array.from(e.classList)));
		await settleRestore(r.w, r.restorer);
		expect(document.body.querySelectorAll("*").length).toBe(count);
		const after = new Set(Array.from(document.body.querySelectorAll("*")).flatMap((e) => Array.from(e.classList)));
		expect([...after].filter((c) => !classes.has(c))).toEqual(["is-collapsed"]); // only the fold state Obsidian's own arrows carry
	});
});
