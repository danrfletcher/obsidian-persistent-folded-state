/**
 * E7 end to end through the embed restorer (ticket warkworth-21, PR-6), modelled on
 * tests/integration/restore-large.test.ts: a real `EmbedFoldRestorer` over the PR-4 `World` (mock
 * Obsidian app, real `FoldStore`, jsdom hosts shaped like the probe's recorded DOM), real timers.
 *
 *  - one embed whose record holds 600 stored folds: at most 500 are applied, the rest stay in the
 *    store, and the matcher yields to the host between chunks (a keystroke dispatched mid-match
 *    into a real CM6 view is applied at once, and the event loop turns between chunks);
 *  - a host of 51 embeds, each needing 100 comparisons: they share one 5,000-comparison budget
 *    (51 embeds do not each get 5,000), and the embed that finds it spent keeps its stored folds,
 *    is not folded and is not forgotten.
 *
 * Every stored fold is re-worded in the source, so each is placed by the positional tier (one
 * comparison each) and none by the free exact tier.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { buildAnchors } from "../../src/anchors";
import type { EmbedFoldRestorer } from "../../src/embed-fold-restorer";
import { sliceEmbed } from "../../src/embed-slice";
import * as similarityModule from "../../src/similarity";
import type { EmbedFoldRecord, StoredAnchor } from "../../src/types";
import { World } from "../fixtures/embed-recording-world";
import { attachRestorer, foldedRows } from "../fixtures/embed-restore-world";

const HOST = "Large Host.md";

/** `count` headings, each with a body line, worded with `suffix`. */
function headingNote(count: number, suffix: string): string {
	const lines: string[] = [];
	for (let i = 1; i <= count; i++) lines.push(`## Heading ${i} ${suffix}`, `body for ${i}`);
	return lines.join("\n");
}

/** What Dan's earlier folds left in the store for a whole-note embed of `target` (host `HOST`). */
function storedRecord(target: string, beforeText: string): EmbedFoldRecord {
	return {
		host: HOST,
		target,
		subpath: "",
		occurrence: 0,
		contentHash: sliceEmbed(beforeText, "")?.hash ?? "",
		folds: buildAnchors(beforeText)
			.filter((block) => block.anchor.kind === "heading") // the headings Dan folded, not their body lines
			.map((block) => block.anchor as unknown as StoredAnchor),
		dormant: [],
	};
}

interface Rig {
	w: World;
	restorer: EmbedFoldRestorer;
}
const rigs: Rig[] = [];
const views: EditorView[] = [];

function rig(overrides: Parameters<typeof attachRestorer>[1] = {}): Rig {
	const w = new World();
	const restorer = attachRestorer(w, { verifyDelayMs: 60_000, ...overrides }); // no re-check inside a test
	const made = { w, restorer };
	rigs.push(made);
	return made;
}

afterEach(() => {
	for (const { w, restorer } of rigs.splice(0)) {
		restorer.dispose();
		w.recorder.dispose();
	}
	for (const view of views.splice(0)) view.destroy();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Real time until every render window has fired and no pass is running. */
async function untilQuiet(r: Rig): Promise<void> {
	await sleep(200); // past the 150 ms render window
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		await r.restorer.whenIdle();
		if (r.restorer.pendingRenders === 0) break;
		await sleep(25);
	}
	await r.restorer.whenIdle();
	await r.w.settle();
}

describe("E7: 600 stored folds in one embed", () => {
	const BEFORE = headingNote(600, "original");
	// Every heading is reworded but keeps its sibling index and indent: one eligible candidate each.
	const AFTER = headingNote(600, "renamed");

	function open(r: Rig): ReturnType<World["addHost"]> {
		r.w.addNote("Large.md", AFTER);
		r.w.store.setEmbed(storedRecord("Large.md", BEFORE));
		return r.w.addHost(HOST, "live-preview", "![[Large]]\n");
	}

	const headingNumber = (row: string): number => Number(/^Heading (\d+) /.exec(row)?.[1] ?? Number.NaN);

	it("applies at most 500 folds, keeps all 600 in the store, and yields to the host while matching", async () => {
		let yields = 0;
		const r = rig({
			matcherOptions: {
				chunkSize: 50,
				yieldToHost: () => {
					yields++;
					return new Promise((resolve) => window.setTimeout(resolve, 0));
				},
			},
		});
		const host = open(r);
		await untilQuiet(r);

		const folded = foldedRows(host.embeds[0]);
		expect(folded.length).toBeGreaterThan(0);
		expect(folded.length).toBeLessThanOrEqual(500);
		// The first 500 stored folds, in stored order, and never the 501st-600th.
		for (const row of folded) expect(headingNumber(row)).toBeLessThanOrEqual(500);
		expect(folded).toHaveLength(500);
		expect(yields).toBeGreaterThan(1); // 500 comparisons in chunks of 50

		// "Kept in the store, left unapplied": the record still has all 600 stored folds. The 500 that
		// were placed follow the source; the 100 past the cap are exactly as they were stored.
		const record = r.w.store.embedRecords()[0];
		expect(r.w.store.embedSize).toBe(1);
		expect(record.folds).toHaveLength(600);
		expect(record.folds[0].text).toBe("heading 1 renamed");
		expect(record.folds[499].text).toBe("heading 500 renamed");
		expect(record.folds.slice(500).map((f) => f.text)).toEqual(Array.from({ length: 100 }, (_, i) => `heading ${501 + i} original`));
		expect(record.dormant).toEqual([]);
	}, 30_000);

	it("a keystroke dispatched mid-match is applied immediately, and the event loop turns between chunks", async () => {
		const view = new EditorView({ state: EditorState.create({ doc: "typed text" }), parent: document.body });
		views.push(view);

		let keystroke: { appliedAtOnce: boolean; foldedWhenTyped: number } | null = null;
		let timerRanBetweenChunks = false;
		let yields = 0;
		const r = rig({
			matcherOptions: {
				chunkSize: 50,
				yieldToHost: () => {
					yields++;
					if (yields === 1) {
						// Dan types while the match is still working through the stored folds: a real
						// dispatch to a real CM6 view, and a macrotask queued behind it.
						view.dispatch({ changes: { from: 0, to: 0, insert: "X" } });
						keystroke = { appliedAtOnce: view.state.doc.toString().startsWith("X"), foldedWhenTyped: foldedRows(host.embeds[0]).length };
						window.setTimeout(() => {
							timerRanBetweenChunks = true;
						}, 0);
					} else if (yields === 2) {
						expect(timerRanBetweenChunks).toBe(true); // the host's own timers ran before the next chunk
					}
					return new Promise((resolve) => window.setTimeout(resolve, 0));
				},
			},
		});
		const host = open(r);
		await untilQuiet(r);

		expect(keystroke).not.toBeNull();
		expect(keystroke).toEqual({ appliedAtOnce: true, foldedWhenTyped: 0 }); // typed before any fold was applied
		expect(timerRanBetweenChunks).toBe(true);
		expect(view.state.doc.toString()).toBe("Xtyped text");
		expect(foldedRows(host.embeds[0]).length).toBe(500); // the match still finished
	}, 30_000);

	it("uses the restorer's own scheduler between chunks when none is injected", async () => {
		const r = rig({ matcherOptions: { chunkSize: 100 } });
		const yieldedTimers = vi.spyOn(window, "setTimeout");
		const host = open(r);
		await untilQuiet(r);
		// 500 comparisons / 100 per chunk: at least four yields, each a zero-delay timer of the restorer's.
		const zeroDelay = yieldedTimers.mock.calls.filter(([, delay]) => delay === 0).length;
		expect(zeroDelay).toBeGreaterThanOrEqual(4);
		expect(foldedRows(host.embeds[0])).toHaveLength(500);
	}, 30_000);
});

describe("E7: 51 embeds in one host share 5,000 comparisons", () => {
	const EMBEDS = 51;
	const FOLDS_EACH = 100; // 51 x 100 = 5,100 comparisons wanted; 5,000 available
	const BEFORE = headingNote(FOLDS_EACH, "original");
	const AFTER = headingNote(FOLDS_EACH, "renamed");

	function openHost(r: Rig): { host: ReturnType<World["addHost"]>; before: string[] } {
		const lines: string[] = [];
		for (let i = 0; i < EMBEDS; i++) {
			r.w.addNote(`Big ${i}.md`, AFTER);
			r.w.store.setEmbed(storedRecord(`Big ${i}.md`, BEFORE));
			lines.push(`![[Big ${i}]]`, "");
		}
		const before = r.w.store.embedRecords().map((record) => JSON.stringify(record));
		return { host: r.w.addHost(HOST, "live-preview", lines.join("\n")), before };
	}

	it("spends 5,000 comparisons in all, not 5,000 per embed", async () => {
		const r = rig();
		const similarity = vi.spyOn(similarityModule, "similarity");
		const { host } = openHost(r);
		expect(host.embeds).toHaveLength(EMBEDS);
		await untilQuiet(r);

		expect(similarity.mock.calls.length).toBe(5000);
	}, 60_000);

	it("embeds that fit are folded and refreshed; the one that runs out keeps its stored folds, is not folded and is not forgotten", async () => {
		const r = rig();
		const { host, before } = openHost(r);
		await untilQuiet(r);

		const records = r.w.store.embedRecords();
		expect(r.w.store.embedSize).toBe(EMBEDS); // nothing forgotten
		const newHash = sliceEmbed(AFTER, "")?.hash;
		const refreshed = records.filter((record) => record.contentHash === newHash);
		const kept = records.filter((record) => record.contentHash !== newHash);
		expect(refreshed).toHaveLength(50);
		expect(kept).toHaveLength(1);
		// The spent embed's record is byte-for-byte what was stored: all its folds, still the old ones.
		const keptRecord = kept[0];
		expect(before).toContain(JSON.stringify(keptRecord));
		expect(keptRecord.folds).toHaveLength(FOLDS_EACH);

		// What each embed shows follows its record: 100 folds on the 50 that were matched, none on the spent one.
		const keptIndex = Number(/Big (\d+)\.md/.exec(keptRecord.target)?.[1]);
		host.embeds.forEach((embed, i) => {
			expect(foldedRows(embed)).toHaveLength(i === keptIndex ? 0 : FOLDS_EACH);
		});
	}, 60_000);

	it("the host's budget is per host: a second host gets 5,000 of its own", async () => {
		const r = rig();
		const similarity = vi.spyOn(similarityModule, "similarity");
		const { host } = openHost(r);
		await untilQuiet(r);
		expect(similarity.mock.calls.length).toBe(5000);

		// A second host that embeds two of the same notes, with their own stored folds.
		for (const i of [0, 1]) r.w.store.setEmbed({ ...storedRecord(`Big ${i}.md`, BEFORE), host: "Second Host.md" });
		const second = r.w.addHost("Second Host.md", "live-preview", "![[Big 0]]\n\n![[Big 1]]\n");
		await untilQuiet(r);

		expect(similarity.mock.calls.length).toBe(5000 + 2 * FOLDS_EACH);
		for (const embed of second.embeds) expect(foldedRows(embed)).toHaveLength(FOLDS_EACH);
		expect(host.embeds.length).toBe(EMBEDS);
	}, 60_000);
});
