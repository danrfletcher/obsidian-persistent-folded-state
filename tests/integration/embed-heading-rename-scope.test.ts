/**
 * Scope of a heading rename for embeds (ticket warkworth-21, PR-8, G17 "scope"): a heading rename
 * in a source note is a migration for a heading embed only (tests/integration/embed-vault-events.test.ts).
 * For a whole-note embed the same rename changes the stored slice, so its folds are re-matched by
 * the existing PR-6 matcher and its key does not change; a block embed is not affected at all.
 *
 * A host with a whole-note embed and a block embed over the mocked Obsidian app, a real FoldStore,
 * the real recorder and the real restorer. The folds are made by a trusted click; the rename is the
 * new source text in the vault plus the embeds re-rendering from it (as embed-source-edit.test.ts).
 * The whole-note fold sits under the heading that is not renamed ("Lesson 9"), so the existing
 * matcher can place it by its unchanged ancestry; where a fold sits under the renamed heading
 * itself is the matcher's own call (its parent chain changes), not something PR-8 decides.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbedFoldRestorer } from "../../src/embed-fold-restorer";
import { sliceEmbed } from "../../src/embed-slice";
import { HEADED_NOTE, HEADED_TEXT, SOURCE, SOURCE_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";
import type { Mode } from "../fixtures/embed-recording-world";
import { attachRestorer, foldedRows, settleRestore } from "../fixtures/embed-restore-world";

const HOST = "Salesforce Tech Test Rocketship Course.md";
const HOST_TEXT = ["![[Headed]]", "", "![[Competitive Coding Fundamentals#^0169a6]]", ""].join("\n");
const MODES: Mode[] = ["live-preview", "reading-view"];

const RENAMED_HEADED = HEADED_TEXT.replace("## Lesson 8\n", "## Lesson 8 (revised)\n");
const RENAMED_SOURCE = SOURCE_TEXT.replace("# Competitive Coding Fundamentals\n", "# Competitive Coding Fundamentals (2nd ed.)\n");

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

const hashOf = (text: string, subpath: string): string => sliceEmbed(text, subpath)?.hash ?? "";
const keyOf = (r: { host: string; target: string; subpath: string; occurrence: number }): string[] => [r.host, r.target, r.subpath, String(r.occurrence)];

describe.each(MODES)("%s host: G17 scope, a heading rename in the source of a whole-note embed and a block embed", (mode) => {
	it("the whole-note embed's slice changes and its fold is re-matched with the key unchanged; the block embed is not touched", async () => {
		const w = new World();
		w.addNote(SOURCE, SOURCE_TEXT);
		w.addNote(HEADED_NOTE, HEADED_TEXT);
		const restorer = attachRestorer(w);
		rigs.push({ w, restorer });

		const host = w.addHost(HOST, mode, HOST_TEXT);
		await settleRestore(w, restorer);
		w.realClick(arrowFor(host.embeds[0], "Walk the graph"));
		w.realClick(arrowFor(host.embeds[1], "Lesson 8"));
		await w.settle();
		await vi.advanceTimersByTimeAsync(150);

		const [wholeBefore, blockBefore] = w.store.embedRecords();
		expect(w.store.embedSize).toBe(2);
		expect(wholeBefore.subpath).toBe("");
		expect(blockBefore.subpath).toBe("^0169a6");
		expect(wholeBefore.contentHash).toBe(hashOf(HEADED_TEXT, ""));
		// The rename really changes the whole-note slice, and cannot change the block's.
		expect(hashOf(RENAMED_HEADED, "")).not.toBe(hashOf(HEADED_TEXT, ""));
		expect(hashOf(RENAMED_SOURCE, "^0169a6")).toBe(hashOf(SOURCE_TEXT, "^0169a6"));
		const blockJson = JSON.stringify(blockBefore);
		const savedBefore = w.saved.length;

		// The headings are renamed in both sources and both embeds render again, expanded.
		w.addNote(HEADED_NOTE, RENAMED_HEADED);
		w.addNote(SOURCE, RENAMED_SOURCE);
		w.rerender(host.embeds[0], host.path);
		w.rerender(host.embeds[1], host.path);
		expect(foldedRows(host.embeds[0])).toEqual([]);
		await settleRestore(w, restorer);
		await vi.advanceTimersByTimeAsync(500);

		// Whole-note embed: re-matched by the existing matcher, same key, new slice hash, nothing dormant.
		expect(foldedRows(host.embeds[0])).toEqual(["Walk the graph"]);
		expect(w.store.embedSize).toBe(2);
		const [wholeAfter, blockAfter] = w.store.embedRecords();
		expect(keyOf(wholeAfter)).toEqual(keyOf(wholeBefore));
		expect(wholeAfter.contentHash).toBe(hashOf(RENAMED_HEADED, ""));
		expect(wholeAfter.folds).toHaveLength(1);
		expect("dormantSince" in wholeAfter).toBe(false);

		// Block embed: still folded, record byte-identical, and it was not written.
		expect(foldedRows(host.embeds[1]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);
		expect(JSON.stringify(blockAfter)).toBe(blockJson);
		expect(w.saved.length).toBe(savedBefore + 1); // only the whole-note embed's refreshed record
	});
});
