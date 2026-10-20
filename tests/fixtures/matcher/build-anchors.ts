/**
 * Shared PR-4 test fixture helper: turns a small markdown string into the flat `Anchor[]` shape
 * `matchAnchors` consumes, by running it through PR-3's real extractor (`buildAnchors`) rather
 * than hand-building `Anchor` objects — so every matcher test exercises the same anchor shapes
 * (kind, indent, normalized text, sibling index, parent chain) the plugin will actually produce.
 * The only fake anywhere in the PR-4 test suite is `yieldToHost` (tests/unit/matcher-caps.test.ts).
 */
import { buildAnchors, type Anchor } from "../../../src/anchors";

/** Every foldable block in `markdown`, as plain `Anchor`s (line ranges dropped — the matcher
 * never needs them). Order matches `buildAnchors`' own document-order traversal. */
export function anchorsFrom(markdown: string): Anchor[] {
	return buildAnchors(markdown).map((block) => block.anchor);
}

/** Convenience for picking out one anchor from a fixture by predicate, failing loudly (via a
 * thrown error, not a silent `undefined`) if the fixture doesn't have exactly one match — tests
 * should fix the fixture, not the helper, when this throws. */
export function findAnchor(anchors: Anchor[], predicate: (anchor: Anchor) => boolean): Anchor {
	const matches = anchors.filter(predicate);
	if (matches.length !== 1) {
		throw new Error(`findAnchor: expected exactly one match, found ${matches.length}`);
	}
	return matches[0];
}

/** Index of the one anchor in `anchors` matching `predicate`, for building `target` expectations
 * against a `candidates` array without hard-coding positions that would silently drift if the
 * fixture's line order changes. */
export function indexOfAnchor(anchors: Anchor[], predicate: (anchor: Anchor) => boolean): number {
	const indices = anchors.reduce<number[]>((acc, anchor, i) => {
		if (predicate(anchor)) acc.push(i);
		return acc;
	}, []);
	if (indices.length !== 1) {
		throw new Error(`indexOfAnchor: expected exactly one match, found ${indices.length}`);
	}
	return indices[0];
}
