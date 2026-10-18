/**
 * PR-5's own addition on top of PR-2's settle timer (already fully covered for plain timing by
 * tests/unit/settle-debounce.test.ts): once a burst settles, the restore pass it triggers must
 * still respect whatever happened to the fold store *during* the window it was timing — this is
 * the E3/E9 "a user fold or unfold during the window wins" rule, proven here directly against
 * `restoreSettledChange` (src/fold-restorer.ts) with fake timers and a real `SettleDebouncer`,
 * rather than against a full CM6 `EditorView` (that integration is covered by
 * tests/integration/restore-cm6.test.ts).
 *
 * "One restore per burst" and "a user-event transaction never arms it" are the `SettleDebouncer`
 * class's own job and are already proven by tests/unit/settle-debounce.test.ts and
 * tests/integration/fold-recorder.test.ts's E3 case; this file doesn't re-prove plain debounce
 * timing, only the cancellation-of-a-stale-entry behaviour PR-5 adds on top of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeFolding, foldedRanges } from "@codemirror/language";
import { SettleDebouncer } from "../../src/settle-debounce";
import { restoreSettledChange } from "../../src/fold-restorer";
import { FoldStore } from "../../src/fold-store";
import * as similarityModule from "../../src/similarity";

const PATH = "Tasks.md";
const TEXT = "## Tuesday\nbody line";
/** Tuesday's own fold range is lines 1-2; "## Done" gives the cursor somewhere to sit that is
 * *not* inside that range, so a default (start-of-doc) selection doesn't accidentally trigger
 * G13's cursor deferral and mask what these tests are actually about. */
const TEXT_WITH_TAIL = "## Tuesday\nbody line\n## Done";

function makeStore(): FoldStore {
	let stored: unknown = null;
	return new FoldStore({
		loadData: async () => stored,
		saveData: async (data) => {
			stored = data;
		},
	});
}

function makeView(doc: string = TEXT): EditorView {
	return new EditorView({
		state: EditorState.create({
			doc,
			// Parked at the very end of the document — outside Tuesday's own fold range for
			// every fixture in this file that cares about the cursor position at all.
			selection: { anchor: doc.length },
			extensions: [codeFolding()],
		}),
		parent: document.body,
	});
}

const HEADING_ANCHOR = { kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] };
/** Deliberately *not* an exact match for "tuesday" (the real candidate's normalized text), so
 * the match has to go through the positional/fuzzy tiers — which is what actually calls
 * `similarity()`/`yieldToHost` — rather than resolving in the exact tier, which never does. */
const REWORDED_HEADING_ANCHOR = { kind: "heading", indent: 0, text: "tuesday extra words", siblingIndex: 0, parentChain: [] };

describe("settle -> restore: one restore per burst, driven by a real SettleDebouncer", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		document.body.replaceChildren();
		vi.useRealTimers();
	});

	it("a burst of triggers produces exactly one restore call, 150ms after the last", async () => {
		const store = makeStore();
		store.set(PATH, { contentHash: "x", folds: [HEADING_ANCHOR], dormant: [] });
		const view = makeView();

		const runRestore = vi.fn((payload: { path: string; text: string }) =>
			restoreSettledChange(view, payload.path, payload.text, { store, getActivePath: () => PATH }),
		);
		const debouncer = new SettleDebouncer(runRestore, 150);

		debouncer.trigger({ path: PATH, text: TEXT });
		await vi.advanceTimersByTimeAsync(40);
		debouncer.trigger({ path: PATH, text: TEXT });
		await vi.advanceTimersByTimeAsync(40);

		expect(runRestore).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(150);
		expect(runRestore).toHaveBeenCalledTimes(1);
	});
});

describe("settle -> restore: a fold or unfold during the settle/match window wins (E3/E9)", () => {
	afterEach(() => {
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it("an anchor present when the snapshot was taken, but unfolded (removed from the store) before the match finishes, is not re-folded", async () => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.9);
		const store = makeStore();
		store.set(PATH, { contentHash: "x", folds: [REWORDED_HEADING_ANCHOR], dormant: [] });
		const view = makeView(TEXT_WITH_TAIL);

		// Simulates the user unfolding mid-match by having the match itself (via a slow
		// yieldToHost, forced to run at every comparison via chunkSize: 1) remove the stored
		// anchor before `restoreSettledChange` re-reads the store right before dispatch.
		let removedDuringMatch = false;
		const deferred = await restoreSettledChange(view, PATH, TEXT_WITH_TAIL, {
			store,
			getActivePath: () => PATH,
			matcherOptions: {
				chunkSize: 1,
				yieldToHost: () => {
					if (!removedDuringMatch) {
						removedDuringMatch = true;
						store.set(PATH, { contentHash: "x", folds: [], dormant: [] }); // the user's unfold
					}
				},
			},
		});

		expect(removedDuringMatch).toBe(true); // sanity: the mid-match hook actually ran
		expect(deferred).toEqual([]);
		let folded = 0;
		foldedRanges(view.state).between(0, view.state.doc.length, () => {
			folded++;
		});
		expect(folded).toBe(0);
	});

	it("the same scenario with nothing removed mid-match does fold (control case)", async () => {
		vi.spyOn(similarityModule, "similarity").mockReturnValue(0.9);
		const store = makeStore();
		store.set(PATH, { contentHash: "x", folds: [REWORDED_HEADING_ANCHOR], dormant: [] });
		const view = makeView(TEXT_WITH_TAIL);

		await restoreSettledChange(view, PATH, TEXT_WITH_TAIL, { store, getActivePath: () => PATH });

		let folded = 0;
		foldedRanges(view.state).between(0, view.state.doc.length, () => {
			folded++;
		});
		expect(folded).toBe(1);
	});
});
