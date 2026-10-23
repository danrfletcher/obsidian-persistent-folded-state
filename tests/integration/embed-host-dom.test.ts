/**
 * jsdom DOM built from the probe's own fixture notes (tests/fixtures/embed-probe/): the host note's
 * embed lines become `.internal-embed` elements shaped as scripts/e2e-embed-probe.mjs saw them in
 * real Obsidian (docs/embed-probe.md, "Fixture coverage"), with the source notes' lists rendered
 * inside as `li` + `.list-collapse-indicator`. Only note embeds are detected as hosts (G12
 * groundwork); the image embed is not.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Workspace } from "obsidian";
import { detectEmbedHost } from "../../src/embed-host";
import { MarkdownView as MockMarkdownView, TFile as MockTFile, Workspace as MockWorkspace } from "../mocks/obsidian";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "embed-probe");
const note = (name: string) => readFileSync(join(FIXTURES, name.endsWith(".md") || name.endsWith(".svg") ? name : `${name}.md`), "utf8");

type EmbedKind = "block" | "heading" | "whole-note" | "markdown-link" | "image";
interface EmbedLine {
	src: string;
	kind: EmbedKind;
}

/** Parses `![[target]]`, `![[target#^id]]`, `![[target#Heading]]`, `![[x.svg]]` and `![](x.md)` lines. */
function embedLines(markdown: string): EmbedLine[] {
	const out: EmbedLine[] = [];
	for (const line of markdown.split("\n")) {
		const wiki = /^!\[\[([^\]]+)\]\]$/.exec(line.trim());
		const link = /^!\[\]\(([^)]+)\)$/.exec(line.trim());
		if (wiki) {
			const src = wiki[1];
			const kind: EmbedKind = /\.(svg|png|jpg)$/.test(src) ? "image" : src.includes("#^") ? "block" : src.includes("#") ? "heading" : "whole-note";
			out.push({ src, kind });
		} else if (link) out.push({ src: decodeURIComponent(link[1]), kind: "markdown-link" });
	}
	return out;
}

/** The lines of a source note that a given embed shows. */
function slice(sourceText: string, embed: EmbedLine): string[] {
	const lines = sourceText.split("\n").filter((l) => l.trim() !== "");
	if (embed.kind === "block") {
		const id = embed.src.split("#^")[1];
		const start = lines.findIndex((l) => l.includes(`^${id}`));
		const indent = lines[start].search(/\S/);
		let end = start + 1;
		while (end < lines.length && lines[end].search(/\S/) > indent) end++;
		return lines.slice(start, end);
	}
	if (embed.kind === "heading") {
		const heading = embed.src.split("#")[1];
		const start = lines.findIndex((l) => /^#{1,6} /.test(l) && l.replace(/^#+ /, "") === heading);
		let end = start + 1;
		while (end < lines.length && !/^#{1,6} /.test(lines[end])) end++;
		return lines.slice(start, end);
	}
	return lines.filter((l) => !/^---$|^tags:/.test(l));
}

function renderEmbed(doc: Document, embed: EmbedLine, depth = 0): HTMLElement {
	const el = doc.createElement("div");
	el.setAttribute("src", embed.src);
	if (embed.kind === "image") {
		el.className = "internal-embed media-embed image-embed is-loaded";
		el.append(doc.createElement("img"));
		return el;
	}
	el.className = "internal-embed markdown-embed inline-embed is-loaded";
	const content = doc.createElement("div");
	content.className = "markdown-embed-content";
	el.append(content);
	const path = embed.src.split("#")[0].replace(/\.md$/, "");
	const text = note(path);
	for (const line of slice(text, embed)) {
		const nested = /^!\[\[([^\]]+)\]\]$/.exec(line.trim());
		if (nested && depth < 3) {
			content.append(renderEmbed(doc, { src: nested[1], kind: "whole-note" }, depth + 1));
			continue;
		}
		const row = doc.createElement(/^#{1,6} /.test(line) ? "h2" : "li");
		const toggle = doc.createElement("div");
		toggle.className = row.tagName === "H2" ? "heading-collapse-indicator collapse-indicator" : "list-collapse-indicator collapse-indicator";
		row.append(toggle, doc.createTextNode(line.replace(/^\s*(- (\[ \] )?|#+ )/, "")));
		content.append(row);
	}
	return el;
}

function buildHost(mode: "live-preview" | "reading-view") {
	const ws = new MockWorkspace();
	const view = new MockMarkdownView();
	view.file = new MockTFile("embed-probe/Probe Host.md");
	view.mode = mode === "reading-view" ? "preview" : "source";
	ws.addLeaf(view);
	const surface = mode === "reading-view" ? view.readingSurface() : view.sourceSurface();
	const lines = embedLines(note("Probe Host"));
	const embeds = lines.map((line) => ({ line, el: renderEmbed(document, line) }));
	for (const { el } of embeds) surface.append(el);
	return { ws: ws as unknown as Workspace, view, embeds };
}

describe("embed host detection over the probe fixture DOM (E13, G12 groundwork)", () => {
	it("the fixture host holds block, heading, whole-note, ![](x.md), image and nested embeds", () => {
		const kinds = embedLines(note("Probe Host")).map((e) => e.kind);
		expect(kinds).toEqual(["block", "heading", "whole-note", "markdown-link", "image", "whole-note"]);
		// The nested embed really has an embed inside it.
		const nested = buildHost("live-preview").embeds[5].el;
		expect(nested.querySelectorAll(".internal-embed")).toHaveLength(1);
		// The block embed is the Lesson 8 item plus its four descendants (a fold has something to hide).
		expect(buildHost("live-preview").embeds[0].el.querySelectorAll("li")).toHaveLength(5);
	});

	it.each(["live-preview", "reading-view"] as const)("%s: every note embed is detected, the image embed is not", (mode) => {
		const { ws, view, embeds } = buildHost(mode);
		const results = embeds.map(({ line, el }) => ({ kind: line.kind, host: detectEmbedHost(ws, el) }));

		expect(results.filter((r) => r.kind !== "image").every((r) => (r.host?.view as unknown) === view && r.host?.mode === mode)).toBe(true);
		expect(results.filter((r) => r.kind !== "image")).toHaveLength(5);
		expect(results.find((r) => r.kind === "image")?.host).toBeNull();
	});

	it.each(["live-preview", "reading-view"] as const)("%s: a fold toggle inside each note embed resolves to the host file", (mode) => {
		const { ws, embeds } = buildHost(mode);
		for (const { line, el } of embeds) {
			const toggle = el.querySelector(".collapse-indicator");
			if (line.kind === "image") {
				expect(toggle).toBeNull();
				continue;
			}
			expect(toggle).not.toBeNull();
			expect(detectEmbedHost(ws, toggle)?.file.path).toBe("embed-probe/Probe Host.md");
		}
	});

	it("the nested embed's inner embed is detected and resolves to the same view as its outer embed", () => {
		const { ws, embeds } = buildHost("reading-view");
		const outer = embeds[5].el;
		const inner = outer.querySelector<HTMLElement>(".internal-embed")!;
		expect(detectEmbedHost(ws, inner)?.view).toBe(detectEmbedHost(ws, outer)?.view);
		expect(detectEmbedHost(ws, inner)).not.toBeNull();
	});

	it("the same fixture in the wrong surface is not detected (Live Preview DOM in a Reading view)", () => {
		const { ws, view, embeds } = buildHost("live-preview");
		view.mode = "preview";
		for (const { el } of embeds) expect(detectEmbedHost(ws, el)).toBeNull();
	});
});
