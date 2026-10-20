/**
 * PR-6 (G6/E7/E8) — the store's handling of the `dormant` list: `sanitizeStoreData` validates
 * each entry's `dormantSince` (not just its `Anchor` shape), and `FoldStore` prunes expired
 * entries both at `load()` ("at plugin load") and at `flush()` ("when the store is flushed"),
 * driven by the injectable `now` option so this is tested with a fake clock, never a real wait.
 */
import { describe, expect, it, vi } from "vitest";
import { FoldStore, sanitizeStoreData, STORE_VERSION } from "../../src/fold-store";
import { MAX_DORMANT_AGE_MS } from "../../src/dormant";

const GOOD_ANCHOR = { kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] };
const GOOD_DORMANT = { ...GOOD_ANCHOR, dormantSince: 1000 };

describe("sanitizeStoreData: dormant entries (E8)", () => {
	it("a well-formed dormant entry round-trips, including dormantSince", () => {
		const raw = { version: STORE_VERSION, files: { "Note.md": { contentHash: "abc", folds: [], dormant: [GOOD_DORMANT] } } };
		const result = sanitizeStoreData(raw);
		expect(result.files["Note.md"].dormant).toEqual([GOOD_DORMANT]);
	});

	it("a dormant entry missing dormantSince is dropped, its neighbour kept", () => {
		const raw = {
			version: STORE_VERSION,
			files: { "Note.md": { contentHash: "abc", folds: [], dormant: [GOOD_ANCHOR, GOOD_DORMANT] } },
		};
		const result = sanitizeStoreData(raw);
		expect(result.files["Note.md"].dormant).toEqual([GOOD_DORMANT]);
	});

	it("a dormant entry with a non-numeric dormantSince is dropped, never throws", () => {
		const raw = {
			version: STORE_VERSION,
			files: { "Note.md": { contentHash: "abc", folds: [], dormant: [{ ...GOOD_ANCHOR, dormantSince: "soon" }] } },
		};
		expect(() => sanitizeStoreData(raw)).not.toThrow();
		expect(sanitizeStoreData(raw).files["Note.md"].dormant).toEqual([]);
	});

	it("a dormant entry with a negative dormantSince is dropped", () => {
		const raw = {
			version: STORE_VERSION,
			files: { "Note.md": { contentHash: "abc", folds: [], dormant: [{ ...GOOD_ANCHOR, dormantSince: -5 }] } },
		};
		expect(sanitizeStoreData(raw).files["Note.md"].dormant).toEqual([]);
	});

	it("an otherwise-valid anchor without dormantSince in `folds` is unaffected by the dormant rules", () => {
		const raw = { version: STORE_VERSION, files: { "Note.md": { contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [] } } };
		expect(sanitizeStoreData(raw).files["Note.md"].folds).toEqual([GOOD_ANCHOR]);
	});
});

describe("FoldStore.load: expired dormant entries are pruned (G6/E7)", () => {
	it("a dormant entry younger than MAX_DORMANT_AGE_MS survives a load", async () => {
		const raw = { version: STORE_VERSION, files: { "Note.md": { contentHash: "abc", folds: [], dormant: [GOOD_DORMANT] } } };
		const store = new FoldStore({ loadData: async () => raw, saveData: vi.fn(), now: () => GOOD_DORMANT.dormantSince + MAX_DORMANT_AGE_MS - 1 });
		await store.load();
		expect(store.get("Note.md")?.dormant).toEqual([GOOD_DORMANT]);
	});

	it("a dormant entry exactly MAX_DORMANT_AGE_MS old (or older) is forgotten at load — a long gap expires it (E7)", async () => {
		const raw = { version: STORE_VERSION, files: { "Note.md": { contentHash: "abc", folds: [], dormant: [GOOD_DORMANT] } } };
		const store = new FoldStore({ loadData: async () => raw, saveData: vi.fn(), now: () => GOOD_DORMANT.dormantSince + MAX_DORMANT_AGE_MS });
		await store.load();
		expect(store.get("Note.md")?.dormant).toEqual([]);
	});

	it("defaults to Date.now() when `now` isn't supplied (no crash, no throw)", async () => {
		const raw = { version: STORE_VERSION, files: { "Note.md": { contentHash: "abc", folds: [], dormant: [GOOD_DORMANT] } } };
		const store = new FoldStore({ loadData: async () => raw, saveData: vi.fn() });
		await expect(store.load()).resolves.toBeUndefined();
		// GOOD_DORMANT.dormantSince (1000ms since epoch) is far more than MAX_DORMANT_AGE_MS in
		// the past relative to the real clock, so it's expected to already be expired.
		expect(store.get("Note.md")?.dormant).toEqual([]);
	});
});

describe("FoldStore.flush: expired dormant entries are pruned (G6: 'or when the store is flushed')", () => {
	it("an entry that ages past the threshold between two flushes is gone from the second snapshot", async () => {
		let clock = 0;
		const saveData = vi.fn(async (_data: unknown) => undefined);
		const store = new FoldStore({ loadData: async () => null, saveData, now: () => clock });
		await store.load();

		store.set("Note.md", { contentHash: "abc", folds: [], dormant: [GOOD_DORMANT] });
		await store.flush();
		expect(saveData).toHaveBeenNthCalledWith(1, expect.objectContaining({ files: { "Note.md": { contentHash: "abc", folds: [], dormant: [GOOD_DORMANT] } } }));

		clock = GOOD_DORMANT.dormantSince + MAX_DORMANT_AGE_MS; // now stale
		store.set("Note.md", { contentHash: "abc", folds: [], dormant: [GOOD_DORMANT] }); // mark dirty again
		await store.flush();

		const last = saveData.mock.calls.at(-1)?.[0] as { files: Record<string, { dormant: unknown[] }> };
		expect(last.files["Note.md"].dormant).toEqual([]);
		expect(store.get("Note.md")?.dormant).toEqual([]); // the in-memory map itself was pruned too
	});
});
