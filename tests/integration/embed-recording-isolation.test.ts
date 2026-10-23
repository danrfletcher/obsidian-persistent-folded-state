/**
 * G8 and F2 as property checks (PR-4): after any sequence of clicks across two hosts, the source
 * note and a third embed of the same block, only the clicked embed's entry changes. Real
 * `FoldStore`, snapshot comparison; the sequences come from a small seeded generator so a failure
 * is reproducible.
 */
import { afterEach, describe, expect, it } from "vitest";
import { LESSONS_NOTE, LESSONS_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";
import type { RenderedHost } from "../fixtures/embed-recording-world";
import type { FileFoldRecord } from "../../src/types";

const LESSONS = ["Lesson 1", "Lesson 2", "Lesson 3", "Count word frequency"];
const SOURCE_FOLD = { kind: "task", indent: 0, text: "lesson 9: graphs", siblingIndex: 2, parentChain: [] };
const SOURCE_RECORD: FileFoldRecord = { contentHash: "src-hash", folds: [SOURCE_FOLD], dormant: [] };

/** mulberry32: a tiny seeded generator. */
function rng(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Target {
	name: string;
	host: RenderedHost;
	embedKey: string;
}

const worlds: World[] = [];
afterEach(() => {
	for (const w of worlds.splice(0)) w.recorder.dispose();
	document.body.replaceChildren();
});

/** Two hosts that embed the same note, a third host with two embeds of it, and the source note
 * with an entry of its own. */
function setup(mode: "live-preview" | "reading-view") {
	const w = new World();
	worlds.push(w);
	w.addNote(LESSONS_NOTE, LESSONS_TEXT);
	w.store.set(LESSONS_NOTE, structuredClone(SOURCE_RECORD));
	const hostA = w.addHost("A.md", mode, "![[Lessons]]\n");
	const hostB = w.addHost("B.md", mode, "![[Lessons]]\n");
	const hostC = w.addHost("C.md", mode, "![[Lessons]]\n\n![[Lessons]]\n");
	const targets: Target[] = [
		{ name: "A#0", host: { ...hostA, embeds: [hostA.embeds[0]] }, embedKey: "A.md|0" },
		{ name: "B#0", host: { ...hostB, embeds: [hostB.embeds[0]] }, embedKey: "B.md|0" },
		{ name: "C#0", host: { ...hostC, embeds: [hostC.embeds[0]] }, embedKey: "C.md|0" },
		{ name: "C#1", host: { ...hostC, embeds: [hostC.embeds[1]] }, embedKey: "C.md|1" },
	];
	return { w, targets };
}

function snapshot(w: World): { source: string; embeds: Map<string, string> } {
	const embeds = new Map<string, string>();
	for (const r of w.store.embedRecords()) embeds.set(`${r.host}|${r.occurrence}`, JSON.stringify(r));
	return { source: JSON.stringify(w.store.get(LESSONS_NOTE)), embeds };
}

describe.each(["live-preview", "reading-view"] as const)("%s: only the clicked embed's entry changes (G8, F2)", (mode) => {
	it.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %i: any sequence of clicks across hosts and duplicates", async (seed) => {
		const { w, targets } = setup(mode);
		const next = rng(seed);
		let touched = 0;

		for (let step = 0; step < 24; step++) {
			const target = targets[Math.floor(next() * targets.length)];
			const label = LESSONS[Math.floor(next() * LESSONS.length)];
			const before = snapshot(w);

			w.realClick(arrowFor(target.host.embeds[0], label));
			await w.settle();
			const after = snapshot(w);

			// The source note's entry is byte-identical after every click.
			expect(after.source, `seed ${seed} step ${step}`).toBe(before.source);
			// Every embed entry but the clicked one is byte-identical; the clicked one may change.
			for (const other of targets) {
				if (other.embedKey === target.embedKey) continue;
				expect(after.embeds.get(other.embedKey), `seed ${seed} step ${step}: ${other.name} after a click in ${target.name}`).toBe(
					before.embeds.get(other.embedKey)
				);
			}
			if (after.embeds.get(target.embedKey) !== before.embeds.get(target.embedKey)) touched++;
		}

		expect(touched).toBeGreaterThan(0);
		expect(w.store.get(LESSONS_NOTE)).toEqual(SOURCE_RECORD);
	});

	it("a fold made in the source note's own record leaves every embed entry byte-identical (F2, other direction)", async () => {
		const { w, targets } = setup(mode);
		for (const t of targets) w.realClick(arrowFor(t.host.embeds[0], "Lesson 2"));
		await w.settle();
		const before = snapshot(w);
		expect(before.embeds.size).toBe(4);

		w.store.set(LESSONS_NOTE, { contentHash: "other", folds: [], dormant: [] });
		w.store.set(LESSONS_NOTE, { contentHash: "again", folds: [SOURCE_FOLD], dormant: [] });

		expect(snapshot(w).embeds).toEqual(before.embeds);
	});

	it("the same fold in four embeds is four entries, each under its own host and index", async () => {
		const { w, targets } = setup(mode);
		for (const t of targets) w.realClick(arrowFor(t.host.embeds[0], "Lesson 2"));
		await w.settle();

		expect(w.store.embedRecords().map((r) => `${r.host}#${r.occurrence}`)).toEqual(["A.md#0", "B.md#0", "C.md#0", "C.md#1"]);
	});
});
