/**
 * E13, F3: embed host detection. Given an element, says which workspace `MarkdownView` it is
 * rendered inside, and in which mode, or null when it is not an embed inside one.
 *
 * A host is found only when the element sits inside a note-embed container (`.internal-embed.markdown-embed`) AND that
 * container is inside the visible surface of a `MarkdownView` that `workspace.iterateAllLeaves`
 * reports, in Live Preview or Reading view. Everything else is null: source mode, a hover
 * popover or page preview (its view is not a workspace leaf), a canvas card or Bases view (the
 * leaf's view is not a `MarkdownView`), a detached element, a null input.
 *
 * Two facts about real Obsidian this relies on (proven by scripts/e2e-embed-probe.mjs, see
 * docs/embed-probe.md):
 *  - A `MarkdownView` keeps both surfaces in its DOM and hides the inactive one, so the check is
 *    against the surface matching the view's current mode, not the whole `containerEl`.
 *  - `getMode()` reports "source" for both Source mode and Live Preview; the `source` flag in
 *    `getState()` tells them apart.
 *
 * Detection only: nothing here folds, records, registers a hook or writes state.
 */
import { MarkdownView } from "obsidian";
import type { TFile, Workspace } from "obsidian";

export type EmbedHostMode = "live-preview" | "reading-view";

export interface EmbedHost {
	view: MarkdownView;
	file: TFile;
	mode: EmbedHostMode;
}

/** Note embeds only (G12 groundwork): an image, PDF or other media embed carries `media-embed`
 * instead of `markdown-embed` and has nothing to fold. `![](x.md)` embeds are `markdown-embed`. */
const EMBED_SELECTOR = ".internal-embed.markdown-embed";
const LIVE_PREVIEW_SURFACE = ".markdown-source-view";
const READING_VIEW_SURFACE = ".markdown-reading-view";

/** The mode a view is showing, or null for Source mode (not a host mode). */
function hostModeOf(view: MarkdownView): EmbedHostMode | null {
	if (view.getMode() === "preview") return "reading-view";
	return view.getState().source === true ? null : "live-preview";
}

/** Whether `el` is a DOM node. Duck-typed on `nodeType` rather than `instanceof Element`, which
 * is false for a node created in a pop-out window (a different realm). */
function isElement(el: unknown): el is Element {
	return typeof el === "object" && el !== null && (el as { nodeType?: unknown }).nodeType === 1;
}

/**
 * The host of `el`, or null. If the same note is open in two panes this returns the first leaf
 * whose visible surface contains `el`; since an element lives in exactly one pane's DOM, the
 * answer is the pane that owns it.
 */
export function detectEmbedHost(workspace: Workspace, el: Element | null | undefined): EmbedHost | null {
	if (!isElement(el)) return null;
	if (typeof el.closest !== "function" || el.closest(EMBED_SELECTOR) === null) return null;

	let found: EmbedHost | null = null;
	workspace.iterateAllLeaves((leaf) => {
		if (found !== null) return;
		const view = leaf.view;
		if (!(view instanceof MarkdownView) || !view.file) return;
		const mode = hostModeOf(view);
		if (mode === null) return;
		const surface = view.containerEl.querySelector(mode === "reading-view" ? READING_VIEW_SURFACE : LIVE_PREVIEW_SURFACE);
		if (surface === null || !surface.contains(el)) return;
		found = { view, file: view.file, mode };
	});
	return found;
}
