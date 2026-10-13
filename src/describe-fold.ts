/**
 * PR-2's placeholder for the anchor builder PR-3 adds and PR-5 wires in in its place (see the
 * file comment in src/fold-recorder.ts, which calls this as its one seam). Until then, a fold or
 * unfold is described by exactly three things: the folded line's raw text, a rough `kind` guess
 * from that line's leading syntax, and its indent column (a tab counts as 4, matching the ticket
 * plan's Anchor definition) — nothing structural (no sibling index, no parent chain) and no
 * character offsets are stored.
 *
 * `kind` here is a simple, line-local guess good enough to prove recording works for every
 * foldable kind (G1) — it is deliberately not the real structural classification PR-3's anchor
 * builder will produce (that needs the syntax tree and the parent chain, not just one line).
 */
import type { EditorState } from "@codemirror/state";

export type FoldKind =
	| "heading"
	| "task"
	| "list"
	| "callout"
	| "blockquote"
	| "frontmatter"
	| "code-block"
	| "other";

export interface FoldDescriptor {
	text: string;
	kind: FoldKind;
	indent: number;
}

/** Column width of a tab for indent counting (ticket plan: "a tab counted as 4"). */
const TAB_WIDTH = 4;

function indentColumns(lineText: string): number {
	let columns = 0;
	for (const ch of lineText) {
		if (ch === "\t") columns += TAB_WIDTH;
		else if (ch === " ") columns += 1;
		else break;
	}
	return columns;
}

const CODE_FENCE = /^(```|~~~)/;
const CALLOUT = /^>\s*\[!\w+\][+-]?/;
const BLOCKQUOTE = /^>/;
const HEADING = /^#{1,6}\s/;
const TASK = /^(-|\*|\+|\d+[.)])\s+\[[^\]]\]/;
const LIST = /^(-|\*|\+|\d+[.)])\s+/;

function classifyKind(lineText: string, lineNumber: number): FoldKind {
	const trimmed = lineText.trim();
	// E13: frontmatter has one anchor; it's the opening "---" delimiter, and only when it's the
	// very first line of the document (a "---" anywhere else is a horizontal rule or, inside a
	// callout/blockquote, just text).
	if (trimmed === "---" && lineNumber === 1) return "frontmatter";
	if (CODE_FENCE.test(trimmed)) return "code-block";
	if (CALLOUT.test(trimmed)) return "callout";
	if (BLOCKQUOTE.test(trimmed)) return "blockquote";
	if (HEADING.test(trimmed)) return "heading";
	if (TASK.test(trimmed)) return "task";
	if (LIST.test(trimmed)) return "list";
	return "other";
}

/** The one seam PR-5 replaces (spec: "the recorder calls one seam, describeFold(state, range)").
 * `range` is the folded range from a `foldEffect`/`unfoldEffect` value — only `range.from` (the
 * folded line's start) is used; `range.to` is CM6's own bookkeeping for where the fold closes
 * and isn't needed to describe what was folded. */
export function describeFold(state: EditorState, range: { from: number; to: number }): FoldDescriptor {
	const line = state.doc.lineAt(range.from);
	return {
		text: line.text,
		kind: classifyKind(line.text, line.number),
		indent: indentColumns(line.text),
	};
}
