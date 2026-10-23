import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "obsidian";
import { detectEmbedHost } from "../../src/embed-host";
import { FoldStore, STORE_VERSION } from "../../src/fold-store";
import {
	CanvasLikeView,
	MarkdownView as MockMarkdownView,
	TFile as MockTFile,
	Workspace as MockWorkspace,
	buildHoverPopover,
} from "../mocks/obsidian";
import { SEED_EMBEDS, SEED_FILES } from "../fixtures/embed-seed";

/** `<div class="internal-embed markdown-embed"><div class="markdown-embed-content">…</div></div>`,
 * the shape scripts/e2e-embed-probe.mjs saw in both host modes. Returns the embed and a child
 * element inside its content (a real fold toggle sits there). */
function makeEmbed(doc: Document = document): { embed: HTMLElement; inner: HTMLElement } {
	const embed = doc.createElement("div");
	embed.className = "internal-embed markdown-embed inline-embed is-loaded";
	embed.setAttribute("src", "Competitive Coding Fundamentals#^0169a6");
	const content = doc.createElement("div");
	content.className = "markdown-embed-content";
	const inner = doc.createElement("div");
	inner.className = "list-collapse-indicator collapse-indicator";
	content.append(inner);
	embed.append(content);
	return { embed, inner };
}

type Mode = "live-preview" | "reading-view" | "source";

function openHost(ws: MockWorkspace, path: string, mode: Mode, doc: Document = document): MockMarkdownView {
	const view = new MockMarkdownView(doc);
	view.file = new MockTFile(path);
	view.mode = mode === "reading-view" ? "preview" : "source";
	view.sourceMode = mode === "source";
	ws.addLeaf(view);
	return view;
}

/** Puts a fresh embed on the surface a view is currently showing. */
function embedInView(view: MockMarkdownView): { embed: HTMLElement; inner: HTMLElement } {
	const made = makeEmbed(view.containerEl.ownerDocument);
	(view.mode === "preview" ? view.readingSurface() : view.sourceSurface()).append(made.embed);
	return made;
}

const asWorkspace = (ws: MockWorkspace) => ws as unknown as Workspace;

describe("detectEmbedHost: hosts (E13, F3, GP1)", () => {
	it.each([{ mode: "live-preview" as const }, { mode: "reading-view" as const }])(
		"an embed inside a $mode MarkdownView is a host in that mode",
		({ mode }) => {
			const ws = new MockWorkspace();
			const view = openHost(ws, "Rocketship.md", mode);
			const { embed, inner } = embedInView(view);

			for (const el of [embed, inner]) {
				const host = detectEmbedHost(asWorkspace(ws), el);
				expect(host).not.toBeNull();
				expect(host?.mode).toBe(mode);
				expect(host?.view).toBe(view);
				expect(host?.file.path).toBe("Rocketship.md");
			}
		}
	);

	it("GP1: the embed is a host in Live Preview, and its re-rendered element is after switching to Reading view", () => {
		const ws = new MockWorkspace();
		const view = openHost(ws, "Rocketship.md", "live-preview");
		const lp = embedInView(view);
		expect(detectEmbedHost(asWorkspace(ws), lp.embed)?.mode).toBe("live-preview");

		view.mode = "preview"; // the user switches to Reading view; Obsidian renders a new embed element there
		const rv = embedInView(view);
		expect(detectEmbedHost(asWorkspace(ws), rv.embed)?.mode).toBe("reading-view");
		// The old Live Preview element is now in the hidden surface: not a host.
		expect(detectEmbedHost(asWorkspace(ws), lp.embed)).toBeNull();
	});

	it("a nested embed resolves to the same workspace view", () => {
		const ws = new MockWorkspace();
		const view = openHost(ws, "Outer.md", "reading-view");
		const { embed: outer } = embedInView(view);
		const { embed: nested } = makeEmbed();
		outer.querySelector(".markdown-embed-content")?.append(nested);
		expect(detectEmbedHost(asWorkspace(ws), nested)?.view).toBe(view);
	});

	it("the same host open in two panes yields two detections that resolve to the same file path", () => {
		const ws = new MockWorkspace();
		const first = openHost(ws, "Rocketship.md", "live-preview");
		const second = openHost(ws, "Rocketship.md", "reading-view");
		const a = detectEmbedHost(asWorkspace(ws), embedInView(first).embed);
		const b = detectEmbedHost(asWorkspace(ws), embedInView(second).embed);

		expect(a?.view).toBe(first);
		expect(b?.view).toBe(second);
		expect(a?.view).not.toBe(b?.view);
		expect(a?.file.path).toBe("Rocketship.md");
		expect(b?.file.path).toBe(a?.file.path);
	});

	it("an element in a MarkdownView pane in a pop-out window (a different ownerDocument) is still detected", () => {
		const popout = document.implementation.createHTMLDocument("pop-out");
		expect(popout).not.toBe(document);
		const ws = new MockWorkspace();
		const view = openHost(ws, "Rocketship.md", "live-preview", popout);
		const { embed } = embedInView(view);
		expect(embed.ownerDocument).toBe(popout);

		const host = detectEmbedHost(asWorkspace(ws), embed);
		expect(host?.view).toBe(view);
		expect(host?.mode).toBe("live-preview");
	});

	it("an embed in the main window is not claimed by a pop-out pane", () => {
		const popout = document.implementation.createHTMLDocument("pop-out");
		const ws = new MockWorkspace();
		openHost(ws, "Popped.md", "live-preview", popout);
		const main = openHost(ws, "Main.md", "live-preview");
		expect(detectEmbedHost(asWorkspace(ws), embedInView(main).embed)?.file.path).toBe("Main.md");
	});
});

describe("detectEmbedHost: not hosts (E13, F3) return null without throwing", () => {
	const nonMarkdownLeaf = (type: string) => (ws: MockWorkspace) => {
		const view = new CanvasLikeView(type);
		ws.addLeaf(view);
		const { embed } = makeEmbed();
		view.containerEl.append(embed);
		return embed;
	};

	const cases: { name: string; build: (ws: MockWorkspace) => Element | null | undefined }[] = [
		{ name: "an embed in Source mode", build: (ws) => embedInView(openHost(ws, "Rocketship.md", "source")).embed },
		{
			name: "an embed in a hover popover / page preview",
			build: (ws) => {
				openHost(ws, "Rocketship.md", "live-preview");
				const { embed } = makeEmbed();
				buildHoverPopover().append(embed);
				return embed;
			},
		},
		{ name: "an embed in a canvas card (the leaf's view is a canvas)", build: nonMarkdownLeaf("canvas") },
		{ name: "an embed in a Bases view (non-markdown leaf)", build: nonMarkdownLeaf("bases") },
		{ name: "an element in a graph leaf", build: nonMarkdownLeaf("graph") },
		{ name: "an element in an image leaf", build: nonMarkdownLeaf("image") },
		{
			name: "a detached embed",
			build: (ws) => {
				openHost(ws, "Rocketship.md", "live-preview");
				return makeEmbed().embed;
			},
		},
		{
			name: "an embed that was removed from its host after rendering",
			build: (ws) => {
				const { embed } = embedInView(openHost(ws, "Rocketship.md", "live-preview"));
				embed.remove();
				return embed;
			},
		},
		{
			name: "an image embed (a media embed, not a note embed)",
			build: (ws) => {
				const view = openHost(ws, "Rocketship.md", "live-preview");
				const image = document.createElement("div");
				image.className = "internal-embed media-embed image-embed is-loaded";
				view.sourceSurface().append(image);
				return image;
			},
		},
		{ name: "a null input", build: () => null },
		{ name: "an undefined input", build: () => undefined },
		{
			name: "an empty container (no embed inside)",
			build: (ws) => {
				const view = openHost(ws, "Rocketship.md", "live-preview");
				const empty = document.createElement("div");
				view.sourceSurface().append(empty);
				return empty;
			},
		},
		{
			name: "an embed in a MarkdownView with no file",
			build: (ws) => {
				const view = openHost(ws, "Rocketship.md", "live-preview");
				view.file = null;
				return embedInView(view).embed;
			},
		},
		{
			name: "an embed in the hidden Live Preview surface of a view that is in Reading view",
			build: (ws) => {
				const view = openHost(ws, "Rocketship.md", "reading-view");
				const { embed } = makeEmbed();
				view.sourceSurface().append(embed);
				return embed;
			},
		},
		{
			name: "an embed in a view's chrome outside both surfaces",
			build: (ws) => {
				const view = openHost(ws, "Rocketship.md", "live-preview");
				const { embed } = makeEmbed();
				view.containerEl.append(embed);
				return embed;
			},
		},
		{ name: "a non-element node", build: () => document.createTextNode("x") as unknown as Element },
	];

	it.each(cases)("$name", ({ build }) => {
		const ws = new MockWorkspace();
		const el = build(ws);
		expect(() => detectEmbedHost(asWorkspace(ws), el)).not.toThrow();
		expect(detectEmbedHost(asWorkspace(ws), el)).toBeNull();
	});

	it("an empty workspace has no hosts", () => {
		expect(detectEmbedHost(asWorkspace(new MockWorkspace()), makeEmbed().embed)).toBeNull();
	});
});

describe("detectEmbedHost: only .internal-embed containers (F3)", () => {
	it("a Reading view note with no embed gives no hosts, for its body and every element in it", () => {
		const ws = new MockWorkspace();
		const view = openHost(ws, "Plain.md", "reading-view");
		const body = document.createElement("div");
		body.className = "markdown-preview-sizer markdown-preview-section";
		const item = document.createElement("li");
		const toggle = document.createElement("div");
		toggle.className = "list-collapse-indicator collapse-indicator";
		item.append(toggle);
		body.append(item);
		view.readingSurface().append(body);

		for (const el of [view.readingSurface(), view.containerEl, body, item, toggle]) {
			expect(detectEmbedHost(asWorkspace(ws), el)).toBeNull();
		}
	});

	it("the same holds in Live Preview for the editor body", () => {
		const ws = new MockWorkspace();
		const view = openHost(ws, "Plain.md", "live-preview");
		const line = document.createElement("div");
		line.className = "cm-line";
		view.sourceSurface().append(line);
		expect(detectEmbedHost(asWorkspace(ws), view.sourceSurface())).toBeNull();
		expect(detectEmbedHost(asWorkspace(ws), line)).toBeNull();
	});

	it("an element beside an embed (not inside it) is not a host", () => {
		const ws = new MockWorkspace();
		const view = openHost(ws, "Rocketship.md", "live-preview");
		const { embed } = embedInView(view);
		const sibling = document.createElement("p");
		embed.after(sibling);
		expect(detectEmbedHost(asWorkspace(ws), sibling)).toBeNull();
	});
});

describe("detectEmbedHost: creates no state (F3, rules 2 and 8, E12)", () => {
	it("leaves the store's embeds and files sections, the leaves and the DOM exactly as they were, and saves nothing", async () => {
		const saveData = vi.fn(async (_data: unknown) => undefined);
		const store = new FoldStore({
			loadData: async () => structuredClone({ version: STORE_VERSION, files: SEED_FILES, embeds: SEED_EMBEDS }),
			saveData,
		});
		await store.load();
		const embedsBefore = structuredClone(store.embedRecords());
		const filesBefore = structuredClone(Object.fromEntries(Object.keys(SEED_FILES).map((path) => [path, store.get(path)])));

		const ws = new MockWorkspace();
		const view = openHost(ws, "Rocketship.md", "live-preview");
		const { embed, inner } = embedInView(view);
		const htmlBefore = view.containerEl.outerHTML;
		const stateBefore = JSON.stringify(view.getState());
		let leavesBefore = 0;
		ws.iterateAllLeaves(() => leavesBefore++);

		for (const el of [embed, inner, embed]) expect(detectEmbedHost(asWorkspace(ws), el)).not.toBeNull();

		let leavesAfter = 0;
		ws.iterateAllLeaves(() => leavesAfter++);
		expect(leavesAfter).toBe(leavesBefore);
		expect(view.containerEl.outerHTML).toBe(htmlBefore);
		expect(JSON.stringify(view.getState())).toBe(stateBefore);
		expect(store.embedRecords()).toEqual(embedsBefore);
		expect(Object.fromEntries(Object.keys(SEED_FILES).map((path) => [path, store.get(path)]))).toEqual(filesBefore);
		expect(saveData).not.toHaveBeenCalled();
	});
});
