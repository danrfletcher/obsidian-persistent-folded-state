/**
 * Ticket warkworth-21, PR-7 (G6, G14, G16, E6, E7, E9, F2): dormant embed state, end to end over the
 * mocked Obsidian app (tests/mocks/obsidian.ts), a real FoldStore, the real recorder, the real
 * restorer and the real EmbedDormancyTracker, in Live Preview and in Reading view. Folds are made
 * the way Dan makes them (a trusted click). Fake timers drive both the 150 ms render window and the
 * 10-minute wall clock (Date moves with them).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_DORMANT_AGE_MS } from "../../src/dormant";
import { EmbedDormancyTracker } from "../../src/embed-dormancy";
import type { StoredAnchor } from "../../src/types";
import type { EmbedFoldRestorer } from "../../src/embed-fold-restorer";
import { LESSONS_NOTE, LESSONS_TEXT, SOURCE, SOURCE_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";
import type { Mode, RenderedHost } from "../fixtures/embed-recording-world";
import { attachRestorer, firstPass, foldedRows, settleRestore } from "../fixtures/embed-restore-world";

const HOST = "Salesforce Tech Test Rocketship Course.md";
const OTHER_HOST = "Another Course.md";
const LESSON_8 = "![[Competitive Coding Fundamentals#^0169a6]]";
const LESSON_9 = "![[Competitive Coding Fundamentals#^bbb222]]";
const LESSON_8_LINE = "- [ ] Lesson 8: Collections and frequency counting ^0169a6";
const MODES: Mode[] = ["live-preview", "reading-view"];
const MINUTE = 60_000;

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

function rig(): Rig {
	const w = new World();
	w.addNote(SOURCE, SOURCE_TEXT);
	w.addNote(LESSONS_NOTE, LESSONS_TEXT);
	const readNote = async (path: string): Promise<string | null> => {
		const file = w.app.vault.getFileByPath(path);
		return file === null ? null : await w.app.vault.cachedRead(file);
	};
	const resolveLink = (linktext: string, sourcePath: string): string | null => w.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null;
	const dormancy = new EmbedDormancyTracker({ store: w.store, readNote, resolveLink: (t) => resolveLink(t, HOST) });
	const restorer = attachRestorer(w, { dormancy });
	const made = { w, restorer };
	rigs.push(made);
	return made;
}

/** Opens the host with Lesson 8 embedded, folds it and waits for the recording to reach the store. */
async function openAndFold(r: Rig, mode: Mode, hostPath = HOST): Promise<RenderedHost> {
	const host = r.w.addHost(hostPath, mode, `${LESSON_8}\n`);
	await settleRestore(r.w, r.restorer);
	r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
	await r.w.settle();
	await vi.advanceTimersByTimeAsync(150);
	return host;
}

/** The link in the host is edited to `link` and the embed re-renders from it. */
async function relink(r: Rig, host: RenderedHost, link: string): Promise<void> {
	host.view.data = `${link}\n`;
	r.w.addNote(host.path, `${link}\n`);
	const embed = host.embeds[0];
	embed.setAttribute("src", link.replace(/^!\[\[|\]\]$/g, ""));
	r.w.rerender(embed, host.path);
	await settleRestore(r.w, r.restorer);
}

const records = (r: Rig, hostPath = HOST) => r.w.store.embedRecords().filter((rec) => rec.host === hostPath);

describe.each(MODES)("%s host: a retargeted embed's state is dormant, not lost (G6, E9)", (mode) => {
	it("retarget, then revert inside 10 minutes: the fold comes back, the stamp is gone", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const stored = JSON.stringify({ ...records(r)[0] });
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);

		await relink(r, host, LESSON_9);
		expect(records(r)).toHaveLength(1); // the new link created nothing (E12)
		expect(records(r)[0].dormantSince).toBeTypeOf("number");
		expect(JSON.stringify({ ...records(r)[0], dormantSince: undefined })).toBe(stored);
		expect(foldedRows(host.embeds[0])).toEqual([]);

		await vi.advanceTimersByTimeAsync(9 * MINUTE + 59_000);
		await relink(r, host, LESSON_8);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);
		expect(records(r)).toHaveLength(1);
		expect("dormantSince" in records(r)[0]).toBe(false);
		expect(JSON.stringify(records(r)[0])).toBe(stored);
	});

	it("retarget, then revert after 10 minutes: the old state is gone and the embed starts unfolded (G13)", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		await relink(r, host, LESSON_9);
		await vi.advanceTimersByTimeAsync(MAX_DORMANT_AGE_MS + 1000);
		await relink(r, host, LESSON_9); // any later render of the host: this is when it is seen to have expired
		expect(records(r)).toHaveLength(0);

		await relink(r, host, LESSON_8);
		expect(foldedRows(host.embeds[0])).toEqual([]);
		expect(records(r)).toHaveLength(0);
	});

	it("the clock does not restart each time the retargeted embed renders", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		await relink(r, host, LESSON_9);
		const stamp = records(r)[0].dormantSince;
		for (let i = 0; i < 4; i++) {
			await vi.advanceTimersByTimeAsync(2 * MINUTE);
			if (i < 3) {
				r.w.rerender(host.embeds[0], host.path);
				await settleRestore(r.w, r.restorer);
				expect(records(r)[0].dormantSince).toBe(stamp);
			}
		}
		// 8 minutes so far; two more minutes and the settles put the next render past 10 minutes since the first stamp
		await vi.advanceTimersByTimeAsync(2 * MINUTE);
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect(records(r)).toHaveLength(0);
	});

	it("the id coming back without the embed rendering again changes nothing; the next render of the embed restores the fold (E6, T17)", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const before = JSON.stringify(records(r)[0]);

		r.w.addNote(SOURCE, SOURCE_TEXT.replace(" ^0169a6", ""));
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		const stamp = records(r)[0].dormantSince;
		expect(stamp).toBeTypeOf("number");

		// Obsidian leaves an embed that says "Unable to find" as it is when its target gets the
		// block back: no render, so no pass and nothing to restore yet; the record is left alone.
		await vi.advanceTimersByTimeAsync(2 * MINUTE);
		r.w.addNote(SOURCE, SOURCE_TEXT);
		await settleRestore(r.w, r.restorer);
		expect(records(r)[0].dormantSince).toBe(stamp);
		expect(foldedRows(host.embeds[0])).toEqual([]);

		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect("dormantSince" in records(r)[0]).toBe(false);
		expect(JSON.stringify(records(r)[0])).toBe(before);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);
	});

	it("a broken embed (the block id no longer exists in the target) goes dormant the same way (E6), and a restored id revives it", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const before = JSON.stringify(records(r)[0]);

		r.w.addNote(SOURCE, SOURCE_TEXT.replace(" ^0169a6", ""));
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect(records(r)[0].dormantSince).toBeTypeOf("number");

		await vi.advanceTimersByTimeAsync(3 * MINUTE);
		r.w.addNote(SOURCE, SOURCE_TEXT);
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect("dormantSince" in records(r)[0]).toBe(false);
		expect(JSON.stringify(records(r)[0])).toBe(before);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);
	});

	it("another host's embed of the same block is untouched while this one is dormant, then expires on its own (F2)", async () => {
		const r = rig();
		const first = await openAndFold(r, mode);
		const second = await openAndFold(r, mode, OTHER_HOST);
		const secondBefore = JSON.stringify(records(r, OTHER_HOST)[0]);

		await relink(r, first, LESSON_9);
		expect(records(r)[0].dormantSince).toBeTypeOf("number");
		expect(JSON.stringify(records(r, OTHER_HOST)[0])).toBe(secondBefore);
		expect(foldedRows(second.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);
	});

	it("typing a link into a host that has no state creates no record and stamps nothing (E12)", async () => {
		const r = rig();
		const host = r.w.addHost(HOST, mode, `${LESSON_8}\n`);
		await settleRestore(r.w, r.restorer);
		await relink(r, host, LESSON_9);
		await relink(r, host, LESSON_8);
		expect(r.w.store.embedSize).toBe(0);
	});
});

describe.each(MODES)("%s host: a fold the matcher cannot place is dormant inside a live embed (G14, G16)", (mode) => {
	const WHOLE = "![[Competitive Coding Fundamentals]]";

	async function openWholeNoteAndFold(r: Rig): Promise<RenderedHost> {
		const host = r.w.addHost(HOST, mode, `${WHOLE}\n`);
		await settleRestore(r.w, r.restorer);
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		return host;
	}
	const edit = async (r: Rig, host: RenderedHost, text: string): Promise<void> => {
		r.w.addNote(SOURCE, text);
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
	};

	it("the line vanishes: its fold goes dormant and nothing else folds; the line returns inside 10 minutes: folded again, no longer dormant", async () => {
		const r = rig();
		const host = await openWholeNoteAndFold(r);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);

		await edit(r, host, SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Zebra migration patterns ^0169a6"));
		expect(foldedRows(host.embeds[0])).toEqual([]); // G16: an unmatched block stays unfolded
		expect(records(r)[0].folds).toEqual([]);
		expect(records(r)[0].dormant).toHaveLength(1);
		expect(records(r)[0].dormant[0]).toMatchObject({ dormantSince: expect.any(Number) });

		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		await edit(r, host, SOURCE_TEXT);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);
		expect(records(r)[0].dormant).toEqual([]);
		expect(records(r)[0].folds).toHaveLength(1);
	});

	it("the line returns only after 10 minutes: the dormant fold has been forgotten and the embed stays unfolded", async () => {
		const r = rig();
		const host = await openWholeNoteAndFold(r);
		await edit(r, host, SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Zebra migration patterns ^0169a6"));
		await vi.advanceTimersByTimeAsync(MAX_DORMANT_AGE_MS + 1000);
		await edit(r, host, SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Zebra migration patterns ^0169a6")); // a render after the window: forgotten
		expect(records(r)[0].dormant).toEqual([]);
		await edit(r, host, SOURCE_TEXT);
		expect(foldedRows(host.embeds[0])).toEqual([]);
	});

	it("while Dan folds the same block himself, the dormant duplicate is dropped: one fold only", async () => {
		const r = rig();
		const host = await openWholeNoteAndFold(r);
		await edit(r, host, SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Zebra migration patterns ^0169a6"));
		await edit(r, host, SOURCE_TEXT); // back: matches, promoted
		const folds = records(r)[0].folds;
		expect(folds).toHaveLength(1);
		await edit(r, host, SOURCE_TEXT); // and a further render changes nothing
		expect(records(r)[0].folds).toEqual(folds);
		expect(records(r)[0].dormant).toEqual([]);
		expect(foldedRows(host.embeds[0])).toHaveLength(1);
	});
});

// --- E3: a click during a re-render wins and is the only thing that changes stored state --------

const WHOLE_NOTE = "![[Competitive Coding Fundamentals]]";
const ZEBRA_TEXT = SOURCE_TEXT.replace(LESSON_8_LINE, "- [ ] Zebra migration patterns ^0169a6");
const foldTexts = (record: { folds: StoredAnchor[] }): string[] => record.folds.map((f) => (f as unknown as { text: string }).text);

describe.each(MODES)("%s host: a click on a fold arrow during a re-render wins and is recorded (E3)", (mode) => {
	it("a dormant anchor is retried while Dan folds another row mid-render: his fold is the only change, the anchor keeps its original clock", async () => {
		const r = rig();
		const host = r.w.addHost(HOST, mode, `${WHOLE_NOTE}\n`);
		await settleRestore(r.w, r.restorer);
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		r.w.addNote(SOURCE, ZEBRA_TEXT);
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect(records(r)[0].dormant).toHaveLength(1);
		const stamp = records(r)[0].dormant[0].dormantSince;
		await vi.advanceTimersByTimeAsync(MINUTE);

		// The embed re-renders (its render window is open, no pass has run yet) and Dan clicks.
		r.w.rerender(host.embeds[0], host.path);
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 9"));
		await r.w.settle();
		expect(r.restorer.pendingRenders).toBeGreaterThan(0);
		expect(foldTexts(records(r)[0])).toEqual([expect.stringMatching(/^lesson 9/)]); // recorded at once, before the pass

		await settleRestore(r.w, r.restorer);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 9"]);
		expect(foldTexts(records(r)[0])).toEqual([expect.stringMatching(/^lesson 9/)]);
		expect(records(r)[0].dormant).toHaveLength(1);
		expect(records(r)[0].dormant[0].dormantSince).toBe(stamp); // retrying did not restart the clock
	});

	it("Dan clicks the moment the render window closes and the retry runs: his fold stays, and the later verify look never undoes it", async () => {
		const r = rig();
		const host = r.w.addHost(HOST, mode, `${WHOLE_NOTE}\n`);
		await settleRestore(r.w, r.restorer);
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		r.w.addNote(SOURCE, ZEBRA_TEXT);
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		const stamp = records(r)[0].dormant[0].dormantSince;

		r.w.rerender(host.embeds[0], host.path);
		await vi.advanceTimersByTimeAsync(150); // the window closes: the pass starts
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 9")); // and Dan clicks before the verify look 400 ms later
		await r.w.settle();
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 9"]);
		expect(foldTexts(records(r)[0])).toEqual([expect.stringMatching(/^lesson 9/)]);
		expect(records(r)[0].dormant[0].dormantSince).toBe(stamp);
	});

	it("a retargeted embed's old record is dormant while Dan folds in the new embed mid-render: the new fold is recorded under the new key only", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const old = JSON.stringify(records(r)[0]);
		await relink(r, host, LESSON_9);
		const stamp = records(r)[0].dormantSince;
		expect(stamp).toBeTypeOf("number");
		await vi.advanceTimersByTimeAsync(MINUTE);

		r.w.rerender(host.embeds[0], host.path);
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 9"));
		await r.w.settle();
		await settleRestore(r.w, r.restorer);

		const [first, second] = records(r);
		expect(records(r)).toHaveLength(2);
		expect(JSON.stringify({ ...first, dormantSince: undefined })).toBe(JSON.stringify({ ...JSON.parse(old), dormantSince: undefined }));
		expect(first.dormantSince).toBe(stamp); // going dormant, and staying dormant, was not a user fold and restarted nothing
		expect(second.subpath).toBe("^bbb222");
		expect(foldTexts(second)).toEqual([expect.stringMatching(/^lesson 9/)]);
		expect("dormantSince" in second).toBe(false);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 9"]);
	});

	it("the link comes back and Dan folds a row mid-render: the revived fold is restored beside his, and reviving recorded nothing of its own", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		await relink(r, host, LESSON_9);
		expect(records(r)[0].dormantSince).toBeTypeOf("number");
		const lesson8 = foldTexts(records(r)[0]);

		host.view.data = `${LESSON_8}\n`;
		r.w.addNote(host.path, `${LESSON_8}\n`);
		host.embeds[0].setAttribute("src", LESSON_8.replace(/^!\[\[|\]\]$/g, ""));
		r.w.rerender(host.embeds[0], host.path);
		r.w.realClick(arrowFor(host.embeds[0], "Count word frequency")); // before the restore pass has run
		await r.w.settle();
		await settleRestore(r.w, r.restorer);

		expect(records(r).filter((rec) => rec.subpath === "^0169a6")).toHaveLength(1);
		const revived = records(r).find((rec) => rec.subpath === "^0169a6");
		expect("dormantSince" in (revived ?? {})).toBe(false);
		expect(foldTexts(revived as never)).toEqual([...lesson8, expect.stringMatching(/^count word frequency/)]);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8", "Count wo"]);
	});
});

// --- F7: nothing is written to the host or the source note --------------------------------------

/** Every way the vault can be written to, as spies: the mock has none, so a call would throw. */
function spyOnVaultWrites(w: World): Record<string, ReturnType<typeof vi.fn>> {
	const vault = w.app.vault as unknown as Record<string, unknown>;
	const spies: Record<string, ReturnType<typeof vi.fn>> = {};
	for (const name of ["modify", "process", "create", "createFolder", "rename", "delete", "trash", "append", "copy", "createBinary", "modifyBinary"]) {
		spies[name] = vi.fn();
		vault[name] = spies[name];
	}
	return spies;
}
const writeCalls = (spies: Record<string, ReturnType<typeof vi.fn>>): Record<string, number> => Object.fromEntries(Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]));
const NO_WRITES = Object.fromEntries(["modify", "process", "create", "createFolder", "rename", "delete", "trash", "append", "copy", "createBinary", "modifyBinary"].map((name) => [name, 0]));

describe.each(MODES)("%s host: no vault write while a key goes dormant, matches, expires or is retried (F7)", (mode) => {
	it("whole-embed dormancy: retarget, revert, retarget and expire, break and repair", async () => {
		const r = rig();
		const writes = spyOnVaultWrites(r.w);
		const host = await openAndFold(r, mode);

		await relink(r, host, LESSON_9); // goes dormant
		expect(records(r)[0].dormantSince).toBeTypeOf("number");
		await relink(r, host, LESSON_8); // matches again
		expect("dormantSince" in records(r)[0]).toBe(false);
		await relink(r, host, LESSON_9);
		await vi.advanceTimersByTimeAsync(MAX_DORMANT_AGE_MS + 1000);
		await relink(r, host, LESSON_9); // expires
		expect(records(r)).toHaveLength(0);

		await relink(r, host, LESSON_8);
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
		await r.w.settle();
		r.w.addNote(SOURCE, SOURCE_TEXT.replace(" ^0169a6", "")); // broken
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect(records(r)[0].dormantSince).toBeTypeOf("number");
		r.w.addNote(SOURCE, SOURCE_TEXT); // repaired
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect("dormantSince" in records(r)[0]).toBe(false);

		expect(writeCalls(writes)).toEqual(NO_WRITES);
	});

	it("per-anchor dormancy: a fold goes dormant, is retried on later renders, matches again, and another expires", async () => {
		const r = rig();
		const writes = spyOnVaultWrites(r.w);
		const host = r.w.addHost(HOST, mode, `${WHOLE_NOTE}\n`);
		await settleRestore(r.w, r.restorer);
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		const edit = async (text: string): Promise<void> => {
			r.w.addNote(SOURCE, text);
			r.w.rerender(host.embeds[0], host.path);
			await settleRestore(r.w, r.restorer);
		};

		await edit(ZEBRA_TEXT); // dormant
		await edit(ZEBRA_TEXT); // retried, still dormant
		expect(records(r)[0].dormant).toHaveLength(1);
		await edit(SOURCE_TEXT); // matches again
		expect(records(r)[0].dormant).toEqual([]);
		await edit(ZEBRA_TEXT);
		await vi.advanceTimersByTimeAsync(MAX_DORMANT_AGE_MS + 1000);
		await edit(ZEBRA_TEXT); // expires
		expect(records(r)[0].dormant).toEqual([]);

		expect(writeCalls(writes)).toEqual(NO_WRITES);
	});
});

// --- E5: the dormant retry runs on the last settled render, on its own timer --------------------

describe.each(MODES)("%s host: the dormant retry waits for the last settled render and has its own timer (E5)", (mode) => {
	it("a burst of renders does one retry 150 ms after the last; the store's flush is a separate, later timer", async () => {
		const reconcile = vi.spyOn(EmbedDormancyTracker.prototype, "reconcileHost");
		const r = rig();
		const host = r.w.addHost(HOST, mode, `${WHOLE_NOTE}\n`);
		await settleRestore(r.w, r.restorer);
		r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
		await r.w.settle();
		await vi.advanceTimersByTimeAsync(150);
		r.w.addNote(SOURCE, ZEBRA_TEXT);
		r.w.rerender(host.embeds[0], host.path);
		await settleRestore(r.w, r.restorer);
		expect(records(r)[0].dormant).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1000); // the flush of the stored fold and its dormancy has long since happened
		const passes = reconcile.mock.calls.length;
		const saves = r.w.saved.length;

		// Five renders 100 ms apart (each inside the previous one's window); the source is back only for the last.
		for (let i = 0; i < 5; i++) {
			r.w.addNote(SOURCE, i === 4 ? SOURCE_TEXT : ZEBRA_TEXT);
			r.w.rerender(host.embeds[0], host.path);
			if (i < 4) await vi.advanceTimersByTimeAsync(100);
		}
		expect(reconcile.mock.calls.length).toBe(passes); // no retry on an intermediate render
		expect(foldedRows(host.embeds[0])).toEqual([]);
		expect(records(r)[0].dormant).toHaveLength(1);

		await firstPass(r.w, r.restorer); // 150 ms after the last render
		expect(reconcile.mock.calls.length).toBe(passes + 1); // one retry for the whole burst
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);
		expect(records(r)[0].dormant).toEqual([]);
		expect(r.w.saved.length).toBe(saves); // the retry did not flush: persistence has its own timer

		await vi.advanceTimersByTimeAsync(150); // the store's debounce, separate from the render window
		expect(r.w.saved.length).toBeGreaterThan(saves);
	});
});
