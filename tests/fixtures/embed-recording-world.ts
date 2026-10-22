/**
 * A jsdom world for the embed-recording tests (ticket warkworth-21, PR-4): the mock Obsidian app
 * and workspace, a real `FoldStore`, a real `EmbedFoldRecorder`, and host views whose surfaces
 * hold embed containers shaped as the real-Obsidian probe recorded them (docs/embed-probe.md):
 *
 *   div|span.internal-embed.markdown-embed.inline-embed.is-loaded[src]
 *     > div.markdown-embed-content
 *       > ul > li > div.list-collapse-indicator.collapse-indicator   (only on items with children)
 *       > h2 > div.heading-collapse-indicator.collapse-indicator
 *
 * Clicking an arrow flips `is-collapsed` on the arrow and on its row, as Obsidian's own handler
 * does. Real input is simulated as the pointer sequence and click a person produces, marked
 * trusted through the recorder's `isTrusted` seam (jsdom marks every event untrusted); a scripted
 * click is `el.click()`, untrusted with no pointer events; a render-time toggle flips the classes
 * with no input at all.
 */
import { App, MarkdownView, TFile } from "../mocks/obsidian";
import { FoldStore } from "../../src/fold-store";
import { EmbedFoldRecorder } from "../../src/embed-fold-recorder";
import type { EmbedFoldRecorderDeps } from "../../src/embed-fold-recorder";
import { findEmbeds, parseEmbedLinktext } from "../../src/embed-key";
import { sliceEmbed } from "../../src/embed-slice";
import type { Workspace } from "obsidian";

export const SOURCE = "Competitive Coding Fundamentals.md";
export const SOURCE_TEXT = [
	"# Competitive Coding Fundamentals",
	"",
	"- [ ] Lesson 7: Sorting ^aaa111",
	"  - [ ] Merge sort",
	"- [ ] Lesson 8: Collections and frequency counting ^0169a6",
	"  - [ ] Count word frequency with a map",
	"    - [ ] Handle case folding",
	"  - [ ] Read the input",
	"- [ ] Lesson 9: Graphs ^bbb222",
	"  - [ ] Breadth-first search",
	"",
].join("\n");

/** Three lessons, the middle one with a nested child, as a whole note (no ids needed). */
export const LESSONS_NOTE = "Lessons.md";
export const LESSONS_TEXT = [
	"- [ ] Lesson 1: Arrays",
	"  - [ ] Two pointers",
	"- [ ] Lesson 2: Maps",
	"  - [ ] Count word frequency",
	"    - [ ] Handle case folding",
	"- [ ] Lesson 3: Graphs",
	"  - [ ] Breadth-first search",
	"",
].join("\n");

export const HEADED_NOTE = "Headed.md";
export const HEADED_TEXT = [
	"---",
	"tags: probe",
	"---",
	"# Headed",
	"",
	"## Lesson 8",
	"- [ ] Count word frequency",
	"  - [ ] Handle case folding",
	"",
	"## Lesson 9",
	"- [ ] Walk the graph",
	"  - [ ] Visit neighbours",
	"",
].join("\n");

/** A note whose first item has an indented continuation line (the source builder counts it as
 * foldable, Obsidian renders no arrow for it) and whose second item carries a block id and a
 * piped wikilink, so the embed shows fewer arrows than the slice has foldable blocks. */
export const MIXED_NOTE = "Mixed.md";
export const MIXED_TEXT = [
	"- [ ] Intro ^a1",
	"  continuation line",
	"- [ ] See [[Other note|the other note]] ^b2",
	"  - [ ] Child step",
	"",
].join("\n");

/** A line's text as Obsidian renders it: the trailing block id is hidden and `[[target|alias]]`
 * shows as its alias (`[[target]]` as the target). The probe read "Lesson 8: Collections and
 * frequency counting" for the line ending "^0169a6" (docs/embed-probe.md). */
export function renderedLineText(text: string): string {
	return text
		.replace(/\s+\^[A-Za-z0-9-]+\s*$/, "")
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/\[\[([^\]]*)\]\]/g, "$1");
}

export type Mode = "live-preview" | "reading-view";

export interface RenderedHost {
	path: string;
	view: MarkdownView;
	/** Top-level embed elements, in the order they appear in the host's text. */
	embeds: HTMLElement[];
	surface: HTMLElement;
}

const EMBED_LINE = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const LIST = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?(.*)$/;

export class World {
	readonly app: App;
	readonly trusted = new WeakSet<Event>();
	readonly saved: unknown[] = [];
	readonly store: FoldStore;
	readonly recorder: EmbedFoldRecorder;
	private readonly depsOverrides: Partial<EmbedFoldRecorderDeps>;
	private readonly texts = new Map<string, string>();

	/** `opts.app` reuses an existing mock app (the plugin's own); `opts.attach` false builds the
	 * recorder without attaching it, for a test whose recorder is the plugin's. */
	constructor(overrides: Partial<EmbedFoldRecorderDeps> = {}, opts: { app?: App; attach?: boolean } = {}) {
		this.app = opts.app ?? new App();
		this.depsOverrides = overrides;
		this.store = new FoldStore({
			loadData: async () => null,
			saveData: async (data) => {
				this.saved.push(structuredClone(data));
			},
		});
		this.recorder = new EmbedFoldRecorder(this.deps());
		if (opts.attach !== false) this.recorder.attach(document);
	}

	/** The deps a real plugin would hand the recorder, over this world's mock app. */
	deps(): EmbedFoldRecorderDeps {
		return {
			workspace: this.app.workspace as unknown as Workspace,
			store: this.store,
			readHostText: (host) => host.view.getViewData(),
			readNote: async (path) => {
				const file = this.app.vault.getFileByPath(path);
				return file === null ? null : await this.app.vault.cachedRead(file);
			},
			resolveLink: (linktext, sourcePath) => this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null,
			isTrusted: (event) => this.trusted.has(event),
			...this.depsOverrides,
		};
	}

	addNote(path: string, text: string): void {
		this.texts.set(path, text);
		this.app.vault.setContent(path, text);
	}

	/** Opens `path` in a new pane in `mode` and renders every `![[...]]` line of `hostText` into
	 * it. The host's text is also what the view reports as its current content. */
	addHost(path: string, mode: Mode, hostText: string): RenderedHost {
		this.addNote(path, hostText);
		const view = new MarkdownView();
		view.file = new TFile(path);
		view.data = hostText;
		view.mode = mode === "reading-view" ? "preview" : "source";
		this.app.workspace.addLeaf(view);
		document.body.append(view.containerEl);
		const surface = mode === "reading-view" ? view.readingSurface() : view.sourceSurface();
		const embeds: HTMLElement[] = [];
		for (const line of hostText.split("\n")) {
			const match = EMBED_LINE.exec(line.trim());
			if (match === null) continue;
			const el = this.renderEmbed(match[1], path, mode);
			surface.append(el);
			embeds.push(el);
		}
		return { path, view, embeds, surface };
	}

	/** Re-renders an embed element's content from the current text of its target, as Obsidian does
	 * after a source edit, without any input. Embeds in the content keep their own state. */
	rerender(embed: HTMLElement, hostPath: string): void {
		const fresh = this.renderEmbed(embed.getAttribute("src") ?? "", hostPath, embed.tagName === "SPAN" ? "reading-view" : "live-preview");
		embed.replaceChildren(...Array.from(fresh.childNodes));
	}

	/** The embed container for `src` as written in `sourcePath`, with its slice rendered inside. */
	renderEmbed(src: string, sourcePath: string, mode: Mode): HTMLElement {
		const el = document.createElement(mode === "reading-view" ? "span" : "div");
		el.className = "internal-embed markdown-embed inline-embed is-loaded";
		el.setAttribute("src", src);
		const content = document.createElement("div");
		content.className = "markdown-embed-content";
		el.append(content);

		const parsed = parseEmbedLinktext(src);
		const targetPath = parsed === null ? null : parsed.target === "" ? sourcePath : (this.app.metadataCache.getFirstLinkpathDest(parsed.target, sourcePath)?.path ?? null);
		const text = targetPath === null ? null : (this.texts.get(targetPath) ?? null);
		const slice = text === null || parsed === null ? null : sliceEmbed(text, parsed.subpath);
		if (slice !== null && targetPath !== null) this.renderSlice(content, slice.text, targetPath, mode);
		return el;
	}

	private renderSlice(content: HTMLElement, sliceText: string, sourcePath: string, mode: Mode): void {
		const addArrow = (row: HTMLElement, cls: string): void => {
			const arrow = document.createElement("div");
			arrow.className = `${cls} collapse-indicator`;
			row.prepend(arrow);
			// Obsidian's own handler: flip the arrow and its row.
			arrow.addEventListener("click", () => {
				const collapsed = !arrow.classList.contains("is-collapsed");
				arrow.classList.toggle("is-collapsed", collapsed);
				row.classList.toggle("is-collapsed", collapsed);
			});
		};

		const openHeadings: { el: HTMLElement; level: number; hasContent: boolean }[] = [];
		const allHeadings: typeof openHeadings = [];
		const items: { indent: number; li: HTMLElement }[] = [];
		let topList: HTMLElement | null = null;

		for (const line of sliceText.split("\n")) {
			if (line.trim() === "") continue;
			const embed = EMBED_LINE.exec(line.trim());
			const heading = HEADING.exec(line);
			const item = LIST.exec(line);
			if (heading !== null) {
				const level = heading[1].length;
				while (openHeadings.length > 0 && openHeadings[openHeadings.length - 1].level >= level) openHeadings.pop();
				for (const open of openHeadings) open.hasContent = true;
				const el = document.createElement("h2");
				el.append(document.createTextNode(renderedLineText(heading[2])));
				content.append(el);
				const entry = { el, level, hasContent: false };
				openHeadings.push(entry);
				allHeadings.push(entry);
				items.length = 0;
				topList = null;
				continue;
			}
			for (const open of openHeadings) open.hasContent = true;
			if (embed !== null) {
				content.append(this.renderEmbed(embed[1], sourcePath, mode));
				items.length = 0;
				topList = null;
			} else if (item === null) {
				const p = document.createElement("p");
				p.textContent = line.trim();
				content.append(p);
				items.length = 0;
				topList = null;
			} else {
				const indent = item[1].length;
				while (items.length > 0 && items[items.length - 1].indent >= indent) items.pop();
				const li = document.createElement("li");
				if (/^\s*(?:[-*+]|\d+[.)])\s+\[.\]/.test(line)) {
					const box = document.createElement("input");
					box.type = "checkbox";
					box.className = "task-list-item-checkbox";
					li.append(box);
				}
				li.append(document.createTextNode(renderedLineText(item[2])));
				let list: HTMLElement;
				const parent = items[items.length - 1];
				if (parent === undefined) {
					if (topList === null) {
						topList = document.createElement("ul");
						content.append(topList);
					}
					list = topList;
				} else {
					let nested = Array.from(parent.li.children).find((c) => c.tagName === "UL") as HTMLElement | undefined;
					if (nested === undefined) {
						nested = document.createElement("ul");
						parent.li.append(nested);
						addArrow(parent.li, "list-collapse-indicator");
					}
					list = nested;
				}
				list.append(li);
				items.push({ indent, li });
			}
		}
		for (const h of allHeadings) if (h.hasContent) addArrow(h.el, "heading-collapse-indicator");
	}

	// --- Simulated input ---------------------------------------------------------------------

	/** What a person's click produces: the pointer sequence, then a click, all trusted. */
	realClick(el: Element): void {
		for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
			const event = new MouseEvent(type, { bubbles: true, cancelable: true });
			this.trusted.add(event);
			el.dispatchEvent(event);
		}
	}

	/** A script clicking the arrow: untrusted, no pointer events. */
	scriptedClick(el: HTMLElement): void {
		el.click();
	}

	/** Obsidian's render-time toggle: the classes change with no input at all. */
	renderToggle(arrow: Element, collapsed: boolean): void {
		arrow.classList.toggle("is-collapsed", collapsed);
		arrow.parentElement?.classList.toggle("is-collapsed", collapsed);
	}

	/** A trusted Enter key press on the arrow (then the same toggle Obsidian would make). */
	keyPress(el: HTMLElement, key = "Enter"): void {
		const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		this.trusted.add(event);
		el.dispatchEvent(event);
		el.click();
	}

	/** Lets every pending mutation callback and queued recording finish. */
	async settle(): Promise<void> {
		await Promise.resolve();
		await this.recorder.whenIdle();
	}

	embedKeysIn(hostPath: string): string[] {
		return findEmbeds(hostPath, this.texts.get(hostPath) ?? "").map((e) => `${e.target}|${e.subpath}|${e.occurrence}`);
	}
}

/** The arrows of one embed element that belong to it (not to an embed nested inside it). */
export function ownArrows(embed: Element): HTMLElement[] {
	return Array.from(embed.querySelectorAll<HTMLElement>(".list-collapse-indicator, .heading-collapse-indicator")).filter(
		(a) => a.closest(".internal-embed.markdown-embed") === embed
	);
}

/** The arrow whose row text starts with `text`. */
export function arrowFor(embed: Element, text: string): HTMLElement {
	const hit = ownArrows(embed).find((a) => (a.parentElement?.textContent ?? "").trim().startsWith(text));
	if (hit === undefined) throw new Error(`no arrow for "${text}"`);
	return hit;
}
