/**
 * Golden path GP4 and GP6 for an embed whose source is rewritten (ticket warkworth-21, PR-6).
 * The source note is the pair of files under tests/fixtures/embed-rematch/: Dan's note before, and
 * after an agent renames the line "Lesson 8: Collections and frequency counting" to "Lesson 8
 * (revised): Collections and frequency counting". Host with the embed
 * `![[Competitive Coding Fundamentals#^0169a6]]` over the mocked Obsidian app, a real FoldStore, the
 * real recorder and the real restorer; Lesson 8 is folded with a trusted click, as Dan folds it.
 *
 * GP4: the file is rewritten on disk while the host is open; the embed re-renders and, once the
 * render settles, Lesson 8 is still folded and its unfolded sibling is not.
 * GP6: Obsidian is quit, the file is rewritten, he relaunches and opens the host: the folds are as
 * he left them. Nothing is written to either note (F7).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAnchors, parseAnchor } from "../../src/anchors";
import { planEmbedRematch, HostComparisonBudget } from "../../src/embed-rematch";
import type { EmbedFoldRestorer } from "../../src/embed-fold-restorer";
import { sliceEmbed } from "../../src/embed-slice";
import { SOURCE, World, arrowFor, ownArrows } from "../fixtures/embed-recording-world";
import type { Mode } from "../fixtures/embed-recording-world";
import { attachRestorer, drain, foldedRows, settleRestore } from "../fixtures/embed-restore-world";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "embed-rematch");
const BEFORE = readFileSync(join(FIXTURES, "competitive-coding-fundamentals-before.md"), "utf8");
const AFTER = readFileSync(join(FIXTURES, "competitive-coding-fundamentals-after.md"), "utf8");

const ROCKETSHIP = "Salesforce Tech Test Rocketship Course.md";
const HOST_TEXT = "![[Competitive Coding Fundamentals#^0169a6]]\n";
const RENAMED = "Lesson 8 (revised): Collections and frequency counting";
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
});

function rig(): Rig {
	const w = new World();
	w.addNote(SOURCE, BEFORE);
	const made = { w, restorer: attachRestorer(w) };
	rigs.push(made);
	return made;
}

/** Dan opens the host and folds Lesson 8 inside the embed; the fold reaches the store. */
async function openAndFold(r: Rig, mode: Mode): Promise<ReturnType<World["addHost"]>> {
	const host = r.w.addHost(ROCKETSHIP, mode, HOST_TEXT);
	await settleRestore(r.w, r.restorer);
	expect(foldedRows(host.embeds[0])).toEqual([]);
	r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
	await r.w.settle();
	await vi.advanceTimersByTimeAsync(150);
	expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);
	return host;
}

const read = async (w: World, path: string): Promise<string> => w.app.vault.cachedRead(w.app.vault.getFileByPath(path) as never);

describe("the fixtures are the rename and nothing else", () => {
	it("differ in the one Lesson 8 line", () => {
		const before = BEFORE.split("\n");
		const after = AFTER.split("\n");
		expect(after).toHaveLength(before.length);
		const changed = before.map((line, i) => [line, after[i]]).filter(([a, b]) => a !== b);
		expect(changed).toEqual([["- [ ] Lesson 8: Collections and frequency counting ^0169a6", "- [ ] Lesson 8 (revised): Collections and frequency counting ^0169a6"]]);
		expect(sliceEmbed(BEFORE, "^0169a6")?.hash).not.toBe(sliceEmbed(AFTER, "^0169a6")?.hash);
	});

	it("the unchanged matcher places the renamed line from the stored anchor (G3)", async () => {
		const stored = buildAnchors(sliceEmbed(BEFORE, "^0169a6")?.text ?? "")
			.map((block) => block.anchor)
			.filter((anchor) => anchor.text.startsWith("lesson 8"));
		expect(stored).toHaveLength(1);
		const out = await planEmbedRematch({
			stored,
			storedHash: sliceEmbed(BEFORE, "^0169a6")?.hash,
			sliceHash: sliceEmbed(AFTER, "^0169a6")?.hash ?? "",
			candidates: buildAnchors(sliceEmbed(AFTER, "^0169a6")?.text ?? ""),
			budget: new HostComparisonBudget(),
			yieldToHost: () => undefined,
		});
		// The renamed line keeps its sibling index and indent, so the matcher finds it at the
		// positional tier; it is placed on the renamed line either way.
		expect(out.matches).toEqual([{ tier: "positional", target: 0 }]);
		expect(out.update?.folds[0].text).toBe("lesson 8 (revised): collections and frequency counting ^0169a6");
	});
});

describe.each(MODES)("%s: GP4, an agent renames the folded line on disk while the host is open", (mode) => {
	it("the embed re-renders and Lesson 8 is still folded once the render settles; its sibling is not", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const hostBefore = await read(r.w, ROCKETSHIP);

		r.w.addNote(SOURCE, AFTER); // the agent's write
		r.w.rerender(host.embeds[0], ROCKETSHIP);
		expect(foldedRows(host.embeds[0])).toEqual([]); // just re-rendered, expanded
		await settleRestore(r.w, r.restorer);

		expect(foldedRows(host.embeds[0])).toEqual([RENAMED]);
		const unfolded = ownArrows(host.embeds[0]).filter((a) => !a.classList.contains("is-collapsed"));
		expect(unfolded.map((a) => a.parentElement?.textContent?.trim().slice(0, 24))).toEqual(["Count word frequency wit"]); // the one other row with an arrow

		// The record follows the rename, so a later edit matches against the latest state.
		const record = r.w.store.embedRecords();
		expect(record).toHaveLength(1);
		expect(record[0].contentHash).toBe(sliceEmbed(AFTER, "^0169a6")?.hash);
		expect(record[0].folds.map((f) => parseAnchor(f)?.text)).toEqual(["lesson 8 (revised): collections and frequency counting ^0169a6"]);

		// F7: both notes are exactly what was written to them.
		expect(await read(r.w, SOURCE)).toBe(AFTER);
		expect(await read(r.w, ROCKETSHIP)).toBe(hostBefore);
	});
});

describe.each(MODES)("%s: GP6, quit, a git pull rewrites the source, relaunch and open the host", (mode) => {
	it("the folds are as Dan left them", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		const stored = JSON.stringify(r.w.store.embedRecords());
		await vi.advanceTimersByTimeAsync(300); // flushed to data.json
		const flushed = r.w.saved[r.w.saved.length - 1];

		host.view.containerEl.remove(); // quit: no host is open, nothing runs
		await drain(r.w, r.restorer);
		r.w.addNote(SOURCE, AFTER); // the pull
		await vi.advanceTimersByTimeAsync(5000);
		await drain(r.w, r.restorer);
		expect(JSON.stringify(r.w.store.embedRecords())).toBe(stored); // nothing ran while closed

		// Relaunch: the old plugin instance is gone; a fresh one starts from what was flushed.
		r.restorer.dispose();
		r.w.recorder.dispose();
		const relaunched = rig();
		relaunched.w.addNote(SOURCE, AFTER);
		for (const record of (flushed as { embeds: Parameters<World["store"]["setEmbed"]>[0][] }).embeds) relaunched.w.store.setEmbed(record);
		const reopened = relaunched.w.addHost(ROCKETSHIP, mode, HOST_TEXT);
		await settleRestore(relaunched.w, relaunched.restorer);

		expect(foldedRows(reopened.embeds[0])).toEqual([RENAMED]);
		expect(ownArrows(reopened.embeds[0]).filter((a) => a.classList.contains("is-collapsed"))).toHaveLength(1); // the sibling is unfolded
		expect(await read(relaunched.w, SOURCE)).toBe(AFTER);
		expect(await read(relaunched.w, ROCKETSHIP)).toBe(HOST_TEXT);
	});
});
