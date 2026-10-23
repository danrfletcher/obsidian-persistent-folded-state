/**
 * The pure embed slice cutter (ticket warkworth-21, PR-3). Given the text of an embed's target
 * note and the embed's subpath, returns the part of the target the embed shows and a content hash
 * of it, or null when the embed cannot be resolved against that text.
 *
 * Text in, plain data out. Nothing here touches Obsidian, CodeMirror, the DOM, files or the
 * store. The slice text is meant to be fed to `buildAnchors` (src/anchors.ts), so folds inside an
 * embed are anchored over the slice exactly as a note's folds are anchored over the note.
 *
 * Subpath forms (the `subpath` field of an embed key):
 * - `""`: whole-note embed. The body without frontmatter (a `---` that is never closed is not
 *   frontmatter, the same rule as src/anchors.ts). A frontmatter-only note gives `""`.
 * - `"^id"`: block embed. An id at the end of a list item covers that item and every deeper
 *   indented child (a tab counts as 4 columns); an id at the end of a paragraph covers the
 *   paragraph (up to the previous blank line or heading); an id alone on its own line refers to
 *   the block above it. Ids inside fenced code do not count. A list item inside a callout or
 *   blockquote (`> - item ^id`) works the same way, with its `>` markers removed from the slice.
 * - `"Heading"` or `"A#B"`: heading embed. From the heading line to just before the next heading
 *   of the same or a higher level; deeper headings stay inside. `#` lines in fenced code are not
 *   headings. `A#B` finds heading B inside heading A's section. Headings are compared after
 *   `normalizeText`.
 *
 * `null` means broken (the target text is empty, the subpath is malformed, or the block id or
 * heading is not there). That is different from a slice whose text is `""` (a real but empty
 * embed), so a later PR can tell "broken" from "empty". Never throws.
 *
 * The slice is dedented so its first line has indent 0, line endings are LF (CRLF and bare CR
 * read the same), and trailing blank lines are dropped, so the text and hash do not depend on
 * the target's line-ending style or on blank lines after the slice. Edits elsewhere in the
 * target leave the text and hash unchanged. Every function makes one pass over the lines.
 */
import { hashText } from "./fold-store";
import { indentColumns, normalizeText } from "./normalize";

export interface EmbedSlice {
	/** The slice text, LF line endings, first line at indent 0, no trailing blank lines. */
	text: string;
	/** `hashText(text)`. */
	hash: string;
}

const BLOCK_ID_PATTERN = /^[A-Za-z0-9-]+$/;
/** An id at the end of a line, preceded by whitespace or the start of the line. */
const BLOCK_ID_AT_END = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
const OWN_LINE_BLOCK_ID = /^\^[A-Za-z0-9-]+$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const HEADING_LINE = /^(#{1,6})\s/;
/** One blockquote / callout marker: `>` plus one optional following space, after optional indent. */
const QUOTE_MARKER = /^[ \t]*>[ ]?/;

/** The line without its leading blockquote / callout markers (nested quotes included); the line
 * itself when it is not quoted. */
function stripQuote(line: string): string {
	let rest = line;
	for (let match = QUOTE_MARKER.exec(rest); match !== null; match = QUOTE_MARKER.exec(rest)) {
		rest = rest.slice(match[0].length);
	}
	return rest;
}

/** How many `>` markers open the line. */
function quoteDepth(line: string): number {
	let depth = 0;
	let rest = line;
	for (let match = QUOTE_MARKER.exec(rest); match !== null; match = QUOTE_MARKER.exec(rest)) {
		rest = rest.slice(match[0].length);
		depth++;
	}
	return depth;
}

interface Note {
	lines: string[];
	/** Index of the first body line (just past frontmatter, or 0). */
	bodyStart: number;
	/** `inCode[i]` is 1 for a line that is part of a fenced code block (fences included). */
	inCode: Uint8Array;
}

/** Splits `text` into lines (CRLF and bare CR read as LF, one trailing newline dropped), finds
 * the frontmatter end and marks fenced code lines, all in one pass. */
function parseNote(text: string): Note {
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	let bodyStart = 0;
	if (lines.length > 0 && lines[0].trim() === "---") {
		for (let i = 1; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed === "---" || trimmed === "...") {
				bodyStart = i + 1;
				break;
			}
		}
	}

	const inCode = new Uint8Array(lines.length);
	let fenceChar = "";
	let fenceLength = 0;
	let fenceQuoted = false;
	for (let i = bodyStart; i < lines.length; i++) {
		// A fence inside a blockquote or callout is written `> ``` `: markers are stripped before
		// looking for it, and it ends at the first line that is no longer quoted.
		const quoted = lines[i].includes(">") && quoteDepth(lines[i]) > 0;
		if (fenceChar !== "" && fenceQuoted && !quoted) fenceChar = "";
		// While an unquoted fence is open its closing line is tested raw: a `> ```` line inside an
		// ordinary code block is code, not a close. Markers are stripped only to open a fence or
		// to close a quoted one.
		const stripped = quoted && (fenceChar === "" || fenceQuoted);
		const trimmed = (stripped ? stripQuote(lines[i]) : lines[i]).trim();
		if (fenceChar !== "") {
			inCode[i] = 1;
			if (trimmed.length >= fenceLength && trimmed.split(fenceChar).join("") === "") fenceChar = "";
			continue;
		}
		const first = trimmed[0];
		if (first !== "`" && first !== "~") continue;
		let run = 1;
		while (trimmed[run] === first) run++;
		if (run < 3) continue;
		if (first === "`" && trimmed.indexOf("`", run) !== -1) continue;
		fenceChar = first;
		fenceLength = run;
		fenceQuoted = quoted;
		inCode[i] = 1;
	}
	return { lines, bodyStart, inCode };
}

function headingLevel(line: string): number {
	const match = HEADING_LINE.exec(line.trim());
	return match === null ? 0 : match[1].length;
}

/** Removes up to `columns` columns of leading whitespace (tab = 4) from `line`. */
function dedent(line: string, columns: number): string {
	let removed = 0;
	let i = 0;
	while (i < line.length && removed < columns) {
		const ch = line[i];
		if (ch === " ") removed += 1;
		else if (ch === "\t") removed += 4;
		else break;
		i++;
	}
	return line.slice(i);
}

/** Lines `[start, end]` (inclusive) as a slice: dedented by the first line's indent, trailing
 * blank lines dropped. With `unquote` the blockquote / callout markers are removed from every
 * line first (a block inside a callout is shown without the callout's `>`). */
function cut(note: Note, start: number, end: number, unquote = false): EmbedSlice {
	const lineAt = (i: number): string => (unquote ? stripQuote(note.lines[i]) : note.lines[i]);
	let last = end;
	while (last > start && lineAt(last).trim() === "") last--;
	const columns = indentColumns(lineAt(start));
	const out: string[] = [];
	for (let i = start; i <= last; i++) out.push(dedent(lineAt(i), columns));
	const text = out.join("\n");
	return { text, hash: hashText(text) };
}

function sliceWholeNote(note: Note): EmbedSlice {
	let last = note.lines.length - 1;
	while (last >= note.bodyStart && note.lines[last].trim() === "") last--;
	if (last < note.bodyStart) return { text: "", hash: hashText("") };
	return cut(note, note.bodyStart, last);
}

/** Start of the paragraph that ends at line `end`: walks up to the previous blank line, heading,
 * code fence or the body start. */
function paragraphStart(note: Note, end: number): number {
	let start = end;
	while (start - 1 >= note.bodyStart) {
		const above = note.lines[start - 1];
		if (above.trim() === "" || note.inCode[start - 1] === 1 || headingLevel(above) > 0) break;
		start--;
	}
	return start;
}

function sliceBlock(note: Note, id: string): EmbedSlice | null {
	if (!BLOCK_ID_PATTERN.test(id)) return null;
	const wanted = id.toLowerCase();

	let idx = -1;
	for (let i = note.bodyStart; i < note.lines.length; i++) {
		if (note.inCode[i] === 1) continue;
		const line = note.lines[i];
		if (!line.includes("^")) continue;
		const match = BLOCK_ID_AT_END.exec(line);
		if (match !== null && match[1].toLowerCase() === wanted) {
			idx = i;
			break;
		}
	}
	if (idx === -1) return null;

	const line = note.lines[idx];
	if (OWN_LINE_BLOCK_ID.test(line.trim())) {
		// An id alone on its line refers to the block above it (blank lines between are skipped).
		let end = idx - 1;
		while (end >= note.bodyStart && note.lines[end].trim() === "") end--;
		if (end < note.bodyStart) return null;
		let start = end;
		if (note.inCode[end] === 1) {
			while (start - 1 >= note.bodyStart && note.inCode[start - 1] === 1) start--;
		} else if (headingLevel(note.lines[end]) === 0) {
			start = paragraphStart(note, end);
		}
		return cut(note, start, end);
	}

	// A list item in a callout or blockquote ('> - item ^id'): indents are compared after the
	// markers are stripped, and the item's children end where the quote does.
	const item = stripQuote(line);
	if (LIST_ITEM.test(item)) {
		const depth = quoteDepth(line);
		const base = indentColumns(item);
		let end = idx;
		for (let j = idx + 1; j < note.lines.length; j++) {
			const child = depth > 0 ? stripQuote(note.lines[j]) : note.lines[j];
			if (child.trim() === "") continue;
			if (depth > 0 && quoteDepth(note.lines[j]) < depth) break;
			if (indentColumns(child) <= base) break;
			end = j;
		}
		return cut(note, idx, end, depth > 0);
	}

	if (headingLevel(line) > 0) return cut(note, idx, idx);
	return cut(note, paragraphStart(note, idx), idx);
}

/** Finds the first heading in `[from, limit)` whose normalized text is `wanted`, and where its
 * section ends (the next heading of the same or a higher level, or `limit`). One scan. */
function findHeading(
	note: Note,
	from: number,
	limit: number,
	wanted: string,
): { index: number; end: number } | null {
	let index = -1;
	let level = 0;
	for (let i = from; i < limit; i++) {
		if (note.inCode[i] === 1) continue;
		const lvl = headingLevel(note.lines[i]);
		if (lvl === 0) continue;
		if (index === -1) {
			if (normalizeText(note.lines[i].trim()) === wanted) {
				index = i;
				level = lvl;
			}
		} else if (lvl <= level) {
			return { index, end: i };
		}
	}
	return index === -1 ? null : { index, end: limit };
}

function sliceHeading(note: Note, parts: string[]): EmbedSlice | null {
	let from = note.bodyStart;
	let limit = note.lines.length;
	let found: { index: number; end: number } | null = null;
	for (const part of parts) {
		found = findHeading(note, from, limit, normalizeText(`# ${part}`));
		if (found === null) return null;
		from = found.index + 1;
		limit = found.end;
	}
	if (found === null) return null;
	return cut(note, found.index, found.end - 1);
}

/**
 * The slice of `targetText` an embed with this `subpath` shows, with its content hash, or null
 * when the embed is broken (see the file comment). `subpath` is the key's subpath field: `""`
 * for a whole-note embed, `"^id"` for a block, a heading or `"A#B"` heading path otherwise.
 */
export function sliceEmbed(targetText: string, subpath: string): EmbedSlice | null {
	if (typeof targetText !== "string" || typeof subpath !== "string" || targetText === "") return null;
	const note = parseNote(targetText);
	if (subpath === "") return sliceWholeNote(note);
	if (subpath.startsWith("^")) return sliceBlock(note, subpath.slice(1).trim());
	const parts = subpath.split("#").map((part) => part.trim());
	if (parts.some((part) => part === "")) return null;
	return sliceHeading(note, parts);
}
