/**
 * Pure text normalization for anchor building (PR-3). No Obsidian, CodeMirror, DOM, file or
 * network imports — text goes in, plain strings/numbers come out (fence: F1/F8/F9, enforced by
 * tests/unit/purity.test.ts).
 *
 * `normalizeText` is the single place that decides what to drop from the *leading* syntax of a
 * line (a checkbox marker, a list marker, heading hashes) and what to strip from the remaining
 * text (emphasis markup), so that two lines differing only in a task's status character, or only
 * in bold/italic styling, normalize to the same string (G5, settled calls).
 *
 * This file does not decide *kind* (heading vs task vs list vs ...) — that's a structural
 * decision `src/anchors.ts` makes from the raw line (and, for frontmatter/code/callout, from
 * more than one line). `normalizeText` only strips what anchors.ts tells it to strip by virtue
 * of the leading-marker patterns below; it has no notion of "this line is a task" on its own.
 */

/** Column width of a tab for indent counting (ticket plan: "a tab counted as 4"). Matches the
 * PR-2 placeholder in src/describe-fold.ts, which this module does not import (kept pure and
 * independent per the PR-3 brief) but must stay numerically consistent with. */
const TAB_WIDTH = 4;

/** Indent in columns, counting a tab as 4 and a space as 1, stopping at the first non-whitespace
 * character (or end of line, for an all-whitespace line). */
export function indentColumns(lineText: string): number {
	let columns = 0;
	for (const ch of lineText) {
		if (ch === "\t") columns += TAB_WIDTH;
		else if (ch === " ") columns += 1;
		else break;
	}
	return columns;
}

/** A leading list marker optionally followed by a checkbox status: `- [ ] `, `* [x] `,
 * `1. [/] `, `+ [-] `, or just `- ` / `1) ` with no checkbox at all. The checkbox is only
 * recognised when it immediately follows a list marker — `[x] foo` with no list marker in front
 * is left untouched, and `[x]` appearing later in the line is never matched by this (it's
 * anchored to the start of the trimmed line).
 *
 * The bracket contents must be exactly one character (`[^\]]`, not `[^\]]*`): every real
 * checkbox status is a single character (` `, `x`, `X`, `/`, `-`, `>`, `!`, `?`, `~`). Requiring
 * exactly one character is what keeps `[[wikilinks]]` and `[text](url)` from being misread as a
 * checkbox and partially eaten — a `*`/`+` quantifier here would greedily match into
 * `[[wikilink]]`'s first `]` and leave a stray `]` behind.
 *
 * R2 (PR-3): the closing `]` must also be followed by whitespace or the end of the line, so a
 * one-character link label (`- [a](http://x) foo`) is not eaten as if it were a checkbox. */
const LIST_MARKER_WITH_OPTIONAL_CHECKBOX = /^(?:[-*+]|\d+[.)])\s+(?:\[[^\]]\](?=\s|$)\s*)?/;

/** A leading heading marker: 1-6 `#` characters followed by whitespace. */
const HEADING_MARKER = /^#{1,6}\s+/;

/** Removes a single leading underscore unless it sits between two word characters (so
 * `snake_case` survives untouched, but `_italic_`'s underscores — each flanked by a non-word
 * character on their outer side — are stripped). Operates on offsets into the *original*
 * string, which `String.prototype.replace` provides even while building up the result, so this
 * is safe to run as one pass. */
function stripNonWordUnderscores(text: string): string {
	// R5 (PR-3): a "word character" is any Unicode letter or number, not just ASCII, so
	// `café_bar` keeps its underscore.
	return text.replace(/_/g, (match, offset: number, full: string) => {
		const before = full[offset - 1];
		const after = full[offset + 1];
		const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
		return isWordChar(before) && isWordChar(after) ? "_" : "";
	});
}

/**
 * Normalizes one logical line of fold-anchor text (G5, settled calls):
 * 1. Drops a leading checkbox marker + list marker, or a leading list marker alone, or leading
 *    heading hashes — whichever (if any) is present at the very start of the trimmed line.
 * 2. Applies Unicode NFC so visually-identical text normalizes the same regardless of
 *    composed/decomposed form.
 * 3. Strips emphasis markup: `**`, `__`, `~~`, `==` unconditionally, and `*` unconditionally
 *    (list/heading markers are already gone by this point, so any remaining `*` is emphasis);
 *    `_` is stripped only when it isn't holding two word characters together (so `snake_case`
 *    survives, see `stripNonWordUnderscores`).
 * 4. Case-folds (lower-cases).
 * 5. Collapses runs of whitespace to a single space and trims.
 *
 * Never throws; an empty, whitespace-only, or fully-stripped input normalizes to `""`.
 */
export function normalizeText(raw: string): string {
	const leadingTrimmed = raw.replace(/^[ \t]+/, "");

	let body: string;
	if (HEADING_MARKER.test(leadingTrimmed)) {
		body = leadingTrimmed.replace(HEADING_MARKER, "");
	} else if (LIST_MARKER_WITH_OPTIONAL_CHECKBOX.test(leadingTrimmed)) {
		body = leadingTrimmed.replace(LIST_MARKER_WITH_OPTIONAL_CHECKBOX, "");
	} else {
		body = leadingTrimmed;
	}

	let normalized = body.normalize("NFC");
	normalized = normalized.replace(/\*\*/g, "");
	normalized = normalized.replace(/__/g, "");
	normalized = normalized.replace(/~~/g, "");
	normalized = normalized.replace(/==/g, "");
	normalized = normalized.replace(/\*/g, "");
	normalized = stripNonWordUnderscores(normalized);
	normalized = normalized.toLowerCase();
	normalized = normalized.replace(/\s+/g, " ").trim();

	return normalized;
}
