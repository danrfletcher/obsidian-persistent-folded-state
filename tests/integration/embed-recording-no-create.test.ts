/**
 * E12 (PR-4): embed state is created only when Dan folds something. Typing links, opening a host,
 * rendering all embeds, a re-render and a source edit create no `embeds` entry, and nothing is
 * written to `data.json` for them even well past the flush window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEADED_NOTE, HEADED_TEXT, LESSONS_NOTE, LESSONS_TEXT, SOURCE, SOURCE_TEXT, World, arrowFor, ownArrows } from "../fixtures/embed-recording-world";

const worlds: World[] = [];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const w of worlds.splice(0)) w.recorder.dispose();
	document.body.replaceChildren();
	vi.useRealTimers();
});

function world(): World {
	const w = new World();
	worlds.push(w);
	w.addNote(SOURCE, SOURCE_TEXT);
	w.addNote(LESSONS_NOTE, LESSONS_TEXT);
	w.addNote(HEADED_NOTE, HEADED_TEXT);
	return w;
}

async function pastFlush(w: World): Promise<void> {
	await vi.advanceTimersByTimeAsync(1000);
	await w.settle();
}

describe.each(["live-preview", "reading-view"] as const)("%s: E12, nothing but a fold creates embed state", (mode) => {
	it("opening a host and rendering all of its embeds creates no entry", async () => {
		const w = world();
		w.addHost("Rocketship.md", mode, "![[Competitive Coding Fundamentals#^0169a6]]\n\n![[Lessons]]\n\n![[Headed#Lesson 8]]\n\n![[Headed]]\n");
		await pastFlush(w);

		expect(w.store.embedSize).toBe(0);
		expect(w.saved).toEqual([]);
	});

	it("typing a new link in the host creates no entry", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		// Dan types `![[X#^id]]`: the host's text changes and Obsidian renders a new embed.
		host.view.data += "![[Competitive Coding Fundamentals#^0169a6]]\n";
		w.addNote("Host.md", host.view.data);
		host.surface.append(w.renderEmbed("Competitive Coding Fundamentals#^0169a6", "Host.md", mode));
		await pastFlush(w);

		expect(w.store.embedSize).toBe(0);
		expect(w.saved).toEqual([]);
	});

	it("a link typed half-way (not resolving to a note) creates no entry", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		for (const partial of ["![[X", "![[X#", "![[X#^", "![[X#^id]"]) {
			host.view.data = partial;
			host.surface.append(w.renderEmbed("X#^id", "Host.md", mode));
		}
		await pastFlush(w);

		expect(w.store.embedSize).toBe(0);
	});

	it("a re-render and a source edit create no entry", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.addNote(LESSONS_NOTE, `${LESSONS_TEXT}- [ ] Lesson 4: Trees\n  - [ ] DFS\n`);
		w.rerender(host.embeds[0], "Host.md");
		w.rerender(host.embeds[0], "Host.md");
		await pastFlush(w);

		expect(w.store.embedSize).toBe(0);
		expect(w.saved).toEqual([]);
	});

	it("Obsidian restoring its own fold memory on open creates no entry", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		for (const arrow of ownArrows(host.embeds[0])) w.renderToggle(arrow, true);
		await pastFlush(w);

		expect(w.store.embedSize).toBe(0);
		expect(w.saved).toEqual([]);
	});

	it("a click on something other than a fold arrow creates no entry", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		w.realClick(host.embeds[0]);
		w.realClick(host.embeds[0].querySelector("input")!);
		await pastFlush(w);

		expect(w.store.embedSize).toBe(0);
	});

	it("control: a real fold does create the entry, and it reaches data.json", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await pastFlush(w);

		expect(w.store.embedSize).toBe(1);
		expect(w.saved).toHaveLength(1);
		expect((w.saved[0] as { embeds: unknown[] }).embeds).toHaveLength(1);
	});
});
