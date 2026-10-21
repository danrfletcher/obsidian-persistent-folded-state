/**
 * GP1-GP3, run against the real CM6 pipeline (not a real Obsidian process — that's
 * tests/e2e/restore-external-edit.e2e.ts and scripts/e2e-restore-probe.mjs, container-only).
 * Uses the exact GP1/GP2/GP3 fixture pair (tests/fixtures/tasks-before.md,
 * tests/fixtures/tasks-after.md) the ticket plan describes: `## Tuesday` and `- [ ] Draft
 * proposal` folded, `- [ ] Send invoices` unfolded; an external rewrite inserts 4 lines above
 * `## Tuesday`, renames the task to "Draft proposal v2", ticks one sub-task, and appends a new
 * child under "Send invoices".
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { editorInfoField } from "../mocks/obsidian";
import { FoldStore, hashText } from "../../src/fold-store";
import { createEditorWatcher } from "../../src/editor-watcher";
import { buildAnchors, anchorKey, type Anchor, type AnchoredBlock } from "../../src/anchors";
import type { FileFoldRecord } from "../../src/types";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const BEFORE = readFileSync(join(FIXTURES, "tasks-before.md"), "utf8");
const AFTER = readFileSync(join(FIXTURES, "tasks-after.md"), "utf8");
const NOTE_PATH = "Projects/Quarry/Tasks.md";

function findOneBlock(blocks: AnchoredBlock[], predicate: (a: Anchor) => boolean): AnchoredBlock {
	const matches = blocks.filter((b) => predicate(b.anchor));
	expect(matches).toHaveLength(1);
	return matches[0];
}

async function makeStore(seed: Record<string, FileFoldRecord>): Promise<FoldStore> {
	let stored: unknown = { version: 1, files: seed };
	const store = new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data;
		},
	});
	await store.load();
	return store;
}

function makeView(store: FoldStore, doc: string = BEFORE): EditorView {
	const watcher = createEditorWatcher({ store, window });
	const state = EditorState.create({
		doc,
		selection: { anchor: 0 }, // line 1 ("---"), well before "## Tuesday" either way
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

describe("golden path GP1-GP3 (tasks-before.md -> tasks-after.md)", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it("GP1: the map holds exactly the Tuesday heading and Draft proposal task folds (not Send invoices)", () => {
		const blocks = buildAnchors(BEFORE);
		const tuesday = findOneBlock(blocks, (a) => a.kind === "heading" && a.text === "tuesday").anchor;
		const draftProposal = findOneBlock(blocks, (a) => a.kind === "task" && a.text === "draft proposal").anchor;
		const sendInvoices = blocks.filter((b) => b.anchor.kind === "task" && b.anchor.text === "send invoices");
		expect(sendInvoices).toHaveLength(1); // exists, but GP1 never folds it

		// Only two folds are stored — exactly what GP1 describes, nothing for Send invoices.
		const folds = [tuesday, draftProposal];
		expect(folds.map(anchorKey)).not.toContain(anchorKey(sendInvoices[0].anchor));
	});

	it("GP2 -> GP3: after the external rewrite, Tuesday and Draft proposal v2 are folded, Send invoices isn't, and the buffer matches the external write exactly", async () => {
		const blocks = buildAnchors(BEFORE);
		const tuesday = findOneBlock(blocks, (a) => a.kind === "heading" && a.text === "tuesday").anchor;
		const draftProposal = findOneBlock(blocks, (a) => a.kind === "task" && a.text === "draft proposal").anchor;

		const store = await makeStore({
			[NOTE_PATH]: {
				contentHash: hashText(BEFORE),
				folds: [tuesday, draftProposal] as unknown as Record<string, unknown>[],
				dormant: [],
			},
		});
		const view = makeView(store);

		// GP2: the external process rewrites the file on disk — simulated here as the same
		// whole-buffer replace Obsidian's own reload performs (docs/reload-shape.md).
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: AFTER },
			annotations: Transaction.userEvent.of("set"),
		});

		await settle();

		// F1: the buffer holds exactly what the external writer wrote — no marker, no comment,
		// no frontmatter change added by the plugin.
		expect(view.state.doc.toString()).toBe(AFTER);

		const afterBlocks = buildAnchors(AFTER);
		const tuesdayAfter = findOneBlock(afterBlocks, (a) => a.kind === "heading" && a.text === "tuesday");
		const draftProposalV2After = findOneBlock(afterBlocks, (a) => a.kind === "task" && a.text === "draft proposal v2");
		const sendInvoicesAfter = findOneBlock(afterBlocks, (a) => a.kind === "task" && a.text === "send invoices");

		const folded = liveFoldedLineRanges(view);
		// GP3: "## Tuesday" folded, "Draft proposal v2" folded (fuzzy match above 60%).
		expect(folded).toContainEqual(tuesdayAfter.range);
		expect(folded).toContainEqual(draftProposalV2After.range);
		// "Send invoices" is unfolded with its new child visible: it gets no fold of its own —
		// Tuesday's own fold (which, with no later same-or-shallower heading in this fixture,
		// spans to end of file) is a separate, coarser range that happens to contain it; no
		// *additional* fold was ever stored or dispatched for Send invoices itself.
		expect(folded).not.toContainEqual(sendInvoicesAfter.range);

		// The stored content hash is refreshed to the settled (GP2) text (PR-7's hook).
		expect(store.get(NOTE_PATH)?.contentHash).toBe(hashText(AFTER));
	});

	it("GP1 -> GP3 round trip: folds the user makes are recorded through the recorder (describeFold), and that stored state alone drives the restore after the external rewrite", async () => {
		const store = await makeStore({}); // nothing seeded by hand: the recorder must create every entry
		const view = makeView(store);

		// The user folds "## Tuesday" and "- [ ] Draft proposal" as a fold command or gutter click
		// would: end of the block's first line to end of its last content line, no annotation.
		const before = buildAnchors(BEFORE);
		const doc = view.state.doc;
		for (const wanted of [
			(a: Anchor) => a.kind === "task" && a.text === "draft proposal",
			(a: Anchor) => a.kind === "heading" && a.text === "tuesday",
		]) {
			const { range } = findOneBlock(before, wanted);
			view.dispatch({ effects: foldEffect.of({ from: doc.line(range.startLine).to, to: doc.line(range.endLine).to }) });
		}
		const recorded = (store.get(NOTE_PATH)?.folds ?? []).map((f) => (f as unknown as Anchor).text).sort();
		expect(recorded).toEqual(["draft proposal", "tuesday"]);

		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: AFTER },
			annotations: Transaction.userEvent.of("set"),
		});
		await settle();

		expect(view.state.doc.toString()).toBe(AFTER);
		const afterBlocks = buildAnchors(AFTER);
		const folded = liveFoldedLineRanges(view);
		expect(folded).toContainEqual(findOneBlock(afterBlocks, (a) => a.kind === "heading" && a.text === "tuesday").range);
		expect(folded).toContainEqual(findOneBlock(afterBlocks, (a) => a.kind === "task" && a.text === "draft proposal v2").range);
		expect(folded).not.toContainEqual(findOneBlock(afterBlocks, (a) => a.kind === "task" && a.text === "send invoices").range);
	});

	// R1 (PR-1 review round 1) — regression guards for the stale-entry handling of PR-5 R8
	// (resolveStaleEntryKey in the recorder, the restore-time re-key, restoreRefoldedEntries).

	/** Folds the block matching `wanted` in `text` the way a gutter click does. */
	function userFold(view: EditorView, text: string, wanted: (a: Anchor) => boolean): void {
		const { range } = findOneBlock(buildAnchors(text), wanted);
		const doc = view.state.doc;
		view.dispatch({ effects: foldEffect.of({ from: doc.line(range.startLine).to, to: doc.line(range.endLine).to }) });
	}

	/** Unfolds whichever live fold covers `range`'s first line, as the user's unfold click does. */
	function userUnfold(view: EditorView, range: { startLine: number }): void {
		const doc = view.state.doc;
		const lineEnd = doc.line(range.startLine).to;
		let target: { from: number; to: number } | null = null;
		foldedRanges(view.state).between(0, doc.length, (from, to) => {
			if (from === lineEnd) target = { from, to };
		});
		expect(target).not.toBeNull();
		view.dispatch({ effects: unfoldEffect.of(target as unknown as { from: number; to: number }) });
	}

	const isDraft = (a: Anchor): boolean => a.kind === "task" && a.text === "draft proposal";
	const isDraftV2 = (a: Anchor): boolean => a.kind === "task" && a.text === "draft proposal v2";

	function externalRewrite(view: EditorView, text: string): void {
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: text },
			annotations: Transaction.userEvent.of("set"),
		});
	}

	it("R1: fold Draft proposal -> external rewrite to v2 -> user unfold leaves zero stored folds, and a second external rewrite leaves it unfolded", async () => {
		const store = await makeStore({});
		const view = makeView(store);
		userFold(view, BEFORE, isDraft);
		expect((store.get(NOTE_PATH)?.folds ?? []).map((f) => (f as unknown as Anchor).text)).toEqual(["draft proposal"]);

		externalRewrite(view, AFTER);
		await settle();
		const v2Range = findOneBlock(buildAnchors(AFTER), isDraftV2).range;
		expect(liveFoldedLineRanges(view)).toContainEqual(v2Range); // restored by fuzzy match

		userUnfold(view, v2Range);
		expect(liveFoldedLineRanges(view)).not.toContainEqual(v2Range);
		expect(store.get(NOTE_PATH)?.folds ?? []).toHaveLength(0); // no stale "draft proposal" entry left

		// A second external rewrite (an unrelated line changes) must not fold it again.
		const secondRewrite = AFTER.replace("owner: dan", "owner: dan2");
		expect(secondRewrite).not.toBe(AFTER);
		externalRewrite(view, secondRewrite);
		await settle();
		expect(view.state.doc.toString()).toBe(secondRewrite);
		expect(liveFoldedLineRanges(view)).toHaveLength(0);
		expect(store.get(NOTE_PATH)?.folds ?? []).toHaveLength(0);
	});

	it("R1: the restore re-keys the stored entry to the block it matched, so the stored fold reads 'draft proposal v2'", async () => {
		const store = await makeStore({});
		const view = makeView(store);
		userFold(view, BEFORE, isDraft);

		externalRewrite(view, AFTER);
		await settle();

		const texts = (store.get(NOTE_PATH)?.folds ?? []).map((f) => (f as unknown as Anchor).text);
		expect(texts).toEqual(["draft proposal v2"]);
	});

	it("R1: re-folding a block whose stored entry is stale replaces that entry rather than adding a second", async () => {
		// The note already reads "Draft proposal v2" but the store still holds the entry recorded
		// under the old text, and no fold is live (e.g. the restore never matched it).
		const draftAnchor = findOneBlock(buildAnchors(BEFORE), isDraft).anchor;
		const store = await makeStore({
			[NOTE_PATH]: {
				contentHash: hashText(BEFORE),
				folds: [draftAnchor] as unknown as Record<string, unknown>[],
				dormant: [],
			},
		});
		const view = makeView(store, AFTER);
		expect(liveFoldedLineRanges(view)).toHaveLength(0);

		userFold(view, AFTER, isDraftV2);

		const folds = (store.get(NOTE_PATH)?.folds ?? []).map((f) => f as unknown as Anchor);
		expect(folds).toHaveLength(1);
		expect(folds[0].text).toBe("draft proposal v2");
	});
});
