/**
 * G6 (dormant folds), run against the real CM6 pipeline, mirroring restore-golden-path.test.ts's
 * own harness: a real `EditorState`/`EditorView`, the real `createEditorWatcher`, a fake
 * `FoldStore` persistence layer, and the real settle debounce (real timers, not CM6-unrelated
 * fake ones — `now` for the *dormant clock* is injected separately so the 10-minute boundary
 * doesn't need an actual 10-minute wait).
 */
import { afterEach, describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore, hashText } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import { OWN_FOLD_ANNOTATION } from "../../src/fold-recorder";
import { buildAnchors, anchorKey, type Anchor, type AnchoredBlock } from "../../src/anchors";
import type { FileFoldRecord } from "../../src/types";

const NOTE_PATH = "Projects/Quarry/Tasks.md";

const TEXT_WITH_TUESDAY = "Notes\n\n## Tuesday\n- [ ] Draft proposal\n";
const TEXT_UNRELATED = "Notes\n\n## Zzz Qqq Www Completely Different Heading\n- [ ] Something else entirely\n";
// R3 (PR-6): the heading is *not* spelled exactly as the stored/dormant anchor ("tuesday"), so
// the anchor `describeFold` would build for the refolded block ("tuesdays") has a different key.
// A recorder that wrongly logged the dormant refold as a user fold would therefore add a second
// entry instead of merging into the stored one, and the length-1 assertion below would catch it.
const TEXT_WITH_TUESDAY_AGAIN = "Notes\n\n## Tuesdays\n- [ ] Draft proposal v2\n";

function findOneBlock(blocks: AnchoredBlock[], predicate: (a: Anchor) => boolean): AnchoredBlock {
	const matches = blocks.filter((b) => predicate(b.anchor));
	expect(matches).toHaveLength(1);
	return matches[0];
}

async function makeStore(seed: Record<string, FileFoldRecord>, now: () => number): Promise<FoldStore> {
	let stored: unknown = { version: 1, files: seed };
	const store = new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data;
		},
		now,
	});
	await store.load();
	return store;
}

function makeView(store: FoldStore, now: () => number, doc: string = TEXT_WITH_TUESDAY): EditorView {
	const watcher = createEditorWatcher({ store, window, now });
	const state = EditorState.create({
		doc,
		selection: { anchor: 0 }, // line 1 ("Notes"), never inside any anchor's fold range (G13)
		extensions: [codeFolding(), watcher, editorInfoField.init(() => ({ file: { path: NOTE_PATH, extension: "md" } }))],
	});
	return new EditorView({ state, parent: document.body });
}

function liveFoldedLineRanges(view: EditorView): { startLine: number; endLine: number }[] {
	const ranges: { startLine: number; endLine: number }[] = [];
	foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
		ranges.push({ startLine: view.state.doc.lineAt(from).number, endLine: view.state.doc.lineAt(to).number });
	});
	return ranges.sort((a, b) => a.startLine - b.startLine);
}

/** End offset of 1-indexed line `n` in `text` — the same "end of first line -> end of last
 * line" CM6 fold-range convention src/fold-restorer.ts's `foldEffectFor` uses. */
function lineEnd(text: string, n: number): number {
	const lines = text.split("\n");
	let offset = 0;
	for (let i = 0; i < n - 1; i++) offset += lines[i].length + 1;
	return offset + lines[n - 1].length;
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 300));
}

describe("dormant folds (G6)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("a fold with no confident match goes dormant (unfolded, no store loss); a later reload within 10 minutes refolds it, and it leaves the dormant list", async () => {
		const blocks = buildAnchors(TEXT_WITH_TUESDAY);
		const tuesday = findOneBlock(blocks, (a) => a.kind === "heading" && a.text === "tuesday").anchor;

		let clock = 0;
		const store = await makeStore(
			{
				[NOTE_PATH]: {
					contentHash: hashText(TEXT_WITH_TUESDAY),
					folds: [tuesday] as unknown as Record<string, unknown>[],
					dormant: [],
				},
			},
			() => clock,
		);

		const view = makeView(store, () => clock);

		// First reload: the heading changes beyond recognition -> no confident match (G2/G6).
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: TEXT_UNRELATED },
			annotations: Transaction.userEvent.of("set"),
		});
		await settle();

		expect(liveFoldedLineRanges(view)).toEqual([]); // G6: "the block stays unfolded meanwhile"
		const afterFirst = store.get(NOTE_PATH);
		expect(afterFirst?.folds).toEqual([]); // demoted out of the active list, not just ignored
		expect(afterFirst?.dormant).toHaveLength(1);
		expect(anchorKey(afterFirst!.dormant[0] as unknown as Anchor)).toBe(anchorKey(tuesday));
		expect((afterFirst!.dormant[0] as unknown as { dormantSince: number }).dormantSince).toBe(0);

		// A later reload, 5 minutes on (still within the 10-minute reprieve) — the heading text
		// returns, so the retry (G6) should find it and fold it straight back.
		clock = 5 * 60_000;
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: TEXT_WITH_TUESDAY_AGAIN },
			annotations: Transaction.userEvent.of("set"),
		});
		await settle();

		const afterSecondBlocks = buildAnchors(TEXT_WITH_TUESDAY_AGAIN);
		const tuesdayAgain = findOneBlock(afterSecondBlocks, (a) => a.kind === "heading" && a.text === "tuesdays");
		expect(anchorKey(tuesdayAgain.anchor)).not.toBe(anchorKey(tuesday)); // the premise of the E11 check below
		expect(liveFoldedLineRanges(view)).toContainEqual(tuesdayAgain.range);

		const afterSecond = store.get(NOTE_PATH);
		expect(afterSecond?.dormant).toEqual([]); // promoted out of dormant
		expect(afterSecond?.folds).toHaveLength(1); // exactly one entry — never duplicated (E11)
		expect(anchorKey(afterSecond!.folds[0] as unknown as Anchor)).toBe(anchorKey(tuesday));
		// R4 (PR-6): the promoted entry is a plain anchor, not the dormant one with its timestamp.
		expect(afterSecond!.folds[0]).not.toHaveProperty("dormantSince");
	});

	it("a dormant anchor 600,000ms old or older is forgotten and never refolds, even if later text would match it", async () => {
		const blocks = buildAnchors(TEXT_WITH_TUESDAY);
		const tuesday = findOneBlock(blocks, (a) => a.kind === "heading" && a.text === "tuesday").anchor;

		let clock = 0;
		const store = await makeStore(
			{
				[NOTE_PATH]: {
					contentHash: hashText(TEXT_WITH_TUESDAY),
					folds: [tuesday] as unknown as Record<string, unknown>[],
					dormant: [],
				},
			},
			() => clock,
		);

		const view = makeView(store, () => clock);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: TEXT_UNRELATED },
			annotations: Transaction.userEvent.of("set"),
		});
		await settle();
		expect(store.get(NOTE_PATH)?.dormant).toHaveLength(1);

		// A reload a full 10 minutes (600,000ms) later or more — forgotten outright (G6), even
		// though the text below would otherwise match with high confidence.
		clock = 600_000;
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: TEXT_WITH_TUESDAY_AGAIN },
			annotations: Transaction.userEvent.of("set"),
		});
		await settle();

		expect(liveFoldedLineRanges(view)).toEqual([]); // never refolded
		const after = store.get(NOTE_PATH);
		expect(after?.dormant).toEqual([]); // forgotten, not retried, not carried forward
		expect(after?.folds).toEqual([]);
	});

	it(
		"R1: an active anchor's exact match claims its candidate before a competing dormant " +
			"retry can — the block folds exactly once, only the active anchor is stored, and the " +
			"dormant anchor stays dormant rather than being promoted alongside it",
		async () => {
			const TEXT_ALPHA = "Notes\n\n- [ ] Draft proposal for client alpha\n  - [ ] Sub task\n";
			const TEXT_ALPHA_REWRITTEN =
				"Notes\n\nSomething else entirely, unrelated to the task below.\n\n" +
				"- [ ] Draft proposal for client alpha\n  - [ ] Sub task\n";
			const TEXT_BRAVO = "Notes\n\n- [ ] Draft proposal for client bravo\n  - [ ] Sub task\n";

			const alpha = findOneBlock(buildAnchors(TEXT_ALPHA), (a) => a.kind === "task" && a.text.includes("alpha")).anchor;
			const bravo = findOneBlock(buildAnchors(TEXT_BRAVO), (a) => a.kind === "task" && a.text.includes("bravo")).anchor;

			let clock = 0;
			const store = await makeStore(
				{
					[NOTE_PATH]: {
						contentHash: hashText(TEXT_ALPHA),
						folds: [alpha] as unknown as Record<string, unknown>[],
						dormant: [{ ...bravo, dormantSince: 0 }] as unknown as Record<string, unknown>[],
					},
				},
				() => clock,
			);

			// Neither block is folded live yet (the previous session's CM6 fold state is gone —
			// the usual reason a restore pass runs at all), so `alreadyFolded` starts empty and
			// both the active and dormant passes would, before R1's fix, independently decide to
			// fold the same block.
			const view = makeView(store, () => clock, TEXT_ALPHA);

			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: TEXT_ALPHA_REWRITTEN },
				annotations: Transaction.userEvent.of("set"),
			});
			await settle();

			const alphaAgain = findOneBlock(
				buildAnchors(TEXT_ALPHA_REWRITTEN),
				(a) => a.kind === "task" && a.text.includes("alpha"),
			);

			// Folded exactly once — never the duplicate [[from,to],[from,to]] the bug produced.
			expect(liveFoldedLineRanges(view)).toEqual([alphaAgain.range]);

			const after = store.get(NOTE_PATH);
			expect(after?.folds).toHaveLength(1); // one anchor per block (never-break rule 4)
			expect(anchorKey(after!.folds[0] as unknown as Anchor)).toBe(anchorKey(alpha));
			// T3/R6: the dormant "bravo" anchor's only confident candidate is the exact block the
			// active "alpha" anchor already claimed this round — G6's "one fold only, the dormant
			// entry is dropped" edge case. It is dropped outright, not kept dormant and not
			// promoted alongside alpha.
			expect(after?.dormant).toEqual([]);
		},
	);

	it(
		"T3/R6: a dormant anchor dropped because an active anchor already claimed its candidate " +
			"stays dropped — unfolding that block and reloading again never refolds or resurrects it",
		async () => {
			const TEXT_ALPHA = "Notes\n\n- [ ] Draft proposal for client alpha\n  - [ ] Sub task\n";
			const TEXT_ALPHA_REWRITTEN =
				"Notes\n\nSomething else entirely, unrelated to the task below.\n\n" +
				"- [ ] Draft proposal for client alpha\n  - [ ] Sub task\n";
			const TEXT_BRAVO = "Notes\n\n- [ ] Draft proposal for client bravo\n  - [ ] Sub task\n";

			const alpha = findOneBlock(buildAnchors(TEXT_ALPHA), (a) => a.kind === "task" && a.text.includes("alpha")).anchor;
			const bravo = findOneBlock(buildAnchors(TEXT_BRAVO), (a) => a.kind === "task" && a.text.includes("bravo")).anchor;

			let clock = 0;
			const store = await makeStore(
				{
					[NOTE_PATH]: {
						contentHash: hashText(TEXT_ALPHA),
						folds: [alpha] as unknown as Record<string, unknown>[],
						dormant: [{ ...bravo, dormantSince: 0 }] as unknown as Record<string, unknown>[],
					},
				},
				() => clock,
			);

			const view = makeView(store, () => clock, TEXT_ALPHA);

			// First reload: alpha (active) claims the block; bravo (dormant) loses it and, per
			// R6's fix, is dropped rather than kept dormant.
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: TEXT_ALPHA_REWRITTEN },
				annotations: Transaction.userEvent.of("set"),
			});
			await settle();

			const afterFirst = store.get(NOTE_PATH);
			expect(afterFirst?.folds).toHaveLength(1);
			expect(afterFirst?.dormant).toEqual([]); // dropped, not merely still-dormant

			// The user now unfolds that block by hand.
			const foldedNow = liveFoldedLineRanges(view);
			expect(foldedNow).toHaveLength(1);
			const alphaAgain = findOneBlock(
				buildAnchors(TEXT_ALPHA_REWRITTEN),
				(a) => a.kind === "task" && a.text.includes("alpha"),
			);
			const liveFrom = lineEnd(view.state.doc.toString(), alphaAgain.range.startLine);
			const liveTo = lineEnd(view.state.doc.toString(), alphaAgain.range.endLine);
			view.dispatch({ effects: [unfoldEffect.of({ from: liveFrom, to: liveTo })] });
			expect(store.get(NOTE_PATH)?.folds).toEqual([]);
			expect(store.get(NOTE_PATH)?.dormant).toEqual([]); // bravo was already gone, not revived

			// A later reload that keeps the same "alpha" text must not refold the block on
			// bravo's behalf — there is nothing left of bravo to match at all (R6's regression:
			// before this fix, bravo could still be sitting in `dormant` at this point and get
			// wrongly promoted here, refolding a block the user just unfolded).
			clock = 60_000;
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: TEXT_ALPHA_REWRITTEN },
				annotations: Transaction.userEvent.of("set"),
			});
			await settle();

			expect(liveFoldedLineRanges(view)).toEqual([]); // never-break rule 2: not refolded
			const afterSecond = store.get(NOTE_PATH);
			expect(afterSecond?.folds).toEqual([]);
			expect(afterSecond?.dormant).toEqual([]);
		},
	);

	it(
		"T13: a dormant anchor that matches on retry is promoted into folds (not dropped) even " +
			"when its target block is already folded live for a reason other than this pass's own " +
			"dispatch — e.g. something outside this plugin (real Obsidian's own native " +
			"per-session fold memory) re-applied the fold first",
		async () => {
			const TEXT_ALPHA = "Notes\n\n- [ ] Draft proposal for client alpha\n  - [ ] Sub task\n";
			const TEXT_UNRELATED_ALPHA = "Notes\n\nSomething else entirely, no task here at all.\n";

			const alpha = findOneBlock(buildAnchors(TEXT_ALPHA), (a) => a.kind === "task" && a.text.includes("alpha")).anchor;

			let clock = 0;
			const store = await makeStore(
				{
					[NOTE_PATH]: {
						contentHash: hashText(TEXT_UNRELATED_ALPHA),
						folds: [],
						dormant: [{ ...alpha, dormantSince: 0 }] as unknown as Record<string, unknown>[],
					},
				},
				() => clock,
			);

			const view = makeView(store, () => clock, TEXT_UNRELATED_ALPHA);

			// The reload that should retry "alpha" out of dormancy.
			clock = 60_000;
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: TEXT_ALPHA },
				annotations: Transaction.userEvent.of("set"),
			});

			// Immediately afterwards — before this plugin's own 150ms settle debounce has had a
			// chance to run its match and dispatch anything — something *other than the user's
			// own fold click* folds the exact same range live. In real Obsidian this is its own
			// native per-session fold memory re-applying the range as a side effect of the
			// reload; this harness has no equivalent of that mechanism (R9/T13's own reasoning
			// for why this is a real-Obsidian-only bug), so it is stood in for here with a
			// fold effect tagged `OWN_FOLD_ANNOTATION` — which `src/fold-recorder.ts` already
			// treats as "not the user's own action" and skips recording (E11) — reproducing the
			// exact observable precondition the live debug trace found: the range is already
			// folded live, but the store has no active anchor for it yet.
			const alphaAgain = findOneBlock(buildAnchors(TEXT_ALPHA), (a) => a.kind === "task" && a.text.includes("alpha"));
			const liveFrom = lineEnd(TEXT_ALPHA, alphaAgain.range.startLine);
			const liveTo = lineEnd(TEXT_ALPHA, alphaAgain.range.endLine);
			view.dispatch({ effects: [foldEffect.of({ from: liveFrom, to: liveTo })], annotations: OWN_FOLD_ANNOTATION.of(true) });

			await settle();

			// Still folded exactly once — not double-folded by this pass's own (idempotent,
			// skipped) plan.
			expect(liveFoldedLineRanges(view)).toEqual([alphaAgain.range]);

			const after = store.get(NOTE_PATH);
			// T13: promoted into the active list, not dropped — the dormant entry empties out,
			// but the plugin's own record of the fold does not disappear along with it.
			expect(after?.dormant).toEqual([]);
			expect(after?.folds).toHaveLength(1);
			expect(anchorKey(after!.folds[0] as unknown as Anchor)).toBe(anchorKey(alpha));
		},
	);
});
