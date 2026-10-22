/**
 * The pure embed key builder (ticket warkworth-21, PR-3). Reads a host note's source text,
 * finds every note embed in it (`![[...]]` and `![](x.md)`), counts each embed's occurrence
 * index among identical embeds in document order, and builds the embed key as structured fields
 * (`EmbedIdentity`: host, target, subpath, occurrence). Key builder and occurrence counter live
 * together on purpose: the index is part of the key and is only meaningful beside the scan that
 * produced it.
 *
 * Text in, plain data out. Nothing here touches Obsidian, CodeMirror, the DOM, files or the
 * store. Link resolution is injected as an optional `resolve(linktext)` (the caller passes
 * Obsidian's resolver); without it, or when it returns nothing, the link text as written is used.
 *
 * Rules this module keeps:
 * - The key carries host path, target path, subpath and occurrence index only: no line number,
 *   offset or host text hash, so editing the host around an embed never changes its key (G5).
 * - "Identical" means same target and subpath; alias and size (`|alias`, `|300`) are ignored.
 *   The index counts in the host's source text in document order, never render order (G7, E1).
 *   Inserting or deleting an identical embed earlier shifts later indices (E15, a known limit).
 * - Not embeds, and not counted: anything inside the host's frontmatter, fenced code, inline
 *   code (a fence inside a blockquote or callout, `> ```, included), `%%comments%%` and HTML
 *   comments; images, PDFs, audio, video and other non-note files.
 * - Never throws, and every scan is a single left-to-right pass: no regex runs over the text, so
 *   a 100,000-character line of unterminated `![[` cannot backtrack.
 *
 * Nested embeds (an embed inside embedded content) are keyed by the chain host > outer > inner
 * (`EmbedChainKey`). Each link's occurrence is counted in the text that contains it: the host's
 * source for the outer embed, the outer embed's slice text for the inner one.
 */
import type { EmbedIdentity } from "./types";

/** Maps link text (a note name or path, no subpath) to a vault path, or null when it does not
 * resolve. The caller passes Obsidian's resolver; this module never resolves anything itself. */
export type LinkResolver = (linktext: string) => string | null;

/** The part of an embed key that does not name the host. */
export interface EmbedLink {
	target: string;
	subpath: string;
	occurrence: number;
}

/** One embed found in a host, in document order. `ordinal` is its position among all note
 * embeds of the host (informational; it is not part of any key). */
export interface FoundEmbed extends EmbedLink {
	ordinal: number;
}

/** Key of an embed nested inside embedded content: the host, then each embed from the outermost
 * inward. A one-link chain is the same embed as the flat `EmbedIdentity`, in chain form. */
export interface EmbedChainKey {
	host: string;
	chain: EmbedLink[];
}

/** Extensions of files Obsidian embeds that are not notes (nothing to fold, G12). A denylist,
 * not "anything with an extension", so a note called `Meeting 1.5` still counts. */
const NON_NOTE_EXTENSIONS: ReadonlySet<string> = new Set([
	"png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif", "ico", "tif", "tiff", "heic",
	"mp3", "wav", "m4a", "ogg", "oga", "flac", "aac", "3gp", "opus",
	"mp4", "webm", "ogv", "mov", "mkv", "m4v",
	"pdf", "canvas", "base", "excalidraw",
]);

function isNoteTarget(path: string): boolean {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return true;
	return !NON_NOTE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/** `A.md` and `A` name the same note in the fallback (unresolved) form. */
function stripMarkdownExtension(path: string): string {
	return /\.md$/i.test(path) ? path.slice(0, -3) : path;
}

function decode(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
}

function isBlankChar(ch: string): boolean {
	return ch === " " || ch === "\t";
}

/** Index just past a frontmatter block at the very start of `src` (first line `---`, closed by
 * a later `---` or `...` line), or 0 when there is none. An unclosed `---` is not frontmatter
 * (the same rule as src/anchors.ts). */
function frontmatterEnd(src: string): number {
	const firstEnd = src.indexOf("\n");
	if (firstEnd === -1 || src.slice(0, firstEnd).trim() !== "---") return 0;
	let lineStart = firstEnd + 1;
	while (lineStart <= src.length) {
		let lineEnd = src.indexOf("\n", lineStart);
		if (lineEnd === -1) lineEnd = src.length;
		const trimmed = src.slice(lineStart, lineEnd).trim();
		if (trimmed === "---" || trimmed === "...") return Math.min(lineEnd + 1, src.length);
		if (lineEnd >= src.length) return 0;
		lineStart = lineEnd + 1;
	}
	return 0;
}

interface FenceOpen {
	char: string;
	length: number;
}

/** The fence opened by the line `src[lineStart, lineEnd)`, or null. Three or more backticks or
 * tildes after optional indent; a backtick fence's info string cannot contain a backtick (so
 * "```code```" on one line is inline code, not a fence). */
function openingFence(src: string, lineStart: number, lineEnd: number): FenceOpen | null {
	let p = lineStart;
	while (p < lineEnd && isBlankChar(src[p])) p++;
	const char = src[p];
	if (char !== "`" && char !== "~") return null;
	let q = p;
	while (q < lineEnd && src[q] === char) q++;
	if (q - p < 3) return null;
	if (char === "`") {
		for (let r = q; r < lineEnd; r++) {
			if (src[r] === "`") return null;
		}
	}
	return { char, length: q - p };
}

/** Index just past the blockquote / callout markers (`>` plus one optional following space,
 * repeated for nested quotes) at the start of the line `src[lineStart, lineEnd)`. Equal to
 * `lineStart` when the line is not quoted. */
function quotePrefixEnd(src: string, lineStart: number, lineEnd: number): number {
	let p = lineStart;
	for (;;) {
		let q = p;
		while (q < lineEnd && isBlankChar(src[q])) q++;
		if (src[q] !== ">" || q >= lineEnd) return p;
		p = q + 1;
		if (p < lineEnd && src[p] === " ") p++;
	}
}

/** Index just past the line that closes `fence` (same character, at least as long, nothing else
 * on the line), scanning from `from`; the end of the text when it never closes. A fence opened
 * inside a blockquote or callout (`quoted`) is closed by a quoted line, and ends without a
 * closing line at the first line that is no longer quoted (returning that line's start). */
function skipFence(src: string, from: number, fence: FenceOpen, quoted: boolean): number {
	let lineStart = from;
	while (lineStart < src.length) {
		let lineEnd = src.indexOf("\n", lineStart);
		if (lineEnd === -1) lineEnd = src.length;
		let contentStart = lineStart;
		if (quoted) {
			contentStart = quotePrefixEnd(src, lineStart, lineEnd);
			if (contentStart === lineStart) return lineStart;
		}
		const trimmed = src.slice(contentStart, lineEnd).trim();
		if (trimmed.length >= fence.length && trimmed.split(fence.char).join("") === "") {
			return Math.min(lineEnd + 1, src.length);
		}
		lineStart = lineEnd + 1;
	}
	return src.length;
}

/** An embed as written, before resolution: `target` is the link text without subpath or alias
 * (percent-decoded for markdown links), `subpath` is everything after the first `#`. */
interface RawEmbed {
	target: string;
	subpath: string;
}

function splitWikilink(content: string): RawEmbed {
	const bar = content.indexOf("|");
	let link = bar === -1 ? content : content.slice(0, bar);
	if (link.endsWith("\\")) link = link.slice(0, -1);
	const hash = link.indexOf("#");
	if (hash === -1) return { target: link.trim(), subpath: "" };
	return { target: link.slice(0, hash).trim(), subpath: link.slice(hash + 1).trim() };
}

function splitMarkdownDestination(dest: string): RawEmbed | null {
	const hash = dest.indexOf("#");
	const path = decode(hash === -1 ? dest : dest.slice(0, hash)).trim();
	if (!/\.md$/i.test(path) || path.includes("://")) return null;
	return { target: path, subpath: hash === -1 ? "" : decode(dest.slice(hash + 1)).trim() };
}

/** Wikilink `![[...]]` starting at `i`. Returns the embed (or null for a malformed or empty
 * one) and the index to resume scanning at. The content scan stops at a newline or any bracket,
 * so an opener that never closes costs one short scan and the next opener starts its own. */
function readWikilink(src: string, i: number): { embed: RawEmbed | null; next: number } {
	let j = i + 3;
	while (j < src.length) {
		const ch = src[j];
		if (ch === "\n" || ch === "[" || ch === "]") break;
		j++;
	}
	if (src[j] === "]" && src[j + 1] === "]") {
		return { embed: splitWikilink(src.slice(i + 3, j)), next: j + 2 };
	}
	return { embed: null, next: i + 1 };
}

/** Markdown link `![alt](dest)` starting at `i` (`src[i+1]` is `[`, `src[i+2]` is not). Same
 * bounded-scan rule as `readWikilink`: newlines and brackets end a failed attempt. */
function readMarkdownLink(src: string, i: number): { embed: RawEmbed | null; next: number } {
	const fail = { embed: null, next: i + 1 };
	let j = i + 2;
	while (j < src.length) {
		const ch = src[j];
		if (ch === "\n" || ch === "[" || ch === "]") break;
		j++;
	}
	if (src[j] !== "]" || src[j + 1] !== "(") return fail;

	let k = j + 2;
	let dest: string;
	if (src[k] === "<") {
		const start = ++k;
		while (k < src.length && src[k] !== ">" && src[k] !== "\n" && src[k] !== "[" && src[k] !== "]" && src[k] !== "<") k++;
		if (src[k] !== ">") return fail;
		dest = src.slice(start, k);
		k++;
	} else {
		const start = k;
		let depth = 0;
		while (k < src.length) {
			const ch = src[k];
			if (ch === "\n" || ch === "[" || ch === "]" || isBlankChar(ch)) break;
			if (ch === "(") depth++;
			else if (ch === ")") {
				if (depth === 0) break;
				depth--;
			}
			k++;
		}
		dest = src.slice(start, k);
	}
	// Optional title after the destination: skipped, up to the closing parenthesis.
	while (k < src.length && src[k] !== ")" && src[k] !== "\n" && src[k] !== "[" && src[k] !== "]") k++;
	if (src[k] !== ")") return fail;
	return { embed: splitMarkdownDestination(dest), next: k + 1 };
}

/** Every `![[...]]` and `![](x.md)` outside frontmatter, code and comments, in document order,
 * as written. One left-to-right pass. */
function scanRawEmbeds(text: string): RawEmbed[] {
	const src = text.replace(/\r\n?/g, "\n");
	const n = src.length;
	const found: RawEmbed[] = [];
	let i = frontmatterEnd(src);
	let atLineStart = true;
	let cachedStart = -1;
	let cachedEnd = -1;

	const endOfLine = (from: number): number => {
		if (from >= cachedStart && from <= cachedEnd) return cachedEnd;
		const idx = src.indexOf("\n", from);
		cachedStart = from;
		cachedEnd = idx === -1 ? n : idx;
		return cachedEnd;
	};

	while (i < n) {
		if (atLineStart) {
			atLineStart = false;
			const contentStart = quotePrefixEnd(src, i, endOfLine(i));
			const fence = openingFence(src, contentStart, endOfLine(i));
			if (fence !== null) {
				i = skipFence(src, endOfLine(i) + 1, fence, contentStart > i);
				atLineStart = true;
				continue;
			}
		}
		const ch = src[i];
		if (ch === "\n") {
			i++;
			atLineStart = true;
		} else if (ch === "`") {
			let run = 1;
			while (src[i + run] === "`") run++;
			const lineEnd = endOfLine(i);
			let j = i + run;
			let closedAt = -1;
			while (j < lineEnd) {
				if (src[j] !== "`") {
					j++;
					continue;
				}
				let closing = 1;
				while (src[j + closing] === "`") closing++;
				if (closing === run) {
					closedAt = j + closing;
					break;
				}
				j += closing;
			}
			i = closedAt === -1 ? i + run : closedAt;
		} else if (ch === "%" && src[i + 1] === "%") {
			const close = src.indexOf("%%", i + 2);
			i = close === -1 ? n : close + 2;
		} else if (ch === "<" && src.startsWith("<!--", i)) {
			const close = src.indexOf("-->", i + 4);
			i = close === -1 ? n : close + 3;
		} else if (ch === "!" && src[i + 1] === "[") {
			const read = src[i + 2] === "[" ? readWikilink(src, i) : readMarkdownLink(src, i);
			if (read.embed !== null) found.push(read.embed);
			i = read.next;
		} else {
			i++;
		}
	}
	return found;
}

function callResolver(resolve: LinkResolver | undefined, linktext: string): string | null {
	if (resolve === undefined || linktext === "") return null;
	try {
		const path = resolve(linktext);
		return typeof path === "string" && path !== "" ? path : null;
	} catch {
		return null;
	}
}

/** The target path for link text: the resolver's path when it resolves, else the text as
 * written without a trailing `.md`. */
function targetFor(linktext: string, resolve: LinkResolver | undefined): string {
	return callResolver(resolve, linktext) ?? stripMarkdownExtension(linktext);
}

function identityKey(target: string, subpath: string): string {
	return JSON.stringify([target, subpath]);
}

/**
 * Every note embed in `hostText`, in document order, each with its occurrence index among
 * identical embeds (same target and subpath, alias and size ignored). `![[#Heading]]` (no note
 * name) targets the host itself. Non-note embeds, and embeds in frontmatter, code or comments,
 * are not returned and not counted. Never throws.
 */
export function findEmbeds(hostPath: string, hostText: string, resolve?: LinkResolver): FoundEmbed[] {
	if (typeof hostText !== "string" || hostText === "") return [];
	const seen = new Map<string, number>();
	const result: FoundEmbed[] = [];
	for (const raw of scanRawEmbeds(hostText)) {
		let target: string;
		if (raw.target === "") {
			if (raw.subpath === "") continue;
			target = hostPath;
		} else {
			target = targetFor(raw.target, resolve);
		}
		if (!isNoteTarget(target)) continue;
		const id = identityKey(target, raw.subpath);
		const occurrence = seen.get(id) ?? 0;
		seen.set(id, occurrence + 1);
		result.push({ target, subpath: raw.subpath, occurrence, ordinal: result.length });
	}
	return result;
}

/** Builds the embed key for one embed of `host`: plain structured fields, never a joined string. */
export function buildEmbedKey(host: string, link: EmbedLink): EmbedIdentity {
	return { host, target: link.target, subpath: link.subpath, occurrence: link.occurrence };
}

/** The key of every note embed in `hostText`, in document order. */
export function listEmbedKeys(hostPath: string, hostText: string, resolve?: LinkResolver): EmbedIdentity[] {
	return findEmbeds(hostPath, hostText, resolve).map((embed) => buildEmbedKey(hostPath, embed));
}

/** Splits embed link text as Obsidian shows it on an embed (`Note`, `Note#Heading`,
 * `Note#^block`, optionally with an `|alias`) into target and subpath. Null when it names no
 * target and no subpath. */
export function parseEmbedLinktext(linktext: string): { target: string; subpath: string } | null {
	if (typeof linktext !== "string") return null;
	const { target, subpath } = splitWikilink(linktext);
	return target === "" && subpath === "" ? null : { target, subpath };
}

/**
 * The key of the `occurrence`-th (0-based) embed in `hostText` whose link text is `linktext`
 * (for example `Competitive Coding Fundamentals#^0169a6`), or null when the host does not have
 * that many such embeds.
 */
export function findEmbedKey(
	hostPath: string,
	hostText: string,
	linktext: string,
	occurrence = 0,
	resolve?: LinkResolver,
): EmbedIdentity | null {
	const parsed = parseEmbedLinktext(linktext);
	if (parsed === null) return null;
	const target = parsed.target === "" ? hostPath : targetFor(parsed.target, resolve);
	for (const embed of findEmbeds(hostPath, hostText, resolve)) {
		if (embed.target === target && embed.subpath === parsed.subpath && embed.occurrence === occurrence) {
			return buildEmbedKey(hostPath, embed);
		}
	}
	return null;
}

/** Key of a nested embed: the host, then the chain of embeds from the outermost inward. */
export function buildChainKey(host: string, chain: readonly EmbedLink[]): EmbedChainKey {
	return {
		host,
		chain: chain.map((link) => ({ target: link.target, subpath: link.subpath, occurrence: link.occurrence })),
	};
}

/** A string form of a key for use as a map key: JSON of the fields in a fixed order, so paths
 * containing `#`, `|`, `>`, `^`, `/`, `,` or quotes can never make two different keys equal. */
export function encodeEmbedKey(key: EmbedIdentity | EmbedChainKey): string {
	if ("chain" in key) {
		return JSON.stringify([key.host, key.chain.map((l) => [l.target, l.subpath, l.occurrence])]);
	}
	return JSON.stringify([key.host, key.target, key.subpath, key.occurrence]);
}
