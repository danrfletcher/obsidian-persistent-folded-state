/**
 * The edges of the embed recorder (PR-4, G1, E3, E9, never-break rule 2) over the same jsdom hosts
 * as embed-recording-dom.test.ts: input shapes that are not a plain click, a recorder whose reads
 * or store fail, an embed whose source changed under the click, and a recorder that is detached or
 * disposed part-way. Every one of these must record nothing wrong and throw nothing into the page.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEADED_NOTE, HEADED_TEXT, LESSONS_NOTE, LESSONS_TEXT, SOURCE, SOURCE_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";
import type { Mode } from "../fixtures/embed-recording-world";
import type { EmbedFoldRecorderDeps } from "../../src/embed-fold-recorder";

const LESSON_2 = { kind: "task", indent: 0, text: "lesson 2: maps", siblingIndex: 1, parentChain: [] };
const MODES: Mode[] = ["live-preview", "reading-view"];

const worlds: World[] = [];
function world(overrides: ConstructorParameters<typeof World>[0] = {}): World {
	const w = new World(overrides);
	w.addNote(SOURCE, SOURCE_TEXT);
	w.addNote(LESSONS_NOTE, LESSONS_TEXT);
	w.addNote(HEADED_NOTE, HEADED_TEXT);
	worlds.push(w);
	return w;
}

/** A world whose deps can reach the world itself (to dispose its recorder from inside a read). */
function selfReferringWorld(make: (w: () => World) => Partial<EmbedFoldRecorderDeps>): World {
	let self: World | undefined;
	const w = world(make(() => self as World));
	self = w;
	return w;
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
	for (const w of worlds.splice(0)) w.recorder.dispose();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe.each(MODES)("%s host: input that is not a plain click", (mode) => {
	it("a click on the document itself (a target with no closest) is ignored", async () => {
		const w = world();
		w.addHost("Host.md", mode, "![[Lessons]]\n");
		const event = new MouseEvent("click", { bubbles: true });
		w.trusted.add(event);

		expect(() => document.dispatchEvent(event)).not.toThrow();
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("an Enter key press on text that is not an arrow records nothing", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.keyPress(host.embeds[0].querySelector("li") as HTMLElement);
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("a key other than Enter or Space on an arrow records nothing", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.keyPress(arrowFor(host.embeds[0], "Lesson 2"), "a");
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("a trusted key press on the arrow followed by the pointer click it comes with is one fold, not two", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const lesson2 = arrowFor(host.embeds[0], "Lesson 2");
		const key = new KeyboardEvent("keydown", { key: " ", bubbles: true });
		w.trusted.add(key);
		lesson2.dispatchEvent(key);

		w.realClick(lesson2);
		await w.settle();

		expect(lesson2.classList.contains("is-collapsed")).toBe(true);
		expect(w.store.embedRecords().map((r) => r.folds)).toEqual([[LESSON_2]]);
	});

	it("without the isTrusted seam, jsdom's untrusted events are not the user's (the platform flag is what counts)", async () => {
		const w = world({ isTrusted: undefined });
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});
});

describe.each(MODES)("%s host: what a user input is credited with", (mode) => {
	it("a fold and a render-time toggle in the same burst: only the user's own change is recorded", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const lesson2 = arrowFor(host.embeds[0], "Lesson 2");

		w.realClick(lesson2);
		w.renderToggle(lesson2, false);
		await w.settle();

		expect(w.store.embedRecords().map((r) => r.folds)).toEqual([[LESSON_2]]);
	});

	it("an arrow whose class attribute is cleared and set again in the same burst still records only the user's fold", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const lesson2 = arrowFor(host.embeds[0], "Lesson 2");

		w.realClick(lesson2);
		lesson2.removeAttribute("class");
		lesson2.setAttribute("class", "list-collapse-indicator collapse-indicator is-collapsed");
		await w.settle();

		expect(w.store.embedRecords().map((r) => r.folds)).toEqual([[LESSON_2]]);
	});

	it("an input Obsidian does not act on leaves the arrow armed only for a moment; an unrelated class change is not a fold", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		const lesson2 = arrowFor(host.embeds[0], "Lesson 2");
		// A trusted key press with no click after it: nothing toggles the arrow.
		const key = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
		w.trusted.add(key);
		lesson2.dispatchEvent(key);

		lesson2.classList.add("hover");
		await w.settle();
		expect(w.store.embedSize).toBe(0);

		// Once the window has passed, a render-time toggle of that arrow is nobody's click.
		await pause(400);
		w.renderToggle(lesson2, true);
		await w.settle();
		expect(w.store.embedSize).toBe(0);
	});
});

describe.each(MODES)("%s host: the src of the embed element", (mode) => {
	it("a percent-encoded src records under the decoded link", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Competitive Coding Fundamentals#^0169a6]]\n");
		host.embeds[0].setAttribute("src", "Competitive%20Coding%20Fundamentals#^0169a6");

		w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
		await w.settle();

		expect(w.store.embedRecords().map((r) => [r.target, r.subpath, r.occurrence])).toEqual([[SOURCE, "^0169a6", 0]]);
	});

	it("a src with a percent sign that does not decode matches no embed of the host and records nothing", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		host.embeds[0].setAttribute("src", "Lessons%E0%A4%A");

		expect(() => w.realClick(arrowFor(host.embeds[0], "Lesson 2"))).not.toThrow();
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("an embed element with no src attribute records nothing", async () => {
		const w = world();
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");
		host.embeds[0].removeAttribute("src");

		expect(() => w.realClick(arrowFor(host.embeds[0], "Lesson 2"))).not.toThrow();
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});
});

describe.each(MODES)("%s host: a recorder whose position or reads fail, or whose source changed", (mode) => {
	it("a position reader that throws leaves the embed to be told apart by the DOM, and the fold is still recorded", async () => {
		const w = world({
			positionOf: () => {
				throw new Error("no position");
			},
		});
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n\n![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[1], "Lesson 2"));
		await w.settle();

		expect(w.store.getEmbed({ host: "Host.md", target: LESSONS_NOTE, subpath: "", occurrence: 1 })?.folds).toEqual([LESSON_2]);
	});

	it("a workspace that throws while the host is looked up is logged, not thrown into the page", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const w = world({
			workspace: {
				iterateAllLeaves: () => {
					throw new Error("workspace gone");
				},
			} as unknown as EmbedFoldRecorderDeps["workspace"],
		});
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		expect(() => w.realClick(arrowFor(host.embeds[0], "Lesson 2"))).not.toThrow();
		await w.settle();

		expect(error).toHaveBeenCalled();
		expect(w.store.embedSize).toBe(0);
	});

	it("a store that throws on write is logged, and the next click still records", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
		let failures = 1;
		const w = selfReferringWorld((self) => ({
			store: {
				getEmbed: (id) => self().store.getEmbed(id),
				setEmbed: (record) => {
					if (failures-- > 0) throw new Error("disk full");
					self().store.setEmbed(record);
				},
			},
		}));
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 1"));
		await w.settle();
		expect(error).toHaveBeenCalledWith(expect.stringContaining("recording an embed fold failed"), expect.any(Error));
		expect(w.store.embedSize).toBe(0);

		w.realClick(arrowFor(host.embeds[0], "Lesson 3"));
		await w.settle();
		expect(w.store.embedRecords().map((r) => r.folds.map((f) => f.text))).toEqual([["lesson 3: graphs"]]);
	});

	it("a host whose text no longer holds the embed records nothing", async () => {
		const w = world({ readHostText: () => "the embed was deleted\n" });
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("a heading that is gone from the target note records nothing", async () => {
		const w = world({ readNote: async () => "# Something else\n- [ ] x\n  - [ ] y\n" });
		const host = w.addHost("Host.md", mode, "![[Headed#Lesson 8]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 8"));
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("a row the target note no longer has records nothing, rather than a guess", async () => {
		const w = world({ readNote: async () => "- [ ] Changed\n  - [ ] sub\n" });
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("a recorder disposed while the host text is being read records nothing", async () => {
		const w = selfReferringWorld((self) => ({
			readHostText: () => {
				self().recorder.dispose();
				return "![[Lessons]]\n";
			},
		}));
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});

	it("a recorder disposed while the target note is being read records nothing", async () => {
		const w = selfReferringWorld((self) => ({
			readNote: async () => {
				self().recorder.dispose();
				return LESSONS_TEXT;
			},
		}));
		const host = w.addHost("Host.md", mode, "![[Lessons]]\n");

		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await w.settle();

		expect(w.store.embedSize).toBe(0);
	});
});

describe("detaching one document", () => {
	it("a detached document records nothing, detaching it twice is harmless, and it can be attached again", async () => {
		const w = world();
		const host = w.addHost("Host.md", "live-preview", "![[Lessons]]\n");

		w.recorder.detach(document);
		expect(() => w.recorder.detach(document)).not.toThrow();
		w.realClick(arrowFor(host.embeds[0], "Lesson 1"));
		await w.settle();
		expect(w.store.embedSize).toBe(0);

		w.recorder.attach(document);
		w.realClick(arrowFor(host.embeds[0], "Lesson 2"));
		await w.settle();
		expect(w.store.embedRecords().map((r) => r.folds)).toEqual([[LESSON_2]]);
	});
});
