import { describe, expect, it, vi } from "vitest";
import { FoldStore, sanitizeStoreData, STORE_VERSION } from "../../src/fold-store";

/** PR-5: every entry inside `folds`/`dormant` is now validated against `src/anchors.ts`'s real
 * `Anchor` shape (`parseAnchor`), not just "is it a plain object" — so a fixture standing in for
 * "a fold that should survive sanitisation" needs to actually be a valid `Anchor`, not a bare
 * `{kind: "heading"}`. */
const GOOD_ANCHOR = { kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] };

/** E8: every row must yield an empty or sanitised store from `sanitizeStoreData`, with no
 * exception, regardless of how corrupt or unexpected the input is. */
const rows: { label: string; raw: unknown; expectEmpty: boolean }[] = [
	{ label: "top-level null", raw: null, expectEmpty: true },
	{ label: "top-level array", raw: [], expectEmpty: true },
	{ label: "top-level string", raw: "not an object", expectEmpty: true },
	{ label: "top-level number", raw: 42, expectEmpty: true },
	{ label: "wrong version", raw: { version: 999, files: {} }, expectEmpty: true },
	{ label: "files not an object (string)", raw: { version: STORE_VERSION, files: "nope" }, expectEmpty: true },
	{ label: "files not an object (array)", raw: { version: STORE_VERSION, files: [] }, expectEmpty: true },
];

describe("sanitizeStoreData: E8 table", () => {
	for (const { label, raw, expectEmpty } of rows) {
		it(`${label} -> ${expectEmpty ? "empty store" : "sanitised store"}, never throws`, () => {
			let result: ReturnType<typeof sanitizeStoreData> | undefined;
			expect(() => (result = sanitizeStoreData(raw))).not.toThrow();
			expect(result).toEqual({ version: STORE_VERSION, files: {} });
		});
	}

	it("a record missing contentHash is dropped without losing valid neighbours", () => {
		const raw = {
			version: STORE_VERSION,
			files: {
				"Bad.md": { folds: [], dormant: [] }, // no contentHash
				"Good.md": { contentHash: "abc", folds: [], dormant: [] },
			},
		};
		const result = sanitizeStoreData(raw);
		expect(Object.keys(result.files)).toEqual(["Good.md"]);
		expect(result.files["Good.md"]).toEqual({ contentHash: "abc", folds: [], dormant: [] });
	});

	it("a record whose folds is not an array is dropped without losing valid neighbours", () => {
		const raw = {
			version: STORE_VERSION,
			files: {
				"Bad.md": { contentHash: "abc", folds: "not an array", dormant: [] },
				"Good.md": { contentHash: "def", folds: [GOOD_ANCHOR], dormant: [] },
			},
		};
		const result = sanitizeStoreData(raw);
		expect(Object.keys(result.files)).toEqual(["Good.md"]);
		expect(result.files["Good.md"].folds).toEqual([GOOD_ANCHOR]);
	});

	it("a non-array dormant is sanitised to an empty array rather than dropping the record", () => {
		const raw = {
			version: STORE_VERSION,
			files: { "Note.md": { contentHash: "abc", folds: [], dormant: "nope" } },
		};
		const result = sanitizeStoreData(raw);
		expect(result.files["Note.md"]).toEqual({ contentHash: "abc", folds: [], dormant: [] });
	});

	it("non-object entries inside folds/dormant arrays are filtered out", () => {
		const raw = {
			version: STORE_VERSION,
			files: { "Note.md": { contentHash: "abc", folds: [GOOD_ANCHOR, "nope", 5, null], dormant: [] } },
		};
		const result = sanitizeStoreData(raw);
		expect(result.files["Note.md"].folds).toEqual([GOOD_ANCHOR]);
	});

	it("PR-5: a PR-2-era raw FoldDescriptor ({text, kind, indent}, no siblingIndex/parentChain) is discarded, not treated as a valid anchor", () => {
		const raw = {
			version: STORE_VERSION,
			files: {
				"Note.md": {
					contentHash: "abc",
					folds: [{ text: "## Tuesday", kind: "heading", indent: 0 }],
					dormant: [],
				},
			},
		};
		const result = sanitizeStoreData(raw);
		expect(result.files["Note.md"].folds).toEqual([]);
	});

	it("PR-5: a valid Anchor alongside a PR-2-era raw record keeps the valid one and drops only the stale one", () => {
		const raw = {
			version: STORE_VERSION,
			files: {
				"Note.md": {
					contentHash: "abc",
					folds: [GOOD_ANCHOR, { text: "- [ ] Old style", kind: "task", indent: 0 }],
					dormant: [],
				},
			},
		};
		const result = sanitizeStoreData(raw);
		expect(result.files["Note.md"].folds).toEqual([GOOD_ANCHOR]);
	});
});

describe("FoldStore.load: file absent, corrupt or rejecting loadData() (E8)", () => {
	it("file absent (loadData resolves null, the Obsidian convention) starts empty, no throw", async () => {
		const store = new FoldStore({ loadData: async () => null, saveData: vi.fn() });
		await expect(store.load()).resolves.toBeUndefined();
		expect(store.size).toBe(0);
	});

	it("zero bytes / truncated / non-JSON on disk (loadData rejects) starts empty, no throw", async () => {
		const store = new FoldStore({
			loadData: async () => {
				throw new SyntaxError("Unexpected end of JSON input");
			},
			saveData: vi.fn(),
		});
		await expect(store.load()).resolves.toBeUndefined();
		expect(store.size).toBe(0);
	});

	it("a rejecting loadData() (any reason) starts empty, no throw", async () => {
		const store = new FoldStore({
			loadData: async () => {
				throw new Error("disk read failed");
			},
			saveData: vi.fn(),
		});
		await expect(store.load()).resolves.toBeUndefined();
		expect(store.size).toBe(0);
	});

	it("one bad entry is dropped without losing valid neighbours end-to-end", async () => {
		const raw = {
			version: STORE_VERSION,
			files: {
				"Bad.md": { contentHash: 42, folds: [], dormant: [] }, // contentHash wrong type
				"Good.md": { contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [] },
			},
		};
		const store = new FoldStore({ loadData: async () => raw, saveData: vi.fn() });
		await store.load();
		expect(store.get("Bad.md")).toBeUndefined();
		expect(store.get("Good.md")).toEqual({ contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [] });
	});

	it("the next flush after a corrupt load writes a valid file", async () => {
		const saveData = vi.fn(async () => undefined);
		const store = new FoldStore({ loadData: async () => "{not json", saveData });
		await store.load();
		expect(store.size).toBe(0);

		store.set("Note.md", { contentHash: "abc", folds: [], dormant: [] });
		await store.flush();

		expect(saveData).toHaveBeenCalledTimes(1);
		expect(saveData).toHaveBeenCalledWith({ version: STORE_VERSION, files: { "Note.md": { contentHash: "abc", folds: [], dormant: [] } } });
	});
});
