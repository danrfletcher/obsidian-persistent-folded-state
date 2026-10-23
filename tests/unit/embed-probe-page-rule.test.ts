/**
 * The probe's in-page container rule (scripts/lib/embed-probe-page.js, `containerRule`) is a copy
 * of `detectEmbedHost` (src/embed-host.ts) that runs inside Obsidian. The probe's "detected in
 * real Obsidian" line comes from the copy, so this runs both over the same mock views and asserts
 * they give the same host and mode for every case, including Source mode (null in both).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Workspace } from "obsidian";
import { detectEmbedHost } from "../../src/embed-host";
import { MarkdownView as MockMarkdownView, TFile as MockTFile, Workspace as MockWorkspace } from "../mocks/obsidian";

type Mode = "live-preview" | "reading-view" | "source";
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const PAGE_SOURCE = readFileSync(join(__dirname, "..", "..", "scripts", "lib", "embed-probe-page.js"), "utf8");

/** Installs the page script against these views and returns its `containerRule`. */
function pageRule(views: MockMarkdownView[]): (el: Element) => { file: string; mode: string } | null {
	const app = { workspace: { getLeavesOfType: (type: string) => (type === "markdown" ? views.map((view) => ({ view })) : []) } };
	new Function("app", PAGE_SOURCE)(app);
	return (window as Any).__pfsEmbedProbe.containerRule;
}

function openHost(ws: MockWorkspace, path: string, mode: Mode): MockMarkdownView {
	const view = new MockMarkdownView(document);
	view.file = new MockTFile(path);
	view.mode = mode === "reading-view" ? "preview" : "source";
	view.sourceMode = mode === "source";
	ws.addLeaf(view);
	return view;
}

function embedIn(view: MockMarkdownView, className = "internal-embed markdown-embed is-loaded"): HTMLElement {
	const embed = document.createElement("div");
	embed.className = className;
	(view.mode === "preview" ? view.readingSurface() : view.sourceSurface()).append(embed);
	return embed;
}

describe("probe page containerRule agrees with detectEmbedHost (PR-2 R6)", () => {
	const modes: Mode[] = ["live-preview", "reading-view", "source"];

	it.each(modes)("an embed in a %s view", (mode) => {
		const ws = new MockWorkspace();
		const view = openHost(ws, "Rocketship.md", mode);
		const embed = embedIn(view);
		const real = detectEmbedHost(ws as unknown as Workspace, embed);
		const page = pageRule([view])(embed);
		expect(page === null).toBe(real === null);
		expect(page?.mode).toBe(real?.mode);
		expect(page?.file).toBe(real?.file.path);
	});

	it("Source mode is not a host: the page rule gives null, not { mode: 'source' }", () => {
		const ws = new MockWorkspace();
		const view = openHost(ws, "Rocketship.md", "source");
		expect(pageRule([view])(embedIn(view))).toBeNull();
	});

	it("a Source-mode view is skipped, and the next view that contains the element answers", () => {
		const ws = new MockWorkspace();
		const source = openHost(ws, "A.md", "source");
		const live = openHost(ws, "B.md", "live-preview");
		const embed = embedIn(live);
		expect(pageRule([source, live])(embed)).toEqual({ file: "B.md", mode: "live-preview" });
		expect(detectEmbedHost(ws as unknown as Workspace, embed)?.file.path).toBe("B.md");
	});

	it("a media embed is never a host", () => {
		const ws = new MockWorkspace();
		const view = openHost(ws, "Rocketship.md", "live-preview");
		const image = embedIn(view, "internal-embed media-embed image-embed is-loaded");
		expect(pageRule([view])(image)).toBeNull();
		expect(detectEmbedHost(ws as unknown as Workspace, image)).toBeNull();
	});

	it("an embed outside every view is null in both", () => {
		const ws = new MockWorkspace();
		const view = openHost(ws, "Rocketship.md", "live-preview");
		const stray = document.createElement("div");
		stray.className = "internal-embed markdown-embed";
		document.body.append(stray);
		expect(pageRule([view])(stray)).toBeNull();
		expect(detectEmbedHost(ws as unknown as Workspace, stray)).toBeNull();
		stray.remove();
	});
});
