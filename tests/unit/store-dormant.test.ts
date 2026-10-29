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

/**
 * Warkworth-46 PR-4 (E14): `load()` removes an anchor from `dormant` when it is also in `folds`,
 * and writes the cleaned data back at once (one `saveData`, no debounce wait). Fake
 * `loadData`/`saveData` and an injected clock throughout; the real FoldStore.
 */
describe("FoldStore.load: an anchor in both folds and dormant is cleaned (E14)", () => {
	const OTHER_ANCHOR = { kind: "heading", indent: 0, text: "wednesday", siblingIndex: 1, parentChain: [] };
	const NOW = 5_000_000;

	function open(files: Record<string, unknown>, now = NOW) {
		const saveData = vi.fn(async (_data: unknown) => undefined);
		const store = new FoldStore({ loadData: async () => ({ version: STORE_VERSION, files }), saveData, now: () => now });
		return { store, saveData };
	}

	it("keeps the anchor in folds, drops the dormant copy, and writes once at once (no timer advanced)", async () => {
		const { store, saveData } = open({
			"Note.md": { contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [{ ...GOOD_ANCHOR, dormantSince: NOW - 10 }] },
		});
		await store.load();

		expect(store.get("Note.md")).toEqual({ contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [] });
		expect(saveData).toHaveBeenCalledTimes(1);
		expect(saveData).toHaveBeenCalledWith({
			version: STORE_VERSION,
			files: { "Note.md": { contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [] } },
		});
	});

	it("clean data (no overlap anywhere) causes no write, now or after the debounce window", async () => {
		vi.useFakeTimers();
		try {
			const { store, saveData } = open({
				"Note.md": { contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [{ ...OTHER_ANCHOR, dormantSince: NOW - 10 }] },
			});
			await store.load();
			await vi.advanceTimersByTimeAsync(1000);
			expect(saveData).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("a duplicate whose dormant copy is already past 10 minutes: still kept in folds, and still written back", async () => {
		const { store, saveData } = open({
			"Note.md": { contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [{ ...GOOD_ANCHOR, dormantSince: NOW - MAX_DORMANT_AGE_MS - 1 }] },
		});
		await store.load();
		expect(store.get("Note.md")).toEqual({ contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [] });
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("partial overlap: only the duplicated key leaves dormant; the others keep their own dormantSince and order", async () => {
		const third = { kind: "heading", indent: 0, text: "thursday", siblingIndex: 2, parentChain: [] };
		const { store } = open({
			"Note.md": {
				contentHash: "abc",
				folds: [GOOD_ANCHOR],
				dormant: [
					{ ...third, dormantSince: NOW - 300 },
					{ ...GOOD_ANCHOR, dormantSince: NOW - 200 },
					{ ...OTHER_ANCHOR, dormantSince: NOW - 100 },
				],
			},
		});
		await store.load();
		expect(store.get("Note.md")?.dormant).toEqual([
			{ kind: "heading", indent: 0, text: "thursday", siblingIndex: 2, parentChain: [], dormantSince: NOW - 300 },
			{ kind: "heading", indent: 0, text: "wednesday", siblingIndex: 1, parentChain: [], dormantSince: NOW - 100 },
		]);
	});

	it("G6 expiry still runs after the cleanup: an unrelated dormant entry past the window goes, a fresh one stays", async () => {
		const { store, saveData } = open({
			"Note.md": {
				contentHash: "abc",
				folds: [GOOD_ANCHOR],
				dormant: [
					{ ...GOOD_ANCHOR, dormantSince: NOW - 5 },
					{ ...OTHER_ANCHOR, dormantSince: NOW - MAX_DORMANT_AGE_MS },
					{ kind: "heading", indent: 0, text: "friday", siblingIndex: 3, parentChain: [], dormantSince: NOW - MAX_DORMANT_AGE_MS + 1 },
				],
			},
		});
		await store.load();
		expect(store.get("Note.md")?.folds).toEqual([GOOD_ANCHOR]);
		expect(store.get("Note.md")?.dormant).toEqual([
			{ kind: "heading", indent: 0, text: "friday", siblingIndex: 3, parentChain: [], dormantSince: NOW - MAX_DORMANT_AGE_MS + 1 },
		]);
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("real-vault shape: 136 anchors in both lists load as 136 folds and 0 dormant, contentHash unchanged", async () => {
		const anchors = Array.from({ length: 136 }, (_, i) => ({ kind: "task", indent: 0, text: `lesson ${i}`, siblingIndex: i, parentChain: [] }));
		const { store, saveData } = open({
			"Agentic.md": { contentHash: "a4ac843e9e1f1f96", folds: anchors, dormant: anchors.map((a) => ({ ...a, dormantSince: 1000 })) },
		});
		await store.load();
		const record = store.get("Agentic.md");
		expect(record?.folds).toHaveLength(136);
		expect(record?.dormant).toHaveLength(0);
		expect(record?.contentHash).toBe("a4ac843e9e1f1f96");
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("several cleaned notes still cost one write; an untouched neighbour is unchanged", async () => {
		const { store, saveData } = open({
			"A.md": { contentHash: "a", folds: [GOOD_ANCHOR], dormant: [{ ...GOOD_ANCHOR, dormantSince: NOW }] },
			"B.md": { contentHash: "b", folds: [GOOD_ANCHOR], dormant: [{ ...GOOD_ANCHOR, dormantSince: NOW }] },
			"C.md": { contentHash: "c", folds: [], dormant: [{ ...OTHER_ANCHOR, dormantSince: NOW }] },
		});
		await store.load();
		expect(saveData).toHaveBeenCalledTimes(1);
		expect(store.get("C.md")).toEqual({ contentHash: "c", folds: [], dormant: [{ ...OTHER_ANCHOR, dormantSince: NOW }] });
	});

	it("a malformed dormant entry is dropped by the sanitiser first and is no duplicate; no write for it", async () => {
		const { store, saveData } = open({
			"Note.md": { contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [{ ...GOOD_ANCHOR }, null, "x"] }, // no dormantSince
		});
		await store.load();
		expect(store.get("Note.md")).toEqual({ contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [] });
		expect(saveData).not.toHaveBeenCalled();
	});

	it("a failing write-back never throws out of load(), and the store stays dirty so a later flush retries", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const saveData = vi.fn<(data: unknown) => Promise<void>>(async () => {
				throw new Error("disk full");
			});
			const store = new FoldStore({
				loadData: async () => ({ version: STORE_VERSION, files: { "Note.md": { contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [{ ...GOOD_ANCHOR, dormantSince: NOW }] } } }),
				saveData,
				now: () => NOW,
			});
			await expect(store.load()).resolves.toBeUndefined();
			expect(store.get("Note.md")?.dormant).toEqual([]);
			saveData.mockImplementation(async () => undefined);
			await store.flush();
			expect(saveData).toHaveBeenCalledTimes(2);
		} finally {
			consoleError.mockRestore();
		}
	});
});
