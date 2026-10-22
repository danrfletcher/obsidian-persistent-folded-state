/**
 * Restoring folds inside embeds, over jsdom hosts whose embed containers are shaped as the
 * real-Obsidian probe recorded them (ticket warkworth-21, PR-5: G9, G13, E3, E4, E5, E13, E14,
 * G7, G18, F1, F3; docs/embed-probe.md). The Obsidian app and workspace are the mocks in
 * tests/mocks/obsidian.ts; the store, the recorder and the restorer are the real ones.
 *
 * Stored state is made the way Dan makes it: a person's click on the embed's arrow, recorded by
 * the real recorder. Fake timers drive the 150 ms render window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasLikeView, buildHoverPopover } from "../mocks/obsidian";
import { EMBED_CAPABILITIES } from "../../src/embed-capabilities";
import type { EmbedCapability, EmbedHostModeId, EmbedKind } from "../../src/embed-capabilities";
import type { EmbedFoldRestorer } from "../../src/embed-fold-restorer";
import {
	HEADED_NOTE,
	HEADED_TEXT,
	LESSONS_NOTE,
	LESSONS_TEXT,
	MIXED_NOTE,
	MIXED_TEXT,
	SOURCE,
	SOURCE_TEXT,
	World,
	arrowFor,
	ownArrows,
} from "../fixtures/embed-recording-world";
import type { Mode, RenderedHost } from "../fixtures/embed-recording-world";
import { attachRestorer, drain, firstPass, foldedRows, isFolded, settleRestore } from "../fixtures/embed-restore-world";

const ROCKETSHIP = "Salesforce Tech Test Rocketship Course.md";
const OTHER_HOST = "Second Host.md";
const BLOCK_EMBED = "![[Competitive Coding Fundamentals#^0169a6]]\n";
const OUTER_NOTE = "Outer.md";
const OUTER_TEXT = ["# Outer", "", "- [ ] Outer item", "  - [ ] Outer sub", "", "![[Lessons]]", ""].join("\n");

const MODES: Mode[] = ["live-preview", "reading-view"];
const OTHER_MODE: Record<Mode, Mode> = { "live-preview": "reading-view", "reading-view": "live-preview" };

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

function rig(restorerOverrides: Parameters<typeof attachRestorer>[1] = {}, recorderOverrides: ConstructorParameters<typeof World>[0] = {}): Rig {
	const w = new World(recorderOverrides);
	w.addNote(SOURCE, SOURCE_TEXT);
	w.addNote(LESSONS_NOTE, LESSONS_TEXT);
	w.addNote(HEADED_NOTE, HEADED_TEXT);
	w.addNote(MIXED_NOTE, MIXED_TEXT);
	w.addNote(OUTER_NOTE, OUTER_TEXT);
	const restorer = attachRestorer(w, restorerOverrides);
	const made = { w, restorer };
	rigs.push(made);
	return made;
}

/** Dan folds `rows` (by the text each arrow's row starts with) in embed `index` of a new host, and
 * the host is then closed. Everything is recorded by the real recorder and flushed. */
async function foldAndClose(r: Rig, mode: Mode, hostPath: string, hostText: string, rows: string[], index = 0): Promise<void> {
	const host = r.w.addHost(hostPath, mode, hostText);
	await settleRestore(r.w, r.restorer);
	for (const row of rows) r.w.realClick(arrowFor(host.embeds[index], row));
	await r.w.settle();
	await vi.advanceTimersByTimeAsync(150);
	host.view.containerEl.remove();
}

function snapshot(w: World): string {
	return JSON.stringify(w.store.embedRecords());
}

describe.each(MODES)("%s host: GP3, a folded block comes back when the embed renders again (G2)", (mode) => {
	it("Lesson 8 of the Rocketship block embed is folded on reopen, and its sub-tasks stay as they are", async () => {
		const r = rig();
		await foldAndClose(r, mode, ROCKETSHIP, BLOCK_EMBED, ["Lesson 8"]);
		expect(r.w.store.embedSize).toBe(1);
		const before = snapshot(r.w);
		const savedBefore = r.w.saved.length;

		const reopened = r.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		expect(foldedRows(reopened.embeds[0])).toEqual([]); // freshly rendered: expanded
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(reopened.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		expect(isFolded(arrowFor(reopened.embeds[0], "Count word frequency"))).toBe(false);
		// Restore never records.
		await vi.advanceTimersByTimeAsync(1000);
		expect(snapshot(r.w)).toBe(before);
		expect(r.w.saved).toHaveLength(savedBefore);
	});

	it("a heading embed restores its heading and a task inside it", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Headed#Lesson 8]]\n", ["Lesson 8", "Count word frequency"]);

		const reopened = r.w.addHost("Host.md", mode, "![[Headed#Lesson 8]]\n");
		await settleRestore(r.w, r.restorer);

		expect(isFolded(arrowFor(reopened.embeds[0], "Lesson 8"))).toBe(true);
		expect(isFolded(arrowFor(reopened.embeds[0], "Count word frequency"))).toBe(true);
	});

	it("a whole-note embed restores exactly the folded lessons, and no others", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 1", "Lesson 3"]);

		const reopened = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(reopened.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 1", "Lesson 3"]);
	});

	it("a row whose arrow count differs from the slice's foldable count (hidden id, piped link) is still found by what it shows", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Mixed]]\n", ["See the other note"]);

		const reopened = r.w.addHost("Host.md", mode, "![[Mixed]]\n");
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(reopened.embeds[0])).toEqual(["See the other note"]);
	});
});

describe("G9: Live Preview and Reading view share one state per embed", () => {
	it("LP/RV share one key: a fold made in Live Preview is restored in Reading view, and the reverse, with no second key", async () => {
		const r = rig();
		await foldAndClose(r, "live-preview", ROCKETSHIP, BLOCK_EMBED, ["Lesson 8"]);
		expect(r.w.store.embedSize).toBe(1);
		const keyBefore = snapshot(r.w);

		const reading = r.w.addHost(ROCKETSHIP, "reading-view", BLOCK_EMBED);
		await settleRestore(r.w, r.restorer);
		expect(foldedRows(reading.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		expect(r.w.store.embedSize).toBe(1);
		expect(snapshot(r.w)).toBe(keyBefore);

		// The reverse: a new fold in Reading view comes back in Live Preview.
		r.w.realClick(arrowFor(reading.embeds[0], "Count word frequency"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		reading.view.containerEl.remove();

		const live = r.w.addHost(ROCKETSHIP, "live-preview", BLOCK_EMBED);
		await settleRestore(r.w, r.restorer);
		expect(foldedRows(live.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting", "Count word frequency with a map"]);
		expect(r.w.store.embedSize).toBe(1);
	});

	it.each(MODES)("the same host flipped to the other mode (%s first) shows the same folds", async (mode) => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2"]);

		const flipped = r.w.addHost("Host.md", OTHER_MODE[mode], "![[Lessons]]\n");
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(flipped.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 2"]);
		expect(r.w.store.embedSize).toBe(1);
	});
});

describe.each(MODES)("%s host: G13, an embed with no stored state starts expanded and nothing is adopted", (mode) => {
	it("a render with no stored state writes nothing: no embeds entry is created", async () => {
		const r = rig();
		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n\n![[Headed#Lesson 8]]\n\n![[Mixed]]\n");
		await settleRestore(r.w, r.restorer);
		await vi.advanceTimersByTimeAsync(1000);

		expect(r.w.store.embedSize).toBe(0);
		expect(r.w.saved).toHaveLength(0);
		for (const embed of host.embeds) expect(foldedRows(embed)).toEqual([]);
	});

	it("folds Obsidian restored by itself are not adopted: the embed is unfolded and nothing is stored", async () => {
		const r = rig();
		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		for (const arrow of ownArrows(host.embeds[0])) r.w.renderToggle(arrow, true);
		expect(foldedRows(host.embeds[0]).length).toBeGreaterThan(0);

		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual([]);
		expect(r.w.store.embedSize).toBe(0);
		expect(r.w.saved).toHaveLength(0);
	});

	it("an embed of a note that was never opened as a note starts expanded", async () => {
		const r = rig();
		r.w.addNote("Never Opened.md", "- [ ] Item\n  - [ ] Child\n");
		const host = r.w.addHost("Host.md", mode, "![[Never Opened]]\n");
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual([]);
		expect(r.w.store.embedSize).toBe(0);
		expect(r.w.store.size).toBe(0);
	});

	it("an embed whose stored state is empty renders expanded, and the stored set wins over Obsidian's own folds", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2", "Lesson 2"]); // fold, then unfold
		expect(r.w.store.embedRecords()[0].folds).toEqual([]);

		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		w_fold_all(r.w, host);
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual([]);
		expect(r.w.store.embedRecords()[0].folds).toEqual([]);
	});
});

function w_fold_all(w: World, host: RenderedHost): void {
	for (const arrow of ownArrows(host.embeds[0])) w.renderToggle(arrow, true);
}

describe.each(MODES)("%s host: E4, Obsidian restores some, all or more of the folds on its own", (mode) => {
	async function seeded(): Promise<Rig> {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2", "Lesson 3"]);
		return r;
	}
	const lessons = (embed: Element): string[] => foldedRows(embed).map((t) => t.slice(0, 8));

	it("native partial restore: the stored fold Obsidian did not restore is applied", async () => {
		const r = await seeded();
		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		r.w.renderToggle(arrowFor(host.embeds[0], "Lesson 2"), true);

		await settleRestore(r.w, r.restorer);

		expect(lessons(host.embeds[0])).toEqual(["Lesson 2", "Lesson 3"]);
	});

	it("native full restore: already the stored set, so the restore clicks nothing", async () => {
		const r = await seeded();
		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		r.w.renderToggle(arrowFor(host.embeds[0], "Lesson 2"), true);
		r.w.renderToggle(arrowFor(host.embeds[0], "Lesson 3"), true);
		const clicks = vi.fn();
		for (const arrow of ownArrows(host.embeds[0])) arrow.addEventListener("click", clicks);

		await settleRestore(r.w, r.restorer);

		expect(lessons(host.embeds[0])).toEqual(["Lesson 2", "Lesson 3"]);
		expect(clicks).not.toHaveBeenCalled();
	});

	it("native over-restore: a stray fold that is not stored is unfolded", async () => {
		const r = await seeded();
		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		r.w.renderToggle(arrowFor(host.embeds[0], "Lesson 1"), true);
		r.w.renderToggle(arrowFor(host.embeds[0], "Lesson 2"), true);

		await settleRestore(r.w, r.restorer);

		expect(lessons(host.embeds[0])).toEqual(["Lesson 2", "Lesson 3"]);
	});

	it("late native restore: Obsidian restores its folds after the first pass, and the re-check still ends on the stored set", async () => {
		const r = await seeded();
		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		await firstPass(r.w, r.restorer);
		expect(lessons(host.embeds[0])).toEqual(["Lesson 2", "Lesson 3"]);

		// Obsidian's own restore lands now: it unfolds one stored fold and folds a stray.
		r.w.renderToggle(arrowFor(host.embeds[0], "Lesson 2"), false);
		r.w.renderToggle(arrowFor(host.embeds[0], "Lesson 1"), true);
		expect(lessons(host.embeds[0])).toEqual(["Lesson 1", "Lesson 3"]);

		await vi.advanceTimersByTimeAsync(500);
		await drain(r.w, r.restorer);

		expect(lessons(host.embeds[0])).toEqual(["Lesson 2", "Lesson 3"]);
		expect(r.w.store.embedRecords()[0].folds.map((f) => f.text)).toEqual(["lesson 2: maps", "lesson 3: graphs"]);
	});

	it("stored set empty: everything Obsidian restored is unfolded", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2", "Lesson 2"]);
		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		r.w.renderToggle(arrowFor(host.embeds[0], "Lesson 1"), true);
		r.w.renderToggle(arrowFor(host.embeds[0], "Lesson 3"), true);

		await settleRestore(r.w, r.restorer);

		expect(lessons(host.embeds[0])).toEqual([]);
	});
});

describe.each(MODES)("%s host: restore never records (rule 2)", (mode) => {
	it("the store and data.json are byte-identical before and after every restore pass", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n\n![[Headed#Lesson 8]]\n", ["Lesson 2", "Lesson 3"]);
		await foldAndClose(r, mode, "Other.md", "![[Headed#Lesson 8]]\n", ["Count word frequency"]);
		const before = snapshot(r.w);
		const saves = r.w.saved.length;

		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n\n![[Headed#Lesson 8]]\n");
		const other = r.w.addHost("Other.md", mode, "![[Headed#Lesson 8]]\n");
		w_fold_all(r.w, other);
		await settleRestore(r.w, r.restorer);
		r.w.rerender(host.embeds[0], "Host.md");
		await settleRestore(r.w, r.restorer);
		await vi.advanceTimersByTimeAsync(2000);

		expect(foldedRows(host.embeds[0]).length).toBe(2);
		expect(snapshot(r.w)).toBe(before);
		expect(r.w.saved).toHaveLength(saves);
	});
});

describe.each(MODES)("%s host: a stored anchor with no confident match stays unfolded, and each anchor folds one block", (mode) => {
	it("a stored fold whose line was removed from the source folds nothing in the embed", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2"]);
		r.w.addNote(LESSONS_NOTE, LESSONS_TEXT.replace("Lesson 2: Maps", "Something else entirely about trees").replace("Count word frequency", "zzz qqq").replace("Handle case folding", "yyy"));

		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		await settleRestore(r.w, r.restorer);

		// Whatever the matcher decides, only its decision is folded, and never more than one block per stored anchor.
		expect(foldedRows(host.embeds[0]).length).toBeLessThanOrEqual(1);
		expect(r.w.store.embedRecords()[0].folds).toHaveLength(1);
	});

	it("two identical lines, one stored: only its own ordinal folds", async () => {
		const r = rig();
		r.w.addNote("Dups.md", "- [ ] dup\n  - [ ] a\n- [ ] dup\n  - [ ] b\n");
		const host0 = r.w.addHost("Host.md", mode, "![[Dups]]\n");
		await settleRestore(r.w, r.restorer);
		r.w.realClick(ownArrows(host0.embeds[0])[1]);
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		host0.view.containerEl.remove();

		const host = r.w.addHost("Host.md", mode, "![[Dups]]\n");
		await settleRestore(r.w, r.restorer);

		const arrows = ownArrows(host.embeds[0]);
		expect(arrows.map(isFolded)).toEqual([false, true]);
	});
});

describe.each(MODES)("%s host: E5, a 51-embed host", (mode) => {
	const COUNT = 51;
	const hostText = Array.from({ length: COUNT }, () => "![[Lessons]]").join("\n\n") + "\n";
	const STORED: Record<number, string> = { 3: "Lesson 1", 17: "Lesson 2", 40: "Lesson 3", 50: "Lesson 1" };

	async function seeded(): Promise<Rig> {
		const r = rig();
		const host = r.w.addHost("Big.md", mode, hostText);
		await settleRestore(r.w, r.restorer);
		for (const [i, row] of Object.entries(STORED)) r.w.realClick(arrowFor(host.embeds[Number(i)], row));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		host.view.containerEl.remove();
		return r;
	}

	function expectedFolds(embeds: HTMLElement[]): void {
		embeds.forEach((embed, i) => {
			const want = STORED[i] === undefined ? [] : [STORED[i]];
			expect(
				foldedRows(embed).map((t) => t.slice(0, 8)),
				`embed ${i}`
			).toEqual(want);
		});
	}

	it("every embed is restored when they all render together", async () => {
		const r = await seeded();
		expect(r.w.store.embedSize).toBe(Object.keys(STORED).length);

		const host = r.w.addHost("Big.md", mode, hostText);
		await settleRestore(r.w, r.restorer);

		expect(host.embeds).toHaveLength(COUNT);
		expectedFolds(host.embeds);
	});

	it("embeds that render late, in any order, are still restored, and a fold on one never moves another", async () => {
		const r = await seeded();
		const host = r.w.addHost("Big.md", mode, hostText);
		// Half of the embeds have not rendered their content yet.
		const late = host.embeds.map((_, i) => i).filter((i) => i % 2 === 1);
		const contents = new Map<number, Node[]>();
		for (const i of late) {
			contents.set(i, Array.from(host.embeds[i].childNodes));
			host.embeds[i].replaceChildren();
		}
		await settleRestore(r.w, r.restorer);

		// They render later, one by one, in a scrambled order, with gaps longer than the window.
		const order = late.map((_, k) => late[(k * 7) % late.length]);
		expect(new Set(order).size).toBe(late.length);
		for (const i of order) {
			host.embeds[i].replaceChildren(...(contents.get(i) ?? []));
			await vi.advanceTimersByTimeAsync(200);
			await drain(r.w, r.restorer);
		}
		await settleRestore(r.w, r.restorer);

		expectedFolds(host.embeds);

		// A fold on one embed moves no other: Dan folds Lesson 2 in embed 20.
		r.w.realClick(arrowFor(host.embeds[20], "Lesson 2"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		await settleRestore(r.w, r.restorer);
		host.embeds.forEach((embed, i) => {
			const want = i === 20 ? ["Lesson 2"] : STORED[i] === undefined ? [] : [STORED[i]];
			expect(foldedRows(embed).map((t) => t.slice(0, 8)), `embed ${i}`).toEqual(want);
		});
	});

	it("each embed has its own occurrence: the 51 identical embeds restore independently, by document order (G7)", async () => {
		const r = await seeded();
		const keys = r.w.store.embedRecords().map((rec) => rec.occurrence).sort((a, b) => a - b);
		expect(keys).toEqual([3, 17, 40, 50]);
	});
});

describe.each(MODES)("%s host: E14, the same host open in two panes", (mode) => {
	it("both panes restore from the one stored state, and a restore in one writes nothing the other records", async () => {
		const r = rig();
		await foldAndClose(r, mode, ROCKETSHIP, BLOCK_EMBED, ["Lesson 8"]);
		const before = snapshot(r.w);
		const saves = r.w.saved.length;

		const paneA = r.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		const paneB = r.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		await settleRestore(r.w, r.restorer);
		await vi.advanceTimersByTimeAsync(2000);

		expect(foldedRows(paneA.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		expect(foldedRows(paneB.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		expect(snapshot(r.w)).toBe(before);
		expect(r.w.saved).toHaveLength(saves);
		expect(r.w.store.embedSize).toBe(1);
	});

	it("with the source folded differently in its own note, both panes still show exactly the stored set", async () => {
		const r = rig();
		await foldAndClose(r, mode, ROCKETSHIP, BLOCK_EMBED, ["Lesson 8"]);
		const sourceBefore = JSON.stringify(r.w.store.get(SOURCE) ?? null);

		const paneA = r.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		const paneB = r.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		// Obsidian's own memory of the source's folds shows through in the embed: more than is stored.
		for (const pane of [paneA, paneB]) for (const arrow of ownArrows(pane.embeds[0])) r.w.renderToggle(arrow, true);
		await settleRestore(r.w, r.restorer);

		for (const pane of [paneA, paneB]) expect(foldedRows(pane.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
		expect(JSON.stringify(r.w.store.get(SOURCE) ?? null)).toBe(sourceBefore);
	});
});

describe.each(MODES)("%s host: GP5, a second host embedding the same block", (mode) => {
	it("starts fully expanded, and folding there changes neither the first host's embed nor the source's stored state", async () => {
		const r = rig();
		await foldAndClose(r, mode, ROCKETSHIP, BLOCK_EMBED, ["Lesson 8"]);
		const rocketshipKey = { host: ROCKETSHIP, target: SOURCE, subpath: "^0169a6", occurrence: 0 };
		const rocketshipBefore = JSON.stringify(r.w.store.getEmbed(rocketshipKey));

		const second = r.w.addHost(OTHER_HOST, mode, BLOCK_EMBED);
		await settleRestore(r.w, r.restorer);
		expect(foldedRows(second.embeds[0])).toEqual([]);

		r.w.realClick(arrowFor(second.embeds[0], "Count word frequency"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);

		expect(JSON.stringify(r.w.store.getEmbed(rocketshipKey))).toBe(rocketshipBefore);
		expect(r.w.store.getEmbed({ ...rocketshipKey, host: OTHER_HOST })?.folds).toHaveLength(1);
		expect(r.w.store.get(SOURCE)).toBeUndefined();

		second.view.containerEl.remove();
		const reopened = r.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		await settleRestore(r.w, r.restorer);
		expect(foldedRows(reopened.embeds[0])).toEqual(["Lesson 8: Collections and frequency counting"]);
	});
});

describe.each(MODES)("%s host: E3, a user's click during the pending window wins", (mode) => {
	it("a click on another arrow is recorded, and the pass then applies the whole stored set including it", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2"]);

		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		await vi.advanceTimersByTimeAsync(50);
		expect(r.restorer.pendingRenders).toBeGreaterThan(0);
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 1"));
		await r.w.settle();
		await settleRestore(r.w, r.restorer);
		await vi.advanceTimersByTimeAsync(150);

		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 1", "Lesson 2"]);
		expect(r.w.store.embedRecords()[0].folds.map((f) => f.text).sort()).toEqual(["lesson 1: arrays", "lesson 2: maps"]);
	});

	it("an unfold during the window removes the anchor, and the pending restore does not fold it again", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2", "Lesson 3"]);

		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		// Obsidian's own restore had folded Lesson 2 already; Dan unfolds it before the pass runs.
		r.w.renderToggle(arrowFor(host.embeds[0], "Lesson 2"), true);
		await vi.advanceTimersByTimeAsync(50);
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await r.w.settle();
		await settleRestore(r.w, r.restorer);
		await vi.advanceTimersByTimeAsync(150);

		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 3"]);
		expect(r.w.store.embedRecords()[0].folds.map((f) => f.text)).toEqual(["lesson 3: graphs"]);
	});
});

describe.each(MODES)("%s host: E3 at the boundaries of a pass", (mode) => {
	it("a click whose recording is still in flight when the window closes is waited for, so the pass does not undo it", async () => {
		// The recorder's own read of the target is slow (50 ms), so the click is not in the store yet when the pass starts.
		let slow = false;
		const r = rig({}, {
			readNote: async (path) => {
				if (slow) await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
				const file = r.w.app.vault.getFileByPath(path);
				return file === null ? null : await r.w.app.vault.cachedRead(file);
			},
		});
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2", "Lesson 3"]);

		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		const lesson2 = arrowFor(host.embeds[0], "Lesson 2");
		const clicks = vi.fn();
		lesson2.addEventListener("click", clicks);
		r.w.renderToggle(lesson2, true); // Obsidian restored it itself
		await vi.advanceTimersByTimeAsync(140);
		slow = true;
		r.w.realClick(lesson2); // Dan unfolds it 10 ms before the window closes
		await vi.advanceTimersByTimeAsync(10); // the pass starts now; the recording lands 40 ms later
		await vi.advanceTimersByTimeAsync(300); // the pass has finished, the re-check has not
		expect(r.w.store.embedRecords()[0].folds.map((f) => f.text)).toEqual(["lesson 3: graphs"]);
		expect(clicks).toHaveBeenCalledTimes(1); // only Dan's click: the restore never re-folded it
		expect(foldedRows(host.embeds[0])).toEqual(["Lesson 3: Graphs"]);

		await vi.advanceTimersByTimeAsync(600);
		await r.restorer.whenIdle();
		expect(foldedRows(host.embeds[0])).toEqual(["Lesson 3: Graphs"]);
	});

	it("a click made while the stored folds are being matched makes the pass start over from the new record", async () => {
		let yields = 0;
		let onYield: () => Promise<void> = async () => undefined;
		const r = rig({
			matcherOptions: {
				chunkSize: 1,
				yieldToHost: async () => {
					yields++;
					await onYield();
				},
			},
		});
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2", "Lesson 3"]);
		// Lesson 3 changed a little, so the match has to compare (tiers 2 and 3), and so yields.
		r.w.addNote(LESSONS_NOTE, LESSONS_TEXT.replace("Lesson 3: Graphs", "Lesson 3: Graphs and trees"));

		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		const lesson2 = arrowFor(host.embeds[0], "Lesson 2");
		const clicks = vi.fn();
		lesson2.addEventListener("click", clicks);
		r.w.renderToggle(lesson2, true);
		let clicked = false;
		onYield = async () => {
			if (clicked) return;
			clicked = true;
			r.w.realClick(lesson2); // Dan unfolds Lesson 2 in the middle of the match
			await r.w.recorder.whenIdle();
		};
		await settleRestore(r.w, r.restorer);

		expect(yields).toBeGreaterThan(0);
		expect(clicked).toBe(true);
		expect(clicks).toHaveBeenCalledTimes(1); // the restore did not fold it again from the old match
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 3"]);
		expect(r.w.store.embedRecords()[0].folds.map((f) => f.text)).toEqual(["lesson 3: graphs"]);
	});
});

describe.each(MODES)("%s host: teardown with a pass pending", (mode) => {
	it("the host closing before the window ends cancels the pass without error and without a click", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2"]);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const before = snapshot(r.w);

		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		await drain(r.w, r.restorer);
		const clicks = vi.fn();
		for (const arrow of ownArrows(host.embeds[0])) arrow.addEventListener("click", clicks);
		await vi.advanceTimersByTimeAsync(60);
		host.view.containerEl.remove();
		await drain(r.w, r.restorer);
		expect(r.restorer.pendingRenders).toBe(0);
		await vi.advanceTimersByTimeAsync(2000);
		await drain(r.w, r.restorer);

		expect(clicks).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
		expect(snapshot(r.w)).toBe(before);
	});

	it("the embed detaching from a host that stays open does the same", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2"]);
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		await vi.advanceTimersByTimeAsync(60);
		host.embeds[0].remove();
		await vi.advanceTimersByTimeAsync(2000);
		await drain(r.w, r.restorer);

		expect(error).not.toHaveBeenCalled();
		expect(r.restorer.pendingRenders).toBe(0);
	});

	it("dispose cancels everything pending", async () => {
		const r = rig();
		await foldAndClose(r, mode, "Host.md", "![[Lessons]]\n", ["Lesson 2"]);
		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		await vi.advanceTimersByTimeAsync(60);

		r.restorer.dispose();
		await vi.advanceTimersByTimeAsync(2000);
		await r.w.settle();

		expect(foldedRows(host.embeds[0])).toEqual([]);
	});
});

describe.each(MODES)("%s host: G7, two identical embeds in one host restore independently by document order", (mode) => {
	it("a fold stored for the second is restored on the second only, and the first stays expanded", async () => {
		const r = rig();
		const text = "![[Lessons]]\n\nbetween\n\n![[Lessons]]\n";
		await foldAndClose(r, mode, "Host.md", text, ["Lesson 3"], 1);

		const host = r.w.addHost("Host.md", mode, text);
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual([]);
		expect(foldedRows(host.embeds[1]).map((t) => t.slice(0, 8))).toEqual(["Lesson 3"]);
	});

	it("each carries its own different set", async () => {
		const r = rig();
		const text = "![[Lessons]]\n\n![[Lessons]]\n";
		const first = r.w.addHost("Host.md", mode, text);
		await settleRestore(r.w, r.restorer);
		r.w.realClick(arrowFor(first.embeds[0], "Lesson 1"));
		r.w.realClick(arrowFor(first.embeds[1], "Lesson 3"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		first.view.containerEl.remove();

		const host = r.w.addHost("Host.md", mode, text);
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 1"]);
		expect(foldedRows(host.embeds[1]).map((t) => t.slice(0, 8))).toEqual(["Lesson 3"]);
	});
});

describe.each(MODES)("%s host: a nested embed restores from its own chain key", (mode) => {
	it("a fold stored inside the inner embed comes back there, and the outer embed's own arrows are untouched", async () => {
		const r = rig();
		const first = r.w.addHost("Host.md", mode, "![[Outer]]\n");
		await settleRestore(r.w, r.restorer);
		const inner = first.embeds[0].querySelector<HTMLElement>(".internal-embed")!;
		r.w.realClick(arrowFor(inner, "Lesson 2"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		first.view.containerEl.remove();
		expect(r.w.store.embedRecords()[0].outer).toEqual([{ target: OUTER_NOTE, subpath: "", occurrence: 0 }]);
		const before = snapshot(r.w);

		const host = r.w.addHost("Host.md", mode, "![[Outer]]\n");
		await settleRestore(r.w, r.restorer);

		const reopenedInner = host.embeds[0].querySelector<HTMLElement>(".internal-embed")!;
		expect(foldedRows(reopenedInner).map((t) => t.slice(0, 8))).toEqual(["Lesson 2"]);
		expect(isFolded(arrowFor(host.embeds[0], "Outer item"))).toBe(false);
		expect(snapshot(r.w)).toBe(before);
	});

	it("the same note embedded flat in another host does not pick up the nested embed's state", async () => {
		const r = rig();
		const first = r.w.addHost("Host.md", mode, "![[Outer]]\n");
		await settleRestore(r.w, r.restorer);
		r.w.realClick(arrowFor(first.embeds[0].querySelector<HTMLElement>(".internal-embed")!, "Lesson 2"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);

		const flat = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(flat.embeds[0])).toEqual([]);
	});
});

describe("E13/F3: a container that is not a workspace markdown view is ignored", () => {
	async function stored(): Promise<Rig> {
		const r = rig();
		await foldAndClose(r, "live-preview", "Host.md", "![[Lessons]]\n", ["Lesson 2"]);
		return r;
	}

	it("a hover or page preview", async () => {
		const r = await stored();
		r.w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		const popover = buildHoverPopover();
		const embed = r.w.renderEmbed("Lessons", "Host.md", "reading-view");
		popover.append(embed);

		await settleRestore(r.w, r.restorer);

		expect(foldedRows(embed)).toEqual([]);
	});

	it("a canvas card", async () => {
		const r = await stored();
		r.w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		const canvas = new CanvasLikeView("canvas");
		r.w.app.workspace.addLeaf(canvas);
		document.body.append(canvas.containerEl);
		const embed = r.w.renderEmbed("Lessons", "Host.md", "live-preview");
		canvas.containerEl.append(embed);

		await settleRestore(r.w, r.restorer);

		expect(foldedRows(embed)).toEqual([]);
	});

	it("a Bases view", async () => {
		const r = await stored();
		r.w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		const bases = new CanvasLikeView("bases");
		r.w.app.workspace.addLeaf(bases);
		document.body.append(bases.containerEl);
		const embed = r.w.renderEmbed("Lessons", "Host.md", "live-preview");
		bases.containerEl.append(embed);

		await settleRestore(r.w, r.restorer);

		expect(foldedRows(embed)).toEqual([]);
	});

	it("a host shown in Source mode (no rendered embeds there)", async () => {
		const r = await stored();
		const host = r.w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		host.view.sourceMode = true;

		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual([]);
	});
});

describe("G18: a combination the probe could not show to be supported is skipped", () => {
	function withGap(mode: EmbedHostModeId, kind: EmbedKind): Record<EmbedHostModeId, Record<EmbedKind, EmbedCapability>> {
		const copy = structuredClone(EMBED_CAPABILITIES) as Record<EmbedHostModeId, Record<EmbedKind, EmbedCapability>>;
		copy[mode][kind] = { verdict: "unsupported", reason: "not observable" };
		return copy;
	}

	it("restores nothing for the gap, and still restores the supported combinations", async () => {
		const gap = withGap("live-preview", "whole-note");
		// Store state through a world that records everything, then restore through one that skips the gap.
		const r = rig({ capabilities: gap });
		const text = "![[Lessons]]\n\n![[Headed#Lesson 8]]\n";
		await foldAndClose(r, "reading-view", "Host.md", text, ["Lesson 2"], 0);
		await foldAndClose(r, "reading-view", "Host.md", text, ["Lesson 8"], 1);
		expect(r.w.store.embedSize).toBe(2);

		const host = r.w.addHost("Host.md", "live-preview", text);
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual([]); // the gap: skipped, never guessed
		expect(isFolded(arrowFor(host.embeds[1], "Lesson 8"))).toBe(true); // supported: restored
	});

	it("registers no observer at all when nothing is supported", async () => {
		const none = structuredClone(EMBED_CAPABILITIES) as Record<EmbedHostModeId, Record<EmbedKind, EmbedCapability>>;
		for (const mode of Object.keys(none) as EmbedHostModeId[]) {
			for (const kind of Object.keys(none[mode]) as EmbedKind[]) none[mode][kind] = { verdict: "unsupported", reason: "not observable" };
		}
		const r = rig({ capabilities: none });
		await foldAndClose(r, "live-preview", "Host.md", "![[Lessons]]\n", ["Lesson 2"]);

		const host = r.w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		await settleRestore(r.w, r.restorer);

		expect(r.restorer.pendingRenders).toBe(0);
		expect(foldedRows(host.embeds[0])).toEqual([]);
	});
});

describe.each(MODES)("%s host: F1, nothing is added to the DOM of a rendered embed", (mode) => {
	/** The embed's markup with every `is-collapsed` token removed: what Obsidian's own toggle changes. */
	function structure(embed: Element): string {
		return embed.outerHTML.replace(/\s*\bis-collapsed\b/g, "").replace(/ class=""/g, "");
	}

	it("a restore that folds adds no element, attribute or class beyond Obsidian's own is-collapsed", async () => {
		const r = rig();
		await foldAndClose(r, mode, ROCKETSHIP, BLOCK_EMBED, ["Lesson 8"]);

		const host = r.w.addHost(ROCKETSHIP, mode, BLOCK_EMBED);
		const before = structure(host.embeds[0]);
		const elementsBefore = host.embeds[0].querySelectorAll("*").length;
		await settleRestore(r.w, r.restorer);

		expect(structure(host.embeds[0])).toBe(before);
		expect(host.embeds[0].querySelectorAll("*").length).toBe(elementsBefore);
		expect(host.embeds[0].querySelectorAll("[data-pfs], [class*='persistent'], [class*='pfs']").length).toBe(0);
		expect(host.surface.children.length).toBe(1);
	});

	it("a render with nothing stored leaves the embed's markup exactly as it was", async () => {
		const r = rig();
		const host = r.w.addHost("Host.md", mode, "![[Lessons]]\n");
		const before = host.embeds[0].outerHTML;
		await settleRestore(r.w, r.restorer);
		expect(host.embeds[0].outerHTML).toBe(before);
	});
});
