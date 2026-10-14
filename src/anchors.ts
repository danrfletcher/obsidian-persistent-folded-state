/**
 * The pure anchor builder (PR-3). Given a note's full text, returns every foldable block as an
 * `Anchor` (structural identity: kind, indent, normalized text, sibling index, parent chain)
 * paired with the line range it covers. No Obsidian, CodeMirror, DOM, file or network imports —
 * text in, plain data out (fence: F1/F8/F9, enforced by tests/unit/purity.test.ts).
 *
 * This module decides *kind* and *structure* (what nests under what, indent, sibling counting).
 * `src/normalize.ts` decides what to strip from a line's leading syntax and markup — this module
 * only decides which substring of a line normalizeText sees (e.g. the fence's info string for a
 * code block, or the post-`>` content for a callout/blockquote), and what kind that substring
 * belongs to.
 *
 * Deliberately out of scope here (PR-4): similarity scoring, tiers, thresholds, ambiguity, caps.
 * This module has no notion of "the same anchor across two documents" — `anchorKey` is a plain
 * content key (useful for an exact-match tier later), not a matcher.
 *
 * Algorithm (single linear pass, O(n) for an n-line note — see the 20,000-line timing test):
 * 1. `segmentLines` walks the lines once, grouping each line into a `Segment` — a single line
 *    for heading/task/list/other, or a whole consumed range for frontmatter/code/callout/
 *    blockquote (their interior lines never become their own segments: E13, "lines inside the
 *    block never produce anchors").
 * 2. `buildFromSegments` walks the segments once, maintaining a stack of open "frames" (one per
 *    still-open ancestor). Each segment's `depth` decides how many frames close before it: a
 *    heading's depth is its level (1-6, so a same-or-shallower heading always closes it); every
 *    other kind's depth is `CONTENT_BASE + indent` (always deeper than any heading, so a new
 *    heading always closes open list/task/etc. frames regardless of their indent, and content
 *    nests by indent alone once inside a heading section). Sibling counting and the parent chain
 *    read straight off this stack. A single-line segment's line range is finalized lazily: when
 *    it's later popped off the stack (because something at its depth or shallower follows, or
 *    end of file is reached), its range's `endLine` is set to the line before whatever closed
 *    it. This is what keeps the whole pass O(n) instead of re-scanning forward per segment.
 */
import { indentColumns, normalizeText } from "./normalize";

export type AnchorKind =
	| "heading"
	| "task"
	| "list"
	| "callout"
	| "blockquote"
	| "frontmatter"
	| "code"
	| "other";

const ANCHOR_KINDS: ReadonlySet<string> = new Set<AnchorKind>([
	"heading",
	"task",
	"list",
	"callout",
	"blockquote",
	"frontmatter",
	"code",
	"other",
]);

/** A breadcrumb entry for one ancestor. Deliberately just `kind` + normalized `text` — no
 * indent, no sibling index, no line info, so it stays a pure tiebreak and renaming/moving an
 * ancestor's *other* fields never ripples into a child's own anchor. */
export interface AnchorParentRef {
	kind: AnchorKind;
	text: string;
}

/** Structural identity of a fold. Carries no line number or offset by design (E4's "stale
 * offsets" problem this whole module exists to avoid) — that's `AnchoredBlock.range`'s job. */
export interface Anchor {
	kind: AnchorKind;
	indent: number;
	text: string;
	siblingIndex: number;
	parentChain: AnchorParentRef[];
}

/** 1-indexed, inclusive line range for the block an `Anchor` describes. Kept beside the anchor,
 * never inside it, per the PR-3 brief. */
export interface LineRange {
	startLine: number;
	endLine: number;
}

export interface AnchoredBlock {
	anchor: Anchor;
	range: LineRange;
}

/** A deterministic, order-independent-of-location content key for an anchor: everything except
 * the parent chain (so renaming a grandparent never changes a child's key — the parent chain is
 * a tiebreak only, never part of identity). Two anchors differing only by a task's status
 * character (which normalizeText already erases) produce the same key. */
export function anchorKey(anchor: Anchor): string {
	return JSON.stringify([anchor.kind, anchor.indent, anchor.siblingIndex, anchor.text]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseParentRef(value: unknown): AnchorParentRef | null {
	if (!isPlainObject(value)) return null;
	if (typeof value.kind !== "string" || !ANCHOR_KINDS.has(value.kind)) return null;
	if (typeof value.text !== "string") return null;
	return { kind: value.kind as AnchorKind, text: value.text };
}

/** Validates and reconstructs an `Anchor` from arbitrary (e.g. freshly `JSON.parse`d) input.
 * Never throws: returns `null` for anything that isn't a well-formed Anchor — missing fields,
 * wrong types, a non-object, an unknown `kind`, a non-array `parentChain`, or a malformed entry
 * inside `parentChain`. Round-trips a valid Anchor through JSON unchanged. */
export function parseAnchor(value: unknown): Anchor | null {
	if (!isPlainObject(value)) return null;
	const { kind, indent, text, siblingIndex, parentChain } = value;

	if (typeof kind !== "string" || !ANCHOR_KINDS.has(kind)) return null;
	if (typeof indent !== "number" || !Number.isFinite(indent) || indent < 0) return null;
	if (typeof text !== "string") return null;
	if (typeof siblingIndex !== "number" || !Number.isFinite(siblingIndex) || siblingIndex < 0) return null;
	if (!Array.isArray(parentChain)) return null;

	const parsedChain: AnchorParentRef[] = [];
	for (const entry of parentChain) {
		const parsed = parseParentRef(entry);
		if (parsed === null) return null;
		parsedChain.push(parsed);
	}

	return {
		kind: kind as AnchorKind,
		indent,
		text,
		siblingIndex,
		parentChain: parsedChain,
	};
}

/** Depth base for every non-heading kind, so content always nests *inside* the nearest
 * enclosing heading (every heading level 1-6 is shallower than any `CONTENT_BASE + indent`) and
 * closes at a heading of any level. Indent then decides nesting among content itself. */
const CONTENT_BASE = 1000;

const HEADING_LINE = /^(#{1,6})\s/;
/** Exactly one character inside the brackets — see the comment on the equivalent regex in
 * normalize.ts for why `[^\]]` (not `[^\]]*`) matters for not misreading `[[wikilinks]]`. */
const TASK_LINE = /^(?:[-*+]|\d+[.)])\s+\[[^\]]\]/;
const LIST_LINE = /^(?:[-*+]|\d+[.)])\s+/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const QUOTE_LINE = /^>/;
const QUOTE_PREFIX = /^>\s*/;
const CALLOUT_CONTENT = /^\[!\w+\][+-]?/;

interface Segment {
	kind: AnchorKind;
	indent: number;
	text: string;
	startLine: number;
	endLine: number;
	/** See the file comment: heading uses its level (1-6); everything else uses
	 * `CONTENT_BASE + indent`. */
	depth: number;
}

interface Fence {
	char: string;
	length: number;
	info: string;
}

function matchFenceOpen(trimmed: string): Fence | null {
	const match = FENCE_OPEN.exec(trimmed);
	if (match === null) return null;
	const marker = match[1];
	return { char: marker[0], length: marker.length, info: match[2] };
}

/** Index (0-indexed) of the line that closes `fence`, scanning from `fromIndex`, or -1 if the
 * fence is never closed (runs to end of file: E13 "an unterminated fence runs to end of file and
 * still yields one anchor"). A closing fence is the same character, at least as long as the
 * opening one, and nothing else on the line (CommonMark's rule — no info string on the close). */
function findFenceClose(lines: string[], fromIndex: number, fence: Fence): number {
	const closeRe = new RegExp(`^${fence.char}{${fence.length},}$`);
	for (let i = fromIndex; i < lines.length; i++) {
		if (closeRe.test(lines[i].trim())) return i;
	}
	return -1;
}

/** Index (0-indexed) of the line that closes a frontmatter block opened at line 1, scanning from
 * line 2, or -1 if there is no closing `---`/`...` (E13: "has no closing ---/... is not
 * frontmatter"). */
function findFrontmatterClose(lines: string[]): number {
	for (let i = 1; i < lines.length; i++) {
		const trimmed = lines[i].trim();
		if (trimmed === "---" || trimmed === "...") return i;
	}
	return -1;
}

/** Splits `text` into logical lines for anchoring: CRLF and bare CR are normalized to LF, and a
 * single trailing newline (if present) doesn't produce a phantom extra empty line — so CRLF vs
 * LF and a trailing-newline-or-not never change the resulting anchors. */
function splitLines(text: string): string[] {
	const normalized = text.replace(/\r\n?/g, "\n");
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Pass 1: groups the note's lines into segments (E13's frontmatter/code-fence/callout/
 * blockquote handling lives here — everything else is a single-line segment). */
function segmentLines(lines: string[]): Segment[] {
	const segments: Segment[] = [];
	const n = lines.length;
	let i = 0;

	while (i < n) {
		const raw = lines[i];
		const trimmed = raw.trim();
		const lineNumber = i + 1;

		if (trimmed === "") {
			i++;
			continue;
		}

		// E13: frontmatter is only recognised as the very first line of the document.
		if (i === 0 && trimmed === "---") {
			const closeIdx = findFrontmatterClose(lines);
			if (closeIdx !== -1) {
				segments.push({
					kind: "frontmatter",
					indent: 0,
					text: "frontmatter",
					startLine: 1,
					endLine: closeIdx + 1,
					depth: CONTENT_BASE,
				});
				i = closeIdx + 1;
				continue;
			}
			// No closing delimiter: not frontmatter (E13) — falls through and is classified
			// below like any other line (a bare "---" that isn't a heading/task/list matches
			// none of those patterns, so it becomes "other").
		}

		const fence = matchFenceOpen(trimmed);
		if (fence !== null) {
			const indent = indentColumns(raw);
			const closeIdx = findFenceClose(lines, i + 1, fence);
			const endLineIdx = closeIdx === -1 ? n - 1 : closeIdx;
			segments.push({
				kind: "code",
				indent,
				text: normalizeText(fence.info),
				startLine: lineNumber,
				endLine: endLineIdx + 1,
				depth: CONTENT_BASE + indent,
			});
			i = endLineIdx + 1;
			continue;
		}

		if (QUOTE_LINE.test(trimmed)) {
			const indent = indentColumns(raw);
			let end = i;
			while (end + 1 < n && QUOTE_LINE.test(lines[end + 1].trim())) end++;
			const firstContent = trimmed.replace(QUOTE_PREFIX, "");
			const kind: AnchorKind = CALLOUT_CONTENT.test(firstContent) ? "callout" : "blockquote";
			segments.push({
				kind,
				indent,
				text: normalizeText(firstContent),
				startLine: lineNumber,
				endLine: end + 1,
				depth: CONTENT_BASE + indent,
			});
			i = end + 1;
			continue;
		}

		const indent = indentColumns(raw);
		const headingMatch = HEADING_LINE.exec(trimmed);
		if (headingMatch !== null) {
			segments.push({
				kind: "heading",
				indent: 0,
				text: normalizeText(trimmed),
				startLine: lineNumber,
				endLine: lineNumber,
				depth: headingMatch[1].length,
			});
		} else if (TASK_LINE.test(trimmed)) {
			segments.push({
				kind: "task",
				indent,
				text: normalizeText(trimmed),
				startLine: lineNumber,
				endLine: lineNumber,
				depth: CONTENT_BASE + indent,
			});
		} else if (LIST_LINE.test(trimmed)) {
			segments.push({
				kind: "list",
				indent,
				text: normalizeText(trimmed),
				startLine: lineNumber,
				endLine: lineNumber,
				depth: CONTENT_BASE + indent,
			});
		} else {
			segments.push({
				kind: "other",
				indent,
				text: normalizeText(trimmed),
				startLine: lineNumber,
				endLine: lineNumber,
				depth: CONTENT_BASE + indent,
			});
		}
		i++;
	}

	return segments;
}

/** Kinds whose single-line segment range is extended lazily to cover their subtree (heading
 * section, list/task item body, or any other foldable range that nests by indent). Frontmatter/
 * code/callout/blockquote already have their full (possibly multi-line) range fixed at
 * segmentation time and are never extended further. */
const EXTENDABLE: ReadonlySet<AnchorKind> = new Set<AnchorKind>(["heading", "task", "list", "other"]);

interface Frame {
	depth: number;
	kind: AnchorKind | "root";
	text: string;
	childCounts: Map<AnchorKind, number>;
	block?: AnchoredBlock;
}

/** Pass 2: turns segments into `AnchoredBlock`s — parent chain, sibling index and (for
 * extendable kinds) the lazily-closed subtree range, all read off one stack walked once. */
function buildFromSegments(segments: Segment[], totalLines: number): AnchoredBlock[] {
	const root: Frame = { depth: -1, kind: "root", text: "", childCounts: new Map() };
	const stack: Frame[] = [root];
	const result: AnchoredBlock[] = [];

	const closeFramesAbove = (depth: number, closingBeforeLine: number): void => {
		while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
			const frame = stack.pop() as Frame;
			if (frame.block !== undefined && EXTENDABLE.has(frame.block.anchor.kind)) {
				frame.block.range.endLine = closingBeforeLine - 1;
			}
		}
	};

	for (const seg of segments) {
		closeFramesAbove(seg.depth, seg.startLine);

		const parentFrame = stack[stack.length - 1];
		const parentChain: AnchorParentRef[] = stack
			.slice(1)
			.map((f): AnchorParentRef => ({ kind: f.kind as AnchorKind, text: f.text }));
		const siblingIndex = parentFrame.childCounts.get(seg.kind) ?? 0;
		parentFrame.childCounts.set(seg.kind, siblingIndex + 1);

		const anchor: Anchor = {
			kind: seg.kind,
			indent: seg.indent,
			text: seg.text,
			siblingIndex,
			parentChain,
		};
		const block: AnchoredBlock = {
			anchor,
			range: { startLine: seg.startLine, endLine: seg.endLine },
		};
		result.push(block);

		stack.push({ depth: seg.depth, kind: seg.kind, text: seg.text, childCounts: new Map(), block });
	}

	// End of file: anything still open closes here instead of at a following segment.
	closeFramesAbove(Number.NEGATIVE_INFINITY, totalLines + 1);

	return result;
}

/**
 * Builds every foldable block's `Anchor` + line range from a note's full text, in one linear
 * pass. Never mutates its input, never throws, and gives the same output for repeated calls on
 * the same input (no hidden state carried between calls).
 */
export function buildAnchors(text: string): AnchoredBlock[] {
	const lines = splitLines(text);
	const segments = segmentLines(lines);
	return buildFromSegments(segments, lines.length);
}
