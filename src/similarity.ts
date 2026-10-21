/**
 * The pure similarity scorer (PR-4). Given two already-normalized strings (see
 * `normalizeText` in `src/normalize.ts` — this module doesn't normalize anything itself, it
 * just compares whatever text it's handed), returns a single 0..1 score blending token overlap
 * with edit distance. No Obsidian, CodeMirror, DOM, file or network imports — text in, a number
 * out (fence: F1/F8, enforced by `tests/unit/matcher-purity.test.ts`).
 *
 * Two components, averaged evenly (`TOKEN_WEIGHT`):
 * - Token overlap: a Jaccard coefficient (shared / (|tokens(a)| + |tokens(b)| - shared)) over
 *   whitespace-split token multisets. Harsh on "same words, different count" (e.g. one extra
 *   token added) and insensitive to word order. Jaccard rather than Dice deliberately: Dice's
 *   extra weight for the *shared* tokens makes a single appended word (e.g. "v2") score too
 *   close to identical for the 60/80% fuzzy bar to ever separate it from a genuine rewrite.
 * - Edit similarity: `1 - levenshtein(a, b) / max(a.length, b.length)`. Harsh on "same words,
 *   rearranged/retyped" and insensitive to which words changed.
 * Blending both keeps a short appended/removed word (token overlap drops, edit similarity barely
 * moves) and a retyped-but-same-length line (edit similarity drops, token overlap may not move)
 * both visible in the final score, rather than letting either effect alone decide a tier.
 */

/** Weight given to the token-overlap component; the edit-similarity component gets the rest.
 * Kept at an even split deliberately — neither signal is considered more reliable than the
 * other on its own (ticket plan: "token overlap blended with edit distance"). */
const TOKEN_WEIGHT = 0.5;

function tokenize(text: string): string[] {
	return text.split(/\s+/).filter((tok) => tok.length > 0);
}

/** Jaccard coefficient over token multisets: the size of the (multiset) intersection, over the
 * size of the (multiset) union. 1 when the multisets are identical, 0 when they share nothing.
 * Both inputs are guaranteed non-empty strings by `similarity`'s own empty-string short-circuit,
 * so `tokenize` always returns at least one token here, and the denominator is always >= 1. */
function tokenOverlap(a: string, b: string): number {
	const tokensA = tokenize(a);
	const tokensB = tokenize(b);

	const remaining = new Map<string, number>();
	for (const tok of tokensA) remaining.set(tok, (remaining.get(tok) ?? 0) + 1);

	let shared = 0;
	for (const tok of tokensB) {
		const count = remaining.get(tok) ?? 0;
		if (count > 0) {
			shared++;
			remaining.set(tok, count - 1);
		}
	}

	return shared / (tokensA.length + tokensB.length - shared);
}

/** Levenshtein edit distance, computed with a two-row rolling buffer (O(min(len)) memory
 * instead of a full O(a.length * b.length) matrix) so a 10,000-character line stays fast. Works
 * over UTF-16 code units (not grapheme clusters) — adequate for a similarity *score*, which
 * never needs to be character-exact, and keeps this simple and allocation-light. */
function levenshteinDistance(a: string, b: string): number {
	// `short` is the one we size the rolling rows to, so memory tracks the smaller string.
	const [short, long] = a.length <= b.length ? [a, b] : [b, a];
	const shortLen = short.length;
	const longLen = long.length;

	let previousRow = new Uint32Array(shortLen + 1);
	let currentRow = new Uint32Array(shortLen + 1);
	for (let i = 0; i <= shortLen; i++) previousRow[i] = i;

	for (let j = 1; j <= longLen; j++) {
		currentRow[0] = j;
		const longChar = long.charCodeAt(j - 1);
		for (let i = 1; i <= shortLen; i++) {
			const substitutionCost = short.charCodeAt(i - 1) === longChar ? 0 : 1;
			const deletion = previousRow[i] + 1;
			const insertion = currentRow[i - 1] + 1;
			const substitution = previousRow[i - 1] + substitutionCost;
			currentRow[i] = Math.min(deletion, insertion, substitution);
		}
		const swap = previousRow;
		previousRow = currentRow;
		currentRow = swap;
	}

	return previousRow[shortLen];
}

function editSimilarity(a: string, b: string): number {
	const maxLen = Math.max(a.length, b.length);
	return 1 - levenshteinDistance(a, b) / maxLen;
}

/** A defensive `NaN` guard only — not a numeric clamp. The token-overlap and edit-similarity
 * components are each already mathematically guaranteed to land in [0, 1] for any non-empty
 * input (a bounded ratio, correctly rounded), and a 50/50 blend of two such values can't leave
 * that range either — so the only real failure mode left is `NaN` from a 0/0 division (both
 * sides tokenizing to nothing, e.g. two different whitespace-only strings), which this turns
 * into 0 rather than ever surfacing. */
function guardNaN(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

/**
 * Similarity between two normalized strings, in 0..1. Symmetric (`similarity(a, b) ===
 * similarity(b, a)`), 1 for identical text (checked up front, before either component runs —
 * including both empty), and 0 (never `NaN`) whenever exactly one side is empty and they
 * differ. Never throws.
 */
export function similarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length === 0 || b.length === 0) return 0;

	const token = tokenOverlap(a, b);
	const edit = editSimilarity(a, b);
	return guardNaN(TOKEN_WEIGHT * token + (1 - TOKEN_WEIGHT) * edit);
}
