/**
 * Records the folds and unfolds Dan makes inside an embed (ticket warkworth-21, PR-4, G1, G8,
 * G16). When he clicks the fold arrow Obsidian already shows inside an embedded block, heading or
 * whole note, in a Live Preview or Reading view host, this stores that fold under the embed's own
 * key in the `embeds` section of the store. Nothing else is recorded: not a render, not a
 * re-render, not a scripted toggle (E3, never-break rule 2). Recording a fold never adds one
 * nobody clicked, and unfolding removes that fold's anchor from the embed's stored set (G16).
 *
 * The recorder and the click-only classifier (src/embed-click-classifier.ts) are one unit.
 * This file collects the input signals around an arrow, asks the classifier whether the change
 * was the user's, and only then follows the change into the store.
 *
 * Hook (from the recorded probe, docs/embed-probe.md): in both host modes, for block, heading and
 * whole-note embeds, an embedded note renders inside `.internal-embed.markdown-embed`; its list
 * items carry a `.list-collapse-indicator` and its headings a `.heading-collapse-indicator`, and
 * folding sets `is-collapsed` on the indicator. So:
 *  - capture-phase `pointerdown`, `click` and `keydown` listeners on each document, passive, that
 *    never stop or alter an event, add no element and no class, and read the DOM only;
 *  - a click (or key press) the classifier calls "user" arms a MutationObserver on that one
 *    arrow's `class` attribute. Only a class change that follows such an input, within a short
 *    window, is recorded. A class change with no input before it (Obsidian restoring its own
 *    memory, a re-render after a source edit) is never looked at, so cannot be recorded.
 * Combinations the probe could not show to be supported (`EMBED_CAPABILITIES`) are skipped, and
 * when none is supported no listener is registered at all (G18).
 *
 * Who owns the fold (G8): the embed key is host path + target path + subpath + occurrence (and
 * the chain of containing embeds for a nested embed, `EmbedIdentity.outer`). The host's open
 * panes do not matter, so a host open in two panes has one entry per embed. A click is ignored
 * unless the arrow sits inside a workspace markdown view (`detectEmbedHost`, E13): hover
 * previews, page previews, canvas cards and Bases are not hosts. Image, PDF and audio embeds
 * are not `markdown-embed` elements and are never seen. The occurrence index comes from the
 * host's source text, never from render order (G7); the DOM is used only to tell identical
 * embeds apart, and when it cannot do that reliably (a lazily rendered host with some identical
 * embeds not in the DOM, and no position available) nothing is written rather than a wrong key.
 *
 * Which fold: the arrow's row is matched to a block of the embed's slice (`sliceEmbed`) and the
 * anchor is described over the slice text with `buildAnchors`, the same builder a note's folds
 * use, never over the whole source note.
 *
 * Writes only to the store, which flushes through its own debounce. Reads the host's and the
 * targets' text through injected readers and writes to no note (F7) and no browser storage (F10).
 * Jobs run one at a time in click order, so a rapid fold, unfold, fold lands as the last click.
 */
import type { Workspace } from "obsidian";
import { anchorKey, buildAnchors, parseAnchor } from "./anchors";
import type { Anchor, AnchoredBlock } from "./anchors";
import { classifyFoldToggle } from "./embed-click-classifier";
import type { FoldToggleSignals } from "./embed-click-classifier";
import { EMBED_CAPABILITIES } from "./embed-capabilities";
import type { EmbedCapability, EmbedHostModeId, EmbedKind } from "./embed-capabilities";
import { detectEmbedHost } from "./embed-host";
import type { EmbedHost } from "./embed-host";
import { findEmbeds, parseEmbedLinktext } from "./embed-key";
import { HostComparisonBudget, planEmbedRematch } from "./embed-rematch";
import { sliceEmbed } from "./embed-slice";
import { normalizeText } from "./normalize";
import type { EmbedFoldRecord, EmbedIdentity, EmbedLinkId, StoredAnchor } from "./types";

export const EMBED_SELECTOR = ".internal-embed.markdown-embed";
export const INDICATOR_SELECTOR = ".list-collapse-indicator, .heading-collapse-indicator";
const SURFACE_SELECTOR = ".markdown-source-view, .markdown-reading-view";
export const COLLAPSED_CLASS = "is-collapsed";

/** A pointerdown counts toward a click only if it came this long (ms) or less before it. */
const POINTER_WINDOW_MS = 3000;
/** How long (ms) after a user input an arrow's class change is still attributed to it. This is
 * also how long an input's credit can wait for a class change: a trusted click that Obsidian
 * ignores leaves its credit for this long, and a render-time toggle of the same arrow inside the
 * window would be recorded as a fold (PR-4 R2). The window is not shortened to close that
 * coincidence: a missed class change of a real fold costs the user's fold (the restore would
 * undo it), which is worse than the narrow false positive, and how soon Obsidian's own handler
 * toggles the arrow has not been measured. */
const ARM_WINDOW_MS = 300;

// --- Pure rules (no DOM) ----------------------------------------------------------------------

/** How the clicked arrow is found again in the embed's slice. All fields are read from the DOM
 * at click time. `text` is the arrow's row text, normalized like an anchor's text. */
export interface ToggleRef {
	family: "heading" | "list";
	text: string;
	/** How many arrows of the same family and text come before this one in the embed. */
	sameBefore: number;
	/** How many arrows of the same family and text the embed has in all. */
	sameTotal: number;
	/** This arrow's position among all the embed's own arrows, and how many there are. */
	index: number;
	total: number;
}

function familyOf(anchor: Anchor): "heading" | "list" | null {
	if (anchor.kind === "heading") return "heading";
	if (anchor.kind === "task" || anchor.kind === "list") return "list";
	return null;
}

/**
 * An anchor's text as Obsidian shows it in a rendered row, so it can be compared with the row's
 * text read from the DOM (docs/embed-probe.md: the row of "- Lesson 8 ... ^0169a6" reads
 * "Lesson 8 ..."). Drops a trailing block id and any embed in the row (`rowText` removes
 * `.internal-embed`, so `- ![[X]]` reads as an empty row), shows `[[target|alias]]` as `alias`,
 * `[[target]]` as `target`, `[[note#heading]]` as `note > heading` (a link to a heading of the
 * same note, `[[#heading]]`, as `heading`), `[text](url)` as `text` and `code` without its
 * backticks. Anchor text is already normalized, so the result stays normalized (whitespace
 * collapsed and trimmed). A row this still gets wrong falls back to the arrow's position
 * (`blockIndexForToggle`), never to a guess.
 */
export function displayText(anchorText: string): string {
	return anchorText
		.replace(/\s+\^[A-Za-z0-9-]+$/, "")
		.replace(/!\[\[[^\]]*\]\]/g, "")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
		.replace(/\[\[#([^\]]*)\]\]/g, "$1")
		.replace(/\[\[([^\]#]*)#([^\]]*)\]\]/g, "$1 > $2")
		.replace(/\[\[([^\]]*)\]\]/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(`+)(.+?)\1/g, "$2")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * The anchor of the slice block the clicked arrow belongs to, described over `sliceText` (the
 * embed's slice, not the source note), or null when it cannot be told with confidence. Only
 * blocks with something under them can fold, so only those are candidates. Same-text arrows are
 * paired by order (E1); the row text is compared with the block's text as Obsidian renders it
 * (`displayText`). When the row text finds no block (some other markup differs from the source
 * line), the arrow's position is used instead, but only if the embed shows exactly as many
 * arrows as the slice has foldable blocks and the kinds agree. Otherwise nothing is guessed.
 */
export function anchorForToggle(sliceText: string, toggle: ToggleRef): Anchor | null {
	const blocks = buildAnchors(sliceText);
	const index = blockIndexForToggle(blocks, toggle);
	return index === null ? null : blocks[index].anchor;
}

/**
 * The same decision as `anchorForToggle`, but as the index of the block in `blocks` (the output
 * of `buildAnchors(sliceText)`, in that order). The restore (src/embed-fold-restorer.ts) needs
 * the block, not just its anchor, to pair every arrow of an embed with the slice block it folds.
 */
export function blockIndexForToggle(blocks: readonly AnchoredBlock[], toggle: ToggleRef): number | null {
	const foldable: number[] = [];
	blocks.forEach((block, i) => {
		if (block.range.endLine > block.range.startLine && familyOf(block.anchor) !== null) foldable.push(i);
	});
	const byText = foldable.filter((i) => familyOf(blocks[i].anchor) === toggle.family && displayText(blocks[i].anchor.text) === toggle.text);
	if (byText.length > 0) {
		if (byText.length !== toggle.sameTotal) return null;
		return byText[toggle.sameBefore] ?? null;
	}
	if (foldable.length !== toggle.total) return null;
	const hit = foldable[toggle.index];
	return hit !== undefined && familyOf(blocks[hit].anchor) === toggle.family ? hit : null;
}

/**
 * The embed's record after the user folded (`folded` true) or unfolded one anchor, or null when
 * nothing would change. A fold upserts that one anchor (repeats collapse to one, keyed by
 * `anchorKey`); an unfold removes it; every anchor the click does not mention carries over
 * untouched, as do the dormant anchors, except that a fold also removes that anchor's key from
 * the embed's `dormant` (warkworth-46 E15: never in both lists). Unfolding in an embed with no record creates none
 * (state exists only once Dan has folded something, E12), and nothing is ever added for a block
 * nobody clicked (G16). `contentHash` is the hash of the slice the anchors were described over.
 *
 * A record this returns never carries `dormantSince`: a click on an embed proves the embed is
 * live, so rebuilding the record from the click ends any dormancy it was in (the stamp is not
 * copied from `existing`). That makes the recorder the second writer of the stamp, after
 * `FoldStore.reconcileEmbedDormancy`, and anything that relies on "only reconcile clears it"
 * must allow for this (PR-7 R7). A click that changes nothing returns null and leaves the
 * stamp as it was.
 */
export function applyEmbedFold(
	existing: EmbedFoldRecord | undefined,
	identity: EmbedIdentity,
	sliceHash: string,
	anchor: Anchor,
	folded: boolean
): EmbedFoldRecord | null {
	if (!folded && existing === undefined) return null;

	const folds = new Map<string, StoredAnchor>();
	for (const raw of existing?.folds ?? []) {
		const parsed = parseAnchor(raw);
		if (parsed !== null) folds.set(anchorKey(parsed), raw);
	}
	const key = anchorKey(anchor);
	const before = folds.get(key);
	if (folded) folds.set(key, anchor as unknown as StoredAnchor);
	else folds.delete(key);

	const nextFolds = Array.from(folds.values());
	// Warkworth-46 PR-4 (E15): folding an anchor makes it active, so a set-aside copy of the same
	// anchor leaves `dormant`. An unfold, and every other dormant entry, is left as it is.
	const existingDormant = existing?.dormant ?? [];
	const nextDormant = folded
		? existingDormant.filter((raw) => {
				const parsed = parseAnchor(raw);
				return parsed === null || anchorKey(parsed) !== key;
			})
		: existingDormant;
	const unchanged =
		existing !== undefined &&
		existing.contentHash === sliceHash &&
		nextFolds.length === existing.folds.length &&
		nextDormant.length === existingDormant.length &&
		(folded ? JSON.stringify(before) === JSON.stringify(anchor) : before === undefined);
	if (unchanged) return null;

	const record: EmbedFoldRecord = {
		host: identity.host,
		target: identity.target,
		subpath: identity.subpath,
		occurrence: identity.occurrence,
		contentHash: sliceHash,
		folds: nextFolds,
		dormant: nextDormant,
	};
	if (identity.outer !== undefined && identity.outer.length > 0) {
		record.outer = identity.outer.map((link) => ({ target: link.target, subpath: link.subpath, occurrence: link.occurrence }));
	}
	return record;
}

/** The kind of an embed from its subpath: none is a whole note, `^id` a block, else a heading. */
export function embedKindOf(subpath: string): EmbedKind {
	if (subpath === "") return "whole-note";
	return subpath.startsWith("^") ? "block" : "heading";
}

/** Links as written in an embed's `src` attribute resolve against the note that contains the
 * embed. Returns the same target and subpath `findEmbeds` gives that embed, or null. */
function resolveSrc(
	src: string,
	sourcePath: string,
	resolve: (linktext: string) => string | null
): { target: string; subpath: string } | null {
	const candidates = [src];
	if (src.includes("%")) {
		try {
			candidates.push(decodeURIComponent(src));
		} catch {
			// not percent-encoded after all
		}
	}
	let fallback: { target: string; subpath: string } | null = null;
	for (const candidate of candidates) {
		const parsed = parseEmbedLinktext(candidate);
		if (parsed === null) continue;
		if (parsed.target === "") return { target: sourcePath, subpath: parsed.subpath };
		const resolved = resolve(parsed.target);
		if (resolved !== null) return { target: resolved, subpath: parsed.subpath };
		fallback ??= { target: parsed.target.replace(/\.md$/i, ""), subpath: parsed.subpath };
	}
	return fallback;
}

/** What the DOM tells about one embed element, taken at click time. */
export interface EmbedLevelFacts {
	/** The element's `src` attribute (the link text Obsidian shows). */
	src: string;
	/** The `src` of every embed in the same container (the host's surface, or the containing
	 * embed), in DOM order, this one included. */
	siblingSrcs: string[];
	/** This embed's index in `siblingSrcs`. */
	index: number;
}

/** Everything that can stand before an embed on its line without being text: indent, quote
 * markers, one list marker and a task checkbox. */
const LINE_PREFIX = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?(?:\[.\][ \t]+)?$/;

/**
 * Start of the `![` that the host position `pos` belongs to. The widget may report its end, so a
 * position after the `![` means the nearest one before it. It may also report the start of its
 * line (not verified for an embed inside a list item, `- ![[X]]`, in Live Preview): when only a
 * line prefix (indent, quote markers, a list marker, a checkbox) lies between the line start and
 * `pos`, and the next `![` on that line follows only prefix too, it is that `![` and not the
 * previous identical embed.
 */
function embedStartAt(text: string, pos: number): number {
	if (text.startsWith("![", pos)) return pos;
	const lineStart = pos === 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;
	const lineEnd = text.indexOf("\n", pos);
	const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
	const ahead = line.indexOf("![", pos - lineStart);
	if (ahead !== -1 && LINE_PREFIX.test(line.slice(0, ahead))) return lineStart + ahead;
	const back = text.lastIndexOf("![", pos);
	return back === -1 ? pos : back;
}

/**
 * Which embed of `text` (the host's source, or a containing embed's slice) this element is, as a
 * link with its occurrence index. One identical embed: index 0, no DOM needed. Several: the
 * element's order among the identical embeds in the DOM when the DOM shows as many as the text
 * has (it is then the document order, and no editor position is trusted over it); otherwise the
 * document position when one is known. Null when it cannot be told.
 */
export function locateEmbed(
	text: string,
	sourcePath: string,
	level: EmbedLevelFacts,
	resolve: (linktext: string) => string | null,
	position: number | null
): EmbedLinkId | null {
	const me = resolveSrc(level.src, sourcePath, resolve);
	if (me === null) return null;
	const same = (e: { target: string; subpath: string }): boolean => e.target === me.target && e.subpath === me.subpath;
	const found = findEmbeds(sourcePath, text, resolve).filter(same);
	if (found.length === 0) return null;
	if (found.length === 1) return { target: me.target, subpath: me.subpath, occurrence: found[0].occurrence };

	const fromDom = (): number | null => {
		const domSame: number[] = [];
		level.siblingSrcs.forEach((src, i) => {
			const other = resolveSrc(src, sourcePath, resolve);
			if (other !== null && same(other)) domSame.push(i);
		});
		if (domSame.length !== found.length) return null;
		const at = domSame.indexOf(level.index);
		return at === -1 ? null : at;
	};
	// The DOM shows every identical embed of the text: its order is the document order, whatever
	// the editor reports as a position. How a Live Preview widget in a list item reports its
	// position is not verified against real Obsidian (PR-4 R3), so the position only decides
	// when the DOM cannot (an embed scrolled out of Live Preview's rendered range, say).
	const domOccurrence = fromDom();
	let occurrence = domOccurrence;
	if (occurrence === null && position !== null) {
		const before = findEmbeds(sourcePath, text.slice(0, embedStartAt(text, position)), resolve).filter(same).length;
		occurrence = before < found.length ? before : null;
	}
	return occurrence === null ? null : { target: me.target, subpath: me.subpath, occurrence };
}

// --- The recorder -----------------------------------------------------------------------------

export interface EmbedFoldRecorderDeps {
	workspace: Workspace;
	store: {
		getEmbed(id: EmbedIdentity): EmbedFoldRecord | undefined;
		setEmbed(record: EmbedFoldRecord): void;
	};
	/** The host's current source text. */
	readHostText: (host: EmbedHost) => string;
	/** The current text of a vault note, or null when it does not exist. Read-only. */
	readNote: (path: string) => Promise<string | null>;
	/** Obsidian's link resolver: link text as written in `sourcePath` to a vault path, or null. */
	resolveLink: (linktext: string, sourcePath: string) => string | null;
	/** Optional: the offset in the host's source text that a rendered host-level embed element
	 * stands for (Live Preview can tell). Used only to tell identical embeds apart. */
	positionOf?: (host: EmbedHost, el: Element) => number | null;
	/** Defaults to `EMBED_CAPABILITIES`; a test overrides it to model a gap. */
	capabilities?: Readonly<Record<EmbedHostModeId, Readonly<Record<EmbedKind, EmbedCapability>>>>;
	/** Defaults to `event.isTrusted`; a test overrides it, since jsdom marks every event untrusted. */
	isTrusted?: (event: Event) => boolean;
}

/** Everything read from the DOM when the user acted on an arrow. */
interface ToggleContext {
	host: EmbedHost;
	levels: EmbedLevelFacts[];
	toggle: ToggleRef;
	position: number | null;
}

/** The window an arrow lives in (a pop-out window has its own `MutationObserver`). */
type PopoutWindow = Window & { MutationObserver: typeof MutationObserver };

interface Arm {
	observer: MutationObserver;
	win: PopoutWindow;
	timer: number;
	ctx: ToggleContext;
	/** User inputs on this arrow not yet matched by a class change. */
	credits: number;
	/** The last input was a key press whose click, if any, must not add a second credit. */
	keyCredit: boolean;
	/** The arrow's collapsed state as last seen. */
	last: boolean;
}

interface Job {
	ctx: ToggleContext;
	folded: boolean;
	hostText: string;
}

function isCollapsed(el: Element): boolean {
	return el.classList.contains(COLLAPSED_CLASS);
}

function classListHasCollapsed(classAttr: string | null): boolean {
	return (classAttr ?? "").split(/\s+/).includes(COLLAPSED_CLASS);
}

function indicatorOf(target: EventTarget | null): Element | null {
	const el = target as { closest?: unknown } | null;
	if (el === null || typeof el.closest !== "function") return null;
	return (target as Element).closest(INDICATOR_SELECTOR);
}

/** The arrow's row (list item or heading) text, minus the arrow, nested lists and nested embeds,
 * normalized like an anchor's text. */
function rowText(indicator: Element): string {
	const row = indicator.parentElement;
	if (row === null) return "";
	const clone = row.cloneNode(true) as Element;
	for (const extra of Array.from(clone.querySelectorAll(`${INDICATOR_SELECTOR}, ul, ol, input, .internal-embed`))) extra.remove();
	return normalizeText(clone.textContent ?? "");
}

export class EmbedFoldRecorder {
	private readonly deps: EmbedFoldRecorderDeps;
	private readonly capabilities: Readonly<Record<EmbedHostModeId, Readonly<Record<EmbedKind, EmbedCapability>>>>;
	private readonly docs = new Set<Document>();
	private readonly arms = new Map<Element, Arm>();
	private pointerDown: { el: Element; at: number } | null = null;
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(deps: EmbedFoldRecorderDeps) {
		this.deps = deps;
		this.capabilities = deps.capabilities ?? EMBED_CAPABILITIES;
	}

	/** Starts listening on `doc` (the main document, or a pop-out window's). Registers nothing
	 * when the probe supports no host mode and embed kind at all. */
	attach(doc: Document): void {
		if (this.disposed || this.docs.has(doc) || !this.anySupported()) return;
		this.docs.add(doc);
		doc.addEventListener("pointerdown", this.onPointerDown, { capture: true, passive: true });
		doc.addEventListener("keydown", this.onKeyDown, { capture: true, passive: true });
		doc.addEventListener("click", this.onClick, { capture: true, passive: true });
	}

	detach(doc: Document): void {
		if (!this.docs.delete(doc)) return;
		this.removeListeners(doc);
	}

	/** Removes every listener and observer this recorder added. After this nothing is recorded,
	 * including work already queued (E9). */
	dispose(): void {
		this.disposed = true;
		for (const doc of this.docs) this.removeListeners(doc);
		this.docs.clear();
		for (const indicator of Array.from(this.arms.keys())) this.disarm(indicator);
		this.pointerDown = null;
	}

	/** Resolves once every recording started so far has reached the store. */
	async whenIdle(): Promise<void> {
		let seen: Promise<void>;
		do {
			seen = this.queue;
			await seen;
		} while (seen !== this.queue);
	}

	private removeListeners(doc: Document): void {
		doc.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
		doc.removeEventListener("keydown", this.onKeyDown, { capture: true });
		doc.removeEventListener("click", this.onClick, { capture: true });
	}

	private anySupported(): boolean {
		return Object.values(this.capabilities).some((kinds) => Object.values(kinds).some((cap) => cap.verdict === "supported"));
	}

	private trusted(event: Event): boolean {
		return this.deps.isTrusted ? this.deps.isTrusted(event) : event.isTrusted;
	}

	private readonly onPointerDown = (event: Event): void => {
		const indicator = indicatorOf(event.target);
		this.pointerDown = indicator === null ? null : { el: indicator, at: event.timeStamp };
	};

	private readonly onKeyDown = (event: Event): void => {
		const key = (event as KeyboardEvent).key;
		if (key !== "Enter" && key !== " ") return;
		const indicator = indicatorOf(event.target);
		if (indicator === null) return;
		this.consider(
			indicator,
			{ click: false, pointerSequence: false, keyActivation: true, trusted: this.trusted(event), renderWindow: false },
			true
		);
	};

	private readonly onClick = (event: Event): void => {
		const down = this.pointerDown;
		this.pointerDown = null;
		const indicator = indicatorOf(event.target);
		if (indicator === null) return;
		const pointerSequence = down !== null && down.el === indicator && Math.abs(event.timeStamp - down.at) <= POINTER_WINDOW_MS;
		// `renderWindow` stays false: this recorder does not watch renders, and the verdict does not
		// depend on it anyway (E3, see the classifier).
		this.consider(
			indicator,
			{ click: true, pointerSequence, keyActivation: false, trusted: this.trusted(event), renderWindow: false },
			false
		);
	};

	/** One input on an arrow. Only an input the classifier calls "user", on an arrow inside an
	 * embed of a workspace markdown view whose host mode and embed kind are supported, arms the
	 * arrow. Never throws into the page's event dispatch. */
	private consider(indicator: Element, signals: FoldToggleSignals, fromKey: boolean): void {
		if (this.disposed) return;
		try {
			if (classifyFoldToggle(signals) !== "user") return;
			const ctx = this.describe(indicator);
			if (ctx === null) return;
			this.arm(indicator, ctx, fromKey);
		} catch (err) {
			console.error("persistent-folded-state: embed fold input failed", err);
		}
	}

	/** Reads, from the DOM, everything needed to key and describe a fold of this arrow. Null for
	 * an arrow outside an embed, outside a workspace markdown view (E13), or in a host mode and
	 * embed kind the probe did not show to be supported (G18). */
	private describe(indicator: Element): ToggleContext | null {
		const embedEl = indicator.closest(EMBED_SELECTOR);
		if (embedEl === null) return null;
		const host = detectEmbedHost(this.deps.workspace, indicator);
		if (host === null) return null;

		const src = embedEl.getAttribute("src") ?? "";
		const parsed = parseEmbedLinktext(src.includes("%") ? safeDecode(src) : src);
		if (parsed === null) return null;
		if (this.capabilities[host.mode][embedKindOf(parsed.subpath)].verdict !== "supported") return null;

		const { levels, outermost } = embedLevels(embedEl, host.view.containerEl);
		const arrows = describeArrows(embedEl);
		const index = arrows.findIndex((a) => a.indicator === indicator);
		if (index === -1) return null;

		let position: number | null = null;
		try {
			position = this.deps.positionOf?.(host, outermost) ?? null;
		} catch {
			position = null;
		}
		return { host, levels, toggle: arrows[index].toggle, position };
	}

	private arm(indicator: Element, ctx: ToggleContext, fromKey: boolean): void {
		let arm = this.arms.get(indicator);
		if (arm === undefined) {
			const win = (indicator.ownerDocument.defaultView ?? window) as PopoutWindow;
			const observer = new win.MutationObserver((records) => this.onMutations(indicator, records));
			observer.observe(indicator, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
			arm = { observer, win, timer: 0, ctx, credits: 0, keyCredit: false, last: isCollapsed(indicator) };
			this.arms.set(indicator, arm);
		} else {
			arm.win.clearTimeout(arm.timer);
			arm.ctx = ctx;
		}
		if (fromKey) {
			arm.keyCredit = true;
			arm.credits++;
		} else if (arm.keyCredit) {
			arm.keyCredit = false;
		} else {
			arm.credits++;
		}
		arm.timer = arm.win.setTimeout(() => this.disarm(indicator), ARM_WINDOW_MS);
	}

	private disarm(indicator: Element): void {
		const arm = this.arms.get(indicator);
		if (arm === undefined) return;
		arm.observer.disconnect();
		arm.win.clearTimeout(arm.timer);
		this.arms.delete(indicator);
	}

	/** Class changes on an armed arrow. Each change of the collapsed state that an unmatched user
	 * input explains is recorded; any other change is only noted. */
	private onMutations(indicator: Element, records: MutationRecord[]): void {
		const arm = this.arms.get(indicator);
		if (arm === undefined || this.disposed) return;
		let previous = arm.last;
		for (let i = 0; i < records.length; i++) {
			const next = i + 1 < records.length ? classListHasCollapsed(records[i + 1].oldValue) : isCollapsed(indicator);
			if (next === previous) continue;
			previous = next;
			if (arm.credits > 0) {
				arm.credits--;
				this.enqueue(arm.ctx, next);
			}
		}
		arm.last = previous;
		if (arm.credits === 0) this.disarm(indicator);
	}

	private enqueue(ctx: ToggleContext, folded: boolean): void {
		let hostText: string;
		try {
			hostText = this.deps.readHostText(ctx.host);
		} catch (err) {
			console.error("persistent-folded-state: could not read the host for an embed fold", err);
			return;
		}
		const job: Job = { ctx, folded, hostText };
		this.queue = this.queue.then(() => this.record(job)).catch((err: unknown) => {
			console.error("persistent-folded-state: recording an embed fold failed", err);
		});
	}

	private async record(job: Job): Promise<void> {
		if (this.disposed) return;
		const { ctx } = job;
		const resolved = await resolveEmbedChain({
			hostPath: ctx.host.file.path,
			hostText: job.hostText,
			levels: ctx.levels,
			position: ctx.position,
			resolveLink: this.deps.resolveLink,
			readNote: this.deps.readNote,
			isCancelled: () => this.disposed,
		});
		if (resolved === null) return;

		const anchor = anchorForToggle(resolved.sliceText, ctx.toggle);
		if (anchor === null) return;

		const existing = await this.currentRecord(resolved);
		const next = applyEmbedFold(existing, resolved.identity, resolved.sliceHash, anchor, job.folded);
		if (next !== null) this.deps.store.setEmbed(next);
	}

	/**
	 * The embed's record as the slice reads now (PR-6, E3). A record whose hash is not the slice's
	 * was written for an earlier text of the source; its anchors may no longer read like the
	 * block the user just clicked (a line was reworded and the re-match has not run yet), so an
	 * unfold would not find the anchor to remove and the pending re-match would fold the block
	 * again over his click. The stored anchors are first placed on the current slice with the same
	 * planner the re-match uses, so his click lands on the right anchor and wins.
	 */
	private async currentRecord(resolved: ResolvedEmbed): Promise<EmbedFoldRecord | undefined> {
		const existing = this.deps.store.getEmbed(resolved.identity);
		if (existing === undefined || existing.contentHash === resolved.sliceHash) return existing;
		const stored: Anchor[] = [];
		for (const raw of existing.folds) {
			const parsed = parseAnchor(raw);
			if (parsed !== null) stored.push(parsed);
		}
		if (stored.length === 0) return existing;
		const outcome = await planEmbedRematch({
			stored,
			storedHash: existing.contentHash,
			sliceHash: resolved.sliceHash,
			candidates: buildAnchors(resolved.sliceText),
			budget: new HostComparisonBudget(),
			yieldToHost: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
		});
		// Read again: the restore may have refreshed the record while the planner was yielding.
		const latest = this.deps.store.getEmbed(resolved.identity);
		if (latest === undefined || latest.contentHash === resolved.sliceHash || outcome.update === null) return latest;
		return { ...latest, contentHash: outcome.update.contentHash, folds: outcome.update.folds as unknown as StoredAnchor[] };
	}
}

/** One arrow of an embed, with what is needed to find its block in the embed's slice. */
export interface EmbedArrow {
	indicator: Element;
	toggle: ToggleRef;
}

/**
 * The fold arrows that belong to `embedEl` itself (not to an embed nested inside it), in DOM
 * order, each with the `ToggleRef` that finds its block in the embed's slice. Read-only.
 */
export function describeArrows(embedEl: Element): EmbedArrow[] {
	const own = Array.from(embedEl.querySelectorAll(INDICATOR_SELECTOR)).filter((t) => t.closest(EMBED_SELECTOR) === embedEl);
	const described = own.map((t) => ({
		family: t.classList.contains("heading-collapse-indicator") ? ("heading" as const) : ("list" as const),
		text: rowText(t),
	}));
	return own.map((indicator, index): EmbedArrow => {
		const mine = described[index];
		const same = (d: { family: string; text: string }): boolean => d.family === mine.family && d.text === mine.text;
		return {
			indicator,
			toggle: {
				family: mine.family,
				text: mine.text,
				sameBefore: described.slice(0, index).filter(same).length,
				sameTotal: described.filter(same).length,
				index,
				total: own.length,
			},
		};
	});
}

/**
 * The chain of embed elements from the outermost one down to `embedEl`, as the facts
 * `locateEmbed` needs at each level. `outermost` is the host-level embed element.
 */
export function embedLevels(embedEl: Element, hostContainer: Element): { levels: EmbedLevelFacts[]; outermost: Element } {
	const chain: Element[] = [];
	for (let el: Element | null = embedEl; el !== null; el = el.parentElement?.closest(EMBED_SELECTOR) ?? null) chain.unshift(el);
	const levels = chain.map((el, i): EmbedLevelFacts => {
		const container = i === 0 ? (el.closest(SURFACE_SELECTOR) ?? hostContainer) : chain[i - 1];
		const parentEmbed = i === 0 ? null : chain[i - 1];
		const siblings = Array.from(container.querySelectorAll(EMBED_SELECTOR)).filter(
			(s) => (s.parentElement?.closest(EMBED_SELECTOR) ?? null) === parentEmbed
		);
		return { src: el.getAttribute("src") ?? "", siblingSrcs: siblings.map((s) => s.getAttribute("src") ?? ""), index: siblings.indexOf(el) };
	});
	return { levels, outermost: chain[0] };
}

/** An embed's key, and the slice of its target it shows, resolved from the host's text. */
export interface ResolvedEmbed {
	identity: EmbedIdentity;
	sliceText: string;
	sliceHash: string;
}

export interface ResolveEmbedArgs {
	hostPath: string;
	hostText: string;
	levels: EmbedLevelFacts[];
	position: number | null;
	resolveLink: (linktext: string, sourcePath: string) => string | null;
	readNote: (path: string) => Promise<string | null>;
	/** Checked after each read; true stops the resolution (the caller was disposed). */
	isCancelled?: () => boolean;
}

/**
 * Follows the chain host > outer embed > ... > this embed through the source text, counting each
 * link's occurrence in the text that contains it (G7, E1), and cuts the innermost embed's slice
 * (PR-3). Shared by the recorder and the restore so both key an embed exactly the same way.
 * Null when any link cannot be located, a target is missing, or the slice is broken.
 */
export async function resolveEmbedChain(args: ResolveEmbedArgs): Promise<ResolvedEmbed | null> {
	let text = args.hostText;
	let source = args.hostPath;
	const chain: EmbedLinkId[] = [];
	let sliceText = "";
	let sliceHash = "";
	for (let i = 0; i < args.levels.length; i++) {
		const sourcePath = source;
		const link = locateEmbed(text, sourcePath, args.levels[i], (lt) => args.resolveLink(lt, sourcePath), i === 0 ? args.position : null);
		if (link === null) return null;
		chain.push(link);
		const targetText = await args.readNote(link.target);
		if ((args.isCancelled?.() ?? false) || targetText === null) return null;
		const slice = sliceEmbed(targetText, link.subpath);
		if (slice === null) return null;
		text = slice.text;
		source = link.target;
		sliceText = slice.text;
		sliceHash = slice.hash;
	}
	const innermost = chain[chain.length - 1];
	if (innermost === undefined) return null;
	const identity: EmbedIdentity = { host: args.hostPath, ...innermost };
	if (chain.length > 1) identity.outer = chain.slice(0, -1);
	return { identity, sliceText, sliceHash };
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
