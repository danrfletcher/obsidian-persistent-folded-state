/**
 * Recording folds inside embeds, over jsdom hosts whose embed containers are shaped as the
 * real-Obsidian probe recorded them (PR-4, G1, G16, E3, E13, E9; docs/embed-probe.md). The
 * Obsidian app and workspace are the mocks in tests/mocks/obsidian.ts; the store and the recorder
 * are the real ones.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import type { PluginManifest } from "obsidian";
import { CanvasLikeView, buildHoverPopover } from "../mocks/obsidian";
import PersistentFoldedStatePlugin from "../../src/main";
import { EmbedFoldRecorder } from "../../src/embed-fold-recorder";
import { EMBED_CAPABILITIES } from "../../src/embed-capabilities";
import type { EmbedCapability, EmbedHostModeId, EmbedKind } from "../../src/embed-capabilities";
import { HEADED_NOTE, HEADED_TEXT, LESSONS_NOTE, LESSONS_TEXT, MIXED_NOTE, MIXED_TEXT, SOURCE, SOURCE_TEXT, World, arrowFor, ownArrows } from "../fixtures/embed-recording-world";
import type { Mode } from "../fixtures/embed-recording-world";

const LESSON_2 = { kind: "task", indent: 0, text: "lesson 2: maps", siblingIndex: 1, parentChain: [] };
const COUNT_FREQ = { kind: "task", indent: 2, text: "count word frequency", siblingIndex: 0, parentChain: [{ kind: "task", text: "lesson 2: maps" }] };
const LESSON_8_BLOCK = {
	kind: "task",
	indent: 0,
	text: "lesson 8: collections and frequency counting ^0169a6",
	siblingIndex: 0,
	parentChain: [],
};
const HEADING_LESSON_8 = { kind: "heading", indent: 0, text: "lesson 8", siblingIndex: 0, parentChain: [] };

const OUTER_NOTE = "Outer.md";
const OUTER_TEXT = ["# Outer", "", "- [ ] Outer item", "  - [ ] Outer sub", "", "![[Lessons]]", ""].join("\n");

const MODES: Mode[] = ["live-preview", "reading-view"];

function newWorld(overrides: ConstructorParameters<typeof World>[0] = {}): World {
	const world = new World(overrides);
	world.addNote(SOURCE, SOURCE_TEXT);
	world.addNote(LESSONS_NOTE, LESSONS_TEXT);
	world.addNote(HEADED_NOTE, HEADED_TEXT);
	world.addNote(MIXED_NOTE, MIXED_TEXT);
	world.addNote(OUTER_NOTE, OUTER_TEXT);
	return world;
}

const worlds: World[] = [];
function world(overrides: ConstructorParameters<typeof World>[0] = {}): World {
	const w = newWorld(overrides);
	worlds.push(w);
	return w;
}

afterEach(() => {
	for (const w of worlds.splice(0)) w.recorder.dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

const ROCKETSHIP = "Salesforce Tech Test Rocketship Course.md";

describe.each(MODES)("%s host: a click on an arrow inside an embed is recorded (G1)", (mode) => {
	it("block embed (GP1/GP2): opening records nothing; folding Lesson 8 stores it under the embed's key; the source's own state is untouched", async () => {
		const w = world();
		const host = w.addHost(ROCKETSHIP, mode, "![[Competitive Coding Fundamentals#^0169a6]]\n");
		await w.settle();
		expect(w.store.embedSize).toBe(0);

		w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
		await w.settle();

		expect(w.store.embedRecords()).toEqual([
			{
				host: ROCKETSHIP,
				target: SOURCE,
				subpath: "^0169a6",
				occurrence: 0,
				contentHash: expect.any(String),
				folds: [LESSON_8_BLOCK],
				dormant: [],
			},
		]);
		expect(w.store.size).toBe(0);
		expect(w.store.get(SOURCE)).toBeUndefined();
	});

	it("a row with a hidden block id and a piped link is found by what Obsidian shows, even when the arrow and foldable counts differ (R1)", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Mixed]]\n");
		const embed = host.embeds[0];
		// The row shows no "^b2" and the alias in place of the link; the continuation-line item has no arrow.
		expect(arrowFor(embed, "See the other note").parentElement?.textContent).not.toContain("^b2");
		expect(ownArrows(embed)).toHaveLength(1);

		w.realClick(arrowFor(embed, "See the other note"));
		await w.settle();

		expect(w.store.embedRecords().map((r) => r.folds)).toEqual([
			[{ kind: "task", indent: 0, text: "see [[other note|the other note]] ^b2", siblingIndex: 1, parentChain: [] }],
		]);
	});

	it("heading embed: the heading's arrow and a task's arrow inside it are two distinct anchors", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Headed#Lesson 8]]\n");
		const embed = host.embeds[0];

		w.realClick(arrowFor(embed, "Lesson 8"));
		w.realClick(arrowFor(embed, "Count word frequency"));
		await w.settle();

		const record = w.store.getEmbed({ host: "Host.md", target: HEADED_NOTE, subpath: "Lesson 8", occurrence: 0 });
		expect(record?.folds).toEqual([
			HEADING_LESSON_8,
			{ kind: "task", indent: 0, text: "count word frequency", siblingIndex: 0, parentChain: [{ kind: "heading", text: "lesson 8" }] },
		]);
	});

	it("whole-note embed: folding Lesson 2 stores exactly that anchor and no other block", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await w.settle();

		expect(w.store.embedRecords().map((r) => r.folds)).toEqual([[LESSON_2]]);
	});

	it("unfolding removes that anchor from the stored set", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const lesson2 = arrowFor(host.embeds[0], "Lesson 2");

		w.realClick(lesson2);
		await w.settle();
		expect(w.store.embedRecords()[0].folds).toEqual([LESSON_2]);

		w.realClick(lesson2);
		await w.settle();
		expect(lesson2.classList.contains("is-collapsed")).toBe(false);
		expect(w.store.embedRecords()[0].folds).toEqual([]);
	});

	it("folding a parent and its child stores two anchors, and unfolding the parent keeps the child's", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const embed = host.embeds[0];

		w.realClick(arrowFor(embed, "Lesson 2"));
		w.realClick(arrowFor(embed, "Count word frequency"));
		await w.settle();
		expect(w.store.embedRecords()[0].folds).toEqual([LESSON_2, COUNT_FREQ]);

		w.realClick(arrowFor(embed, "Lesson 2"));
		await w.settle();
		expect(w.store.embedRecords()[0].folds).toEqual([COUNT_FREQ]);
	});

	it("a click in an embed with no stored state creates the entry with only that fold; other blocks stay absent", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		expect(ownArrows(host.embeds[0]).length).toBeGreaterThan(2);

		w.realClick(arrowFor(host.embeds[0], "Lesson 1"));
		await w.settle();

		const folds = w.store.embedRecords()[0].folds;
		expect(folds).toHaveLength(1);
		expect(folds[0]).toMatchObject({ text: "lesson 1: arrays" });
	});

	it("an unfold click in an embed with no stored state creates no entry (G16)", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const lesson2 = arrowFor(host.embeds[0], "Lesson 2");
		// Obsidian itself had it folded (its own memory); Dan unfolds it.
		w.renderToggle(lesson2, true);

		w.realClick(lesson2);
		await w.settle();

		expect(lesson2.classList.contains("is-collapsed")).toBe(false);
		expect(w.store.embedSize).toBe(0);
	});

	it("rapid fold, unfold, fold on one arrow: the stored state matches the last click, with no duplicate anchors", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const lesson2 = arrowFor(host.embeds[0], "Lesson 2");

		w.realClick(lesson2);
		w.realClick(lesson2);
		w.realClick(lesson2);
		await w.settle();

		expect(lesson2.classList.contains("is-collapsed")).toBe(true);
		expect(w.store.embedRecords()).toHaveLength(1);
		expect(w.store.embedRecords()[0].folds).toEqual([LESSON_2]);
	});

	it("rapid fold, unfold, fold, unfold ends with the anchor gone", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const lesson2 = arrowFor(host.embeds[0], "Lesson 2");

		for (let i = 0; i < 4; i++) w.realClick(lesson2);
		await w.settle();

		expect(lesson2.classList.contains("is-collapsed")).toBe(false);
		expect(w.store.embedRecords()[0].folds).toEqual([]);
	});

	it("two identical embeds in one host: a click in the second writes occurrence 1 and leaves 0 alone", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n\nbetween\n\n![[Lessons]]\n");
		expect(host.embeds).toHaveLength(2);

		w.realClick(arrowFor(host.embeds[1], "Lesson 2"));
		await w.settle();

		const key = { host: "Host.md", target: LESSONS_NOTE, subpath: "" };
		expect(w.store.getEmbed({ ...key, occurrence: 0 })).toBeUndefined();
		expect(w.store.getEmbed({ ...key, occurrence: 1 })?.folds).toEqual([LESSON_2]);
		expect(w.store.embedSize).toBe(1);
	});

	it("two identical embeds: a fold in each is stored under its own index", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n\n![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 1"));
		w.realClick(arrowFor(host.embeds[1], "Lesson 3"));
		await w.settle();

		const key = { host: "Host.md", target: LESSONS_NOTE, subpath: "" };
		expect(w.store.getEmbed({ ...key, occurrence: 0 })?.folds.map((f) => f.text)).toEqual(["lesson 1: arrays"]);
		expect(w.store.getEmbed({ ...key, occurrence: 1 })?.folds.map((f) => f.text)).toEqual(["lesson 3: graphs"]);
	});

	it("the host open in two panes: a click in either pane writes the one entry for that embed", async () => {
		const w = world();
		const text = "![[Lessons]]\n";
		const paneA = w.addHost("Host.md", mode, text);
		const paneB = w.addHost("Host.md", mode, text);

		w.realClick(arrowFor(paneA.embeds[0], "Lesson 2"));
		await w.settle();
		expect(w.store.embedSize).toBe(1);

		w.realClick(arrowFor(paneB.embeds[0], "Lesson 1"));
		await w.settle();

		expect(w.store.embedSize).toBe(1);
		expect(w.store.embedRecords()[0].folds.map((f) => f.text)).toEqual(["lesson 2: maps", "lesson 1: arrays"]);
	});

	it("nested embed: a click inside the inner embed is keyed by the chain and does not write the outer embed's entry", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Outer]]\n");
		const outer = host.embeds[0];
		const inner = outer.querySelector<HTMLElement>(".internal-embed")!;
		expect(inner).not.toBeNull();

		w.realClick(arrowFor(inner, "Lesson 2"));
		await w.settle();

		expect(w.store.embedRecords()).toHaveLength(1);
		const record = w.store.embedRecords()[0];
		expect(record).toMatchObject({
			host: "Host.md",
			target: LESSONS_NOTE,
			subpath: "",
			occurrence: 0,
			outer: [{ target: OUTER_NOTE, subpath: "", occurrence: 0 }],
		});
		expect(record.folds).toEqual([LESSON_2]);
		// Not the outer embed's entry, and not the flat key for the inner content either.
		expect(w.store.getEmbed({ host: "Host.md", target: OUTER_NOTE, subpath: "", occurrence: 0 })).toBeUndefined();
		expect(w.store.getEmbed({ host: "Host.md", target: LESSONS_NOTE, subpath: "", occurrence: 0 })).toBeUndefined();
	});

	it("nested embed: a click on the outer embed's own arrow writes the outer entry, not the inner one", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Outer]]\n");

		w.realClick(arrowFor(host.embeds[0], "Outer item"));
		await w.settle();

		expect(w.store.embedRecords()).toHaveLength(1);
		expect(w.store.embedRecords()[0]).toMatchObject({ target: OUTER_NOTE, subpath: "" });
		expect(w.store.embedRecords()[0].outer).toBeUndefined();
	});

	it("keyboard activation on the arrow is the user's and is recorded once", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.keyPress(arrowFor(host.embeds[0], "Lesson 2"));
		await w.settle();

		expect(w.store.embedRecords()[0].folds).toEqual([LESSON_2]);
	});
});

describe.each(MODES)("%s host: nothing but the user's own click is recorded", (mode) => {
	it("a scripted click on the arrow (no real pointer event) toggles it but records nothing", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const lesson2 = arrowFor(host.embeds[0], "Lesson 2");

		w.scriptedClick(lesson2);
		await w.settle();

		expect(lesson2.classList.contains("is-collapsed")).toBe(true);
		expect(w.store.embedSize).toBe(0);
	});

	it("Obsidian's render-time folds (restoring its own memory) record nothing", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		for (const arrow of ownArrows(host.embeds[0])) w.renderToggle(arrow, true);
		await w.settle();
		for (const arrow of ownArrows(host.embeds[0])) w.renderToggle(arrow, false);
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("a re-render after a source edit records nothing", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		w.addNote(LESSONS_NOTE, `${LESSONS_TEXT}- [ ] Lesson 4: Trees\n  - [ ] DFS\n`);

		w.rerender(host.embeds[0], "Host.md");
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("E3: a click that lands between two renders is stored, and the render after it does not undo the entry", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const embed = host.embeds[0];

		// First render burst: Obsidian folds Lesson 1 itself.
		w.renderToggle(arrowFor(embed, "Lesson 1"), true);
		// Dan clicks Lesson 2 in the middle of it.
		w.realClick(arrowFor(embed, "Lesson 2"));
		await w.settle();
		const stored = structuredClone(w.store.embedRecords());
		expect(stored[0].folds).toEqual([LESSON_2]);

		// Second render burst: Obsidian re-renders, restores and unfolds on its own.
		w.renderToggle(arrowFor(embed, "Lesson 2"), false);
		w.renderToggle(arrowFor(embed, "Lesson 3"), true);
		w.rerender(embed, "Host.md");
		await w.settle();

		expect(w.store.embedRecords()).toEqual(stored);
	});

	it("a click on text that is not an arrow records nothing", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.realClick(host.embeds[0].querySelector("li")!);
		w.realClick(host.surface);
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("an arrow in the host's own body (not inside an embed) records nothing", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "- host item\n  - child\n");
		const row = document.createElement("li");
		const arrow = document.createElement("div");
		arrow.className = "list-collapse-indicator collapse-indicator";
		row.append(arrow);
		host.surface.append(row);

		w.realClick(arrow);
		await w.settle();

		expect(w.store.embedSize).toBe(0);
		expect(w.store.size).toBe(0);
	});

	it("image, PDF and audio embeds write nothing", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "");
		for (const kind of ["image-embed", "pdf-embed", "audio-embed"]) {
			const el = document.createElement("div");
			el.className = `internal-embed media-embed ${kind} is-loaded`;
			el.setAttribute("src", `file.${kind}`);
			const arrow = document.createElement("div");
			arrow.className = "list-collapse-indicator collapse-indicator";
			el.append(arrow);
			host.surface.append(el);
			w.realClick(arrow);
		}
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("an embed whose target is gone records nothing and throws nothing", async () => {
		const w = world({ readNote: async () => null });
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		expect(() => w.realClick(arrowFor(host.embeds[0], "Lesson 2"))).not.toThrow();
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("a host whose text cannot be read records nothing and throws nothing", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const w = world({
			readHostText: () => {
				throw new Error("gone");
			},
		});
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		expect(() => w.realClick(arrowFor(host.embeds[0], "Lesson 2"))).not.toThrow();
		await w.settle();

		expect(w.store.embedSize).toBe(0);
		expect(error).toHaveBeenCalled();
	});
});

describe("E13: containers that are not a workspace markdown view are ignored", () => {
	it("an embed in a hover preview or page preview", async () => {
		const w = world();
		// A real markdown host is open too, so recording into it would be possible if the check failed.
		w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		const popover = buildHoverPopover();
		const embed = w.renderEmbed("Lessons", "Host.md", "reading-view");
		popover.append(embed);

		w.realClick(arrowFor(embed, "Lesson 2"));
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("an embed in a canvas card (the leaf's view is not a markdown view)", async () => {
		const w = world();
		// A real markdown host is open too, so recording into it would be possible if the check failed.
		w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		const canvas = new CanvasLikeView("canvas");
		w.app.workspace.addLeaf(canvas);
		document.body.append(canvas.containerEl);
		const embed = w.renderEmbed("Lessons", "Host.md", "live-preview");
		canvas.containerEl.append(embed);

		w.realClick(arrowFor(embed, "Lesson 2"));
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("an embed in a Bases view", async () => {
		const w = world();
		// A real markdown host is open too, so recording into it would be possible if the check failed.
		w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		const bases = new CanvasLikeView("bases");
		w.app.workspace.addLeaf(bases);
		document.body.append(bases.containerEl);
		const embed = w.renderEmbed("Lessons", "Host.md", "live-preview");
		bases.containerEl.append(embed);

		w.realClick(arrowFor(embed, "Lesson 2"));
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("an embed in a host shown in Source mode (no rendered embeds there)", async () => {
		const w = world();
		const host = w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		host.view.sourceMode = true;

		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});
});

describe("G18: a combination the probe could not show to be supported is skipped", () => {
	function withGap(mode: EmbedHostModeId, kind: EmbedKind): Record<EmbedHostModeId, Record<EmbedKind, EmbedCapability>> {
		const copy = structuredClone(EMBED_CAPABILITIES) as Record<EmbedHostModeId, Record<EmbedKind, EmbedCapability>>;
		copy[mode][kind] = { verdict: "unsupported", reason: "not observable" };
		return copy;
	}

	it("records nothing for the gap and still records the supported combinations, throwing nothing", async () => {
		const w = world({ capabilities: withGap("live-preview", "whole-note") });
		const host = w.addHost("Host.md", "live-preview", "![[Lessons]]\n\n![[Headed#Lesson 8]]\n");

		expect(() => w.realClick(arrowFor(host.embeds[0], "Lesson 2"))).not.toThrow();
		await w.settle();
		expect(w.store.embedSize).toBe(0);

		w.realClick(arrowFor(host.embeds[1], "Lesson 8"));
		await w.settle();
		expect(w.store.embedRecords().map((r) => r.subpath)).toEqual(["Lesson 8"]);
	});

	it("a gap in one host mode leaves the other mode recording", async () => {
		const w = world({ capabilities: withGap("reading-view", "block") });
		const reading = w.addHost("Host.md", "reading-view", "![[Competitive Coding Fundamentals#^0169a6]]\n");
		const live = w.addHost("Other.md", "live-preview", "![[Competitive Coding Fundamentals#^0169a6]]\n");

		w.realClick(arrowFor(reading.embeds[0], "Lesson 8"));
		w.realClick(arrowFor(live.embeds[0], "Lesson 8"));
		await w.settle();

		expect(w.store.embedRecords().map((r) => r.host)).toEqual(["Other.md"]);
	});

	it("when no combination is supported the recorder registers no listener at all", () => {
		const none = structuredClone(EMBED_CAPABILITIES) as Record<EmbedHostModeId, Record<EmbedKind, EmbedCapability>>;
		for (const mode of Object.keys(none) as EmbedHostModeId[]) {
			for (const kind of Object.keys(none[mode]) as EmbedKind[]) none[mode][kind] = { verdict: "unsupported", reason: "probe" };
		}
		const w = world();
		const add = vi.spyOn(document, "addEventListener");

		const recorder = new EmbedFoldRecorder({ ...w.deps(), capabilities: none });
		expect(() => recorder.attach(document)).not.toThrow();

		expect(add).not.toHaveBeenCalled();
		recorder.dispose();
	});
});

describe("E9: unload removes every embed listener", () => {
	it("dispose removes each capture listener it added, from the same document", () => {
		const add = vi.spyOn(document, "addEventListener");
		const remove = vi.spyOn(document, "removeEventListener");
		const w = world();
		const added = add.mock.calls.filter((c) => ["pointerdown", "keydown", "click"].includes(c[0])).map((c) => [c[0], c[1]]);
		expect(added.map((a) => a[0]).sort()).toEqual(["click", "keydown", "pointerdown"]);

		w.recorder.dispose();

		for (const [type, listener] of added) {
			expect(remove.mock.calls.some((c) => c[0] === type && c[1] === listener && (c[2] as { capture?: boolean }).capture === true)).toBe(true);
		}
	});

	it("a click after dispose records nothing", async () => {
		const w = world();
		const host = w.addHost("Host.md", "live-preview", "![[Lessons]]\n");
		w.recorder.dispose();

		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("a click just before dispose, whose recording had not run yet, is not recorded", async () => {
		const w = world();
		const host = w.addHost("Host.md", "live-preview", "![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		w.recorder.dispose();
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("disposing twice, or attaching after dispose, is harmless and registers nothing", () => {
		const w = world();
		w.recorder.dispose();
		const add = vi.spyOn(document, "addEventListener");
		expect(() => w.recorder.dispose()).not.toThrow();
		w.recorder.attach(document);
		expect(add).not.toHaveBeenCalled();
	});

	const manifest: PluginManifest = {
		id: "persistent-folded-state",
		name: "Persistent Folded State",
		version: "0.1.1",
		minAppVersion: "1.13.0",
		description: "test",
		author: "Dan Fletcher",
		isDesktopOnly: false,
	};

	it("disabling the plugin removes every document listener the plugin added", async () => {
		const add = vi.spyOn(document, "addEventListener");
		const remove = vi.spyOn(document, "removeEventListener");
		const plugin = new PersistentFoldedStatePlugin(new App(), manifest);

		await plugin.onload();
		const embedListeners = add.mock.calls.filter((c) => ["pointerdown", "keydown", "click"].includes(c[0]) && (c[2] as { capture?: boolean })?.capture === true);
		expect(embedListeners.map((c) => c[0]).sort()).toEqual(["click", "keydown", "pointerdown"]);

		plugin.unload();

		for (const [type, listener] of embedListeners) {
			expect(remove.mock.calls.some((c) => c[0] === type && c[1] === listener && (c[2] as { capture?: boolean }).capture === true)).toBe(true);
		}
	});

	it("re-enabling the plugin attaches again", async () => {
		const add = vi.spyOn(document, "addEventListener");
		const app = new App();
		const first = new PersistentFoldedStatePlugin(app, manifest);
		await first.onload();
		first.unload();
		add.mockClear();

		const second = new PersistentFoldedStatePlugin(app, manifest);
		await second.onload();

		expect(add.mock.calls.filter((c) => c[0] === "click" && (c[2] as { capture?: boolean })?.capture === true)).toHaveLength(1);
		second.unload();
	});
});
