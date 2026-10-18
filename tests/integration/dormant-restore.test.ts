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
import { codeFolding, foldedRanges } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore, hashText } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import { buildAnchors, anchorKey, type Anchor, type AnchoredBlock } from "../../src/anchors";
import type { FileFoldRecord } from "../../src/types";

const NOTE_PATH = "Projects/Quarry/Tasks.md";

const TEXT_WITH_TUESDAY = "Notes\n\n## Tuesday\n- [ ] Draft proposal\n";
const TEXT_UNRELATED = "Notes\n\n## Zzz Qqq Www Completely Different Heading\n- [ ] Something else entirely\n";
const TEXT_WITH_TUESDAY_AGAIN = "Notes\n\n## Tuesday\n- [ ] Draft proposal v2\n";

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
		const tuesdayAgain = findOneBlock(afterSecondBlocks, (a) => a.kind === "heading" && a.text === "tuesday");
		expect(liveFoldedLineRanges(view)).toContainEqual(tuesdayAgain.range);

		const afterSecond = store.get(NOTE_PATH);
		expect(afterSecond?.dormant).toEqual([]); // promoted out of dormant
		expect(afterSecond?.folds).toHaveLength(1); // exactly one entry — never duplicated (E11)
		expect(anchorKey(afterSecond!.folds[0] as unknown as Anchor)).toBe(anchorKey(tuesday));
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
			// The dormant "bravo" anchor never claimed the candidate the active "alpha" anchor
			// already matched exactly — it stays dormant (with its original dormantSince),
			// rather than being wrongly promoted into `folds` alongside alpha.
			expect(after?.dormant).toHaveLength(1);
			expect(anchorKey(after!.dormant[0] as unknown as Anchor)).toBe(anchorKey(bravo));
			expect((after!.dormant[0] as unknown as { dormantSince: number }).dormantSince).toBe(0);
		},
	);
});
