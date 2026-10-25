/**
 * Ticket warkworth-31, PR-8 R1 (G17): a heading renamed in Obsidian while the host note is open.
 * Obsidian rewrites the link in the open host and re-renders its embed before the metadata events
 * reach the heading-rename tracker, so the restorer's dormancy reconcile sees the old key absent
 * first. The old key must never be stamped dormant when the rename then migrates it, and the
 * embed rendered under the new key must get its folds without waiting for another render.
 *
 * Real FoldStore, recorder, restorer, EmbedDormancyTracker and EmbedHeadingRenameTracker over the
 * mocked Obsidian app (tests/mocks/obsidian.ts); the folds are made by a trusted click. Fake
 * timers drive the render window and the wall clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbedDormancyTracker, HEADING_RENAME_GRACE_MS } from "../../src/embed-dormancy";
import type { EmbedFoldRestorer } from "../../src/embed-fold-restorer";
import { EmbedHeadingRenameTracker } from "../../src/embed-heading-rename";
import { HEADED_NOTE, HEADED_TEXT, LESSONS_NOTE, LESSONS_TEXT, SOURCE, SOURCE_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";
import type { Mode, RenderedHost } from "../fixtures/embed-recording-world";
import { attachRestorer, drain, foldedRows, settleRestore } from "../fixtures/embed-restore-world";

const HOST = "Host.md";
const OLD_LINK = "![[Headed#Lesson 8]]";
const NEW_LINK = "![[Headed#Lesson 8 (revised)]]";
const BEFORE = [
	{ heading: "Headed", level: 1 },
	{ heading: "Lesson 8", level: 2 },
	{ heading: "Lesson 9", level: 2 },
];
const AFTER = [BEFORE[0], { heading: "Lesson 8 (revised)", level: 2 }, BEFORE[2]];
const RENAMED_TEXT = HEADED_TEXT.replace("## Lesson 8", "## Lesson 8 (revised)");
const MODES: Mode[] = ["live-preview", "reading-view"];

interface Rig {
	w: World;
	restorer: EmbedFoldRestorer;
	headings: EmbedHeadingRenameTracker;
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
	for (const [path, text] of [
		[SOURCE, SOURCE_TEXT],
		[LESSONS_NOTE, LESSONS_TEXT],
		[HEADED_NOTE, HEADED_TEXT],
	]) {
		w.addNote(path, text);
	}
	const readNote = async (path: string): Promise<string | null> => {
		const file = w.app.vault.getFileByPath(path);
		return file === null ? null : await w.app.vault.cachedRead(file);
	};
	const resolveLink = (linktext: string, sourcePath: string): string | null => w.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null;
	const dormancy = new EmbedDormancyTracker({ store: w.store, readNote, resolveLink: (t) => resolveLink(t, HOST) });
	const restorer = attachRestorer(w, { dormancy });
	const headings = new EmbedHeadingRenameTracker({
		store: w.store,
		resolveLink,
		// The same wiring as src/main.ts.
		onMigrated: () => restorer.rescan(),
	});
	const made = { w, restorer, headings };
	rigs.push(made);
	return made;
}

async function openAndFold(r: Rig, mode: Mode): Promise<RenderedHost> {
	const host = r.w.addHost(HOST, mode, `${OLD_LINK}\n`);
	await settleRestore(r.w, r.restorer);
	r.w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
	await r.w.settle();
	await vi.advanceTimersByTimeAsync(150);
	r.headings.seed(HEADED_NOTE, { headings: BEFORE });
	return host;
}

/** Obsidian rewrites the link in the open host: the text, the embed's `src`, and a render. The
 * source note has not been written yet, so the embed shows nothing for the new heading. */
async function obsidianRewritesLink(r: Rig, host: RenderedHost): Promise<void> {
	host.view.data = `${NEW_LINK}\n`;
	r.w.addNote(HOST, `${NEW_LINK}\n`);
	host.embeds[0].setAttribute("src", "Headed#Lesson 8 (revised)");
	r.w.rerender(host.embeds[0], HOST);
	await settleRestore(r.w, r.restorer);
}

const records = (r: Rig) => r.w.store.embedRecords().filter((rec) => rec.host === HOST);
const everDormant = (r: Rig): boolean => records(r).some((rec) => rec.dormantSince !== undefined);

describe.each(MODES)("%s host: PR-8 R1, a heading renamed while the host is open", (mode) => {
	it("the old key is never dormant, and the embed under the new heading is folded without another render", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		expect(records(r).map((rec) => rec.subpath)).toEqual(["Lesson 8"]);

		// Real Obsidian's order: the host's link first, the source's own file two seconds later.
		await obsidianRewritesLink(r, host);
		expect(everDormant(r)).toBe(false); // the restorer's reconcile has seen the old key absent
		expect(records(r).map((rec) => rec.subpath)).toEqual(["Lesson 8"]);
		r.headings.onChanged(HOST, { embeds: [{ link: "Headed#Lesson 8 (revised)" }] });
		await vi.advanceTimersByTimeAsync(2000);
		expect(everDormant(r)).toBe(false);

		r.w.addNote(HEADED_NOTE, RENAMED_TEXT);
		r.w.rerender(host.embeds[0], HOST); // the source was written: the embed now shows the heading
		await settleRestore(r.w, r.restorer);
		expect(foldedRows(host.embeds[0])).toEqual([]); // no record under the new key yet
		r.headings.onChanged(HEADED_NOTE, { headings: AFTER });
		await settleRestore(r.w, r.restorer); // no render of the embed: only the migration's rescan

		expect(records(r).map((rec) => rec.subpath)).toEqual(["Lesson 8 (revised)"]);
		expect(everDormant(r)).toBe(false);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);

		await vi.advanceTimersByTimeAsync(HEADING_RENAME_GRACE_MS + 5000);
		await drain(r.w, r.restorer);
		expect(everDormant(r)).toBe(false);
		expect(records(r)).toHaveLength(1);
	});

	it("the other order, the renamed note first: the same outcome", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		r.w.addNote(HEADED_NOTE, RENAMED_TEXT);
		r.headings.onChanged(HEADED_NOTE, { headings: AFTER });
		await obsidianRewritesLink(r, host);
		expect(everDormant(r)).toBe(false);
		r.headings.onChanged(HOST, { embeds: [{ link: "Headed#Lesson 8 (revised)" }] });
		await settleRestore(r.w, r.restorer);

		expect(records(r).map((rec) => rec.subpath)).toEqual(["Lesson 8 (revised)"]);
		expect(everDormant(r)).toBe(false);
		expect(foldedRows(host.embeds[0]).map((t) => t.slice(0, 8))).toEqual(["Lesson 8"]);
	});

	it("a link edited by hand is still stamped dormant, once the wait is over and with no further render", async () => {
		const r = rig();
		const host = await openAndFold(r, mode);
		host.view.data = "![[Headed#Lesson 9]]\n";
		r.w.addNote(HOST, "![[Headed#Lesson 9]]\n");
		host.embeds[0].setAttribute("src", "Headed#Lesson 9");
		r.w.rerender(host.embeds[0], HOST);
		await settleRestore(r.w, r.restorer);
		expect(everDormant(r)).toBe(false);
		expect(records(r)).toHaveLength(1); // the new link created nothing

		await vi.advanceTimersByTimeAsync(HEADING_RENAME_GRACE_MS + 1000);
		await drain(r.w, r.restorer);
		expect(records(r)[0].dormantSince).toBeTypeOf("number");
		expect(records(r)[0].subpath).toBe("Lesson 8");
	});
});
