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

// --- Embed section (ticket warkworth-21, PR-1) -------------------------------------------------

const GOOD_DORMANT = { ...GOOD_ANCHOR, text: "wednesday", dormantSince: 5_000 };

/** A valid embed record as it sits in data.json, written out literally. */
function goodEmbed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		host: "Host.md",
		target: "Source.md",
		subpath: "^abc123",
		occurrence: 0,
		contentHash: "e1",
		folds: [GOOD_ANCHOR],
		dormant: [GOOD_DORMANT],
		...overrides,
	};
}

/** Same, with one field removed (an absent key, not `undefined`). */
function embedWithout(field: string): Record<string, unknown> {
	const record = goodEmbed();
	delete record[field];
	return record;
}

const NOTE_FILES = { "Note.md": { contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [GOOD_DORMANT] } };

function withEmbeds(embeds: unknown): unknown {
	return { version: STORE_VERSION, files: NOTE_FILES, embeds };
}

describe("sanitizeStoreData: embeds section absent or not an array (E8)", () => {
	it("a files-only file loads unchanged and has no embeds key at all", () => {
		const result = sanitizeStoreData({ version: STORE_VERSION, files: NOTE_FILES });
		expect(result).toEqual({ version: 1, files: NOTE_FILES });
		expect("embeds" in result).toBe(false);
	});

	const notArrays: { label: string; value: unknown }[] = [
		{ label: "an object", value: { host: "Host.md" } },
		{ label: "a string", value: "embeds" },
		{ label: "a number", value: 7 },
		{ label: "null", value: null },
		{ label: "a boolean", value: true },
	];
	for (const { label, value } of notArrays) {
		it(`embeds as ${label}: notes load exactly as before and there are no embeds`, () => {
			const result = sanitizeStoreData(withEmbeds(value));
			expect(result).toEqual({ version: 1, files: NOTE_FILES });
			expect("embeds" in result).toBe(false);
		});
	}

	it("the same, through FoldStore.load(): notes' folds, contentHash and dormant unchanged, embed map empty", async () => {
		for (const value of [undefined, { a: 1 }, "x", 3, null]) {
			// `now` pinned just after GOOD_DORMANT's dormantSince so load()'s dormant expiry keeps it.
			const store = new FoldStore({ loadData: async () => withEmbeds(value), saveData: vi.fn(), now: () => 6_000 });
			await store.load();
			expect(store.get("Note.md")).toEqual(NOTE_FILES["Note.md"]);
			expect(store.embedSize).toBe(0);
		}
	});
});

describe("PR-8: the embed lifecycle on a file with no usable embeds section creates none (E8)", () => {
	const inputs: { label: string; data: unknown }[] = [
		{ label: "no embeds key", data: { version: STORE_VERSION, files: NOTE_FILES } },
		{ label: "embeds as an object", data: withEmbeds({ host: "Host.md" }) },
		{ label: "embeds as an array of bad records only", data: withEmbeds([null, 5, "x", { host: 3 }]) },
	];
	for (const { label, data } of inputs) {
		it(`${label}: rename, delete, prune and heading migration are no-ops that never reach saveData`, async () => {
			const saveData = vi.fn();
			const store = new FoldStore({ loadData: async () => structuredClone(data), saveData, now: () => 6_000 });
			await store.load();

			expect(store.handleEmbedRename("Host.md", "Renamed.md")).toBe(false);
			expect(store.handleEmbedDelete("Host.md")).toBe(false);
			expect(store.pruneOrphanEmbeds(() => false)).toBe(0);
			expect(store.migrateEmbedHeading({ source: "Host.md", target: "Note.md", from: "A", to: "B" })).toBe(0);
			await store.flush();

			expect(saveData).not.toHaveBeenCalled();
			expect(store.embedSize).toBe(0);
			expect(store.get("Note.md")).toEqual(NOTE_FILES["Note.md"]); // the notes' own section is untouched
		});
	}
});

describe("sanitizeStoreData: bad embed records are dropped, neighbours survive (E8)", () => {
	const bad: { label: string; record: unknown }[] = [
		{ label: "not an object (string)", record: "nope" },
		{ label: "not an object (number)", record: 5 },
		{ label: "not an object (null)", record: null },
		{ label: "not an object (array)", record: [] },
		{ label: "host missing", record: embedWithout("host") },
		{ label: "host empty", record: goodEmbed({ host: "" }) },
		{ label: "host not a string", record: goodEmbed({ host: 4 }) },
		{ label: "target missing", record: embedWithout("target") },
		{ label: "target empty", record: goodEmbed({ target: "" }) },
		{ label: "target not a string", record: goodEmbed({ target: null }) },
		{ label: "subpath not a string (number)", record: goodEmbed({ subpath: 3 }) },
		{ label: "subpath not a string (null)", record: goodEmbed({ subpath: null }) },
		{ label: "subpath not a string (array)", record: goodEmbed({ subpath: ["^abc"] }) },
		{ label: "subpath missing", record: embedWithout("subpath") },
		{ label: "occurrence negative", record: goodEmbed({ occurrence: -1 }) },
		{ label: "occurrence fractional", record: goodEmbed({ occurrence: 1.5 }) },
		{ label: "occurrence a numeric string", record: goodEmbed({ occurrence: "1" }) },
		{ label: "occurrence NaN", record: goodEmbed({ occurrence: Number.NaN }) },
		{ label: "occurrence Infinity", record: goodEmbed({ occurrence: Number.POSITIVE_INFINITY }) },
		{ label: "occurrence missing", record: embedWithout("occurrence") },
		{ label: "occurrence null", record: goodEmbed({ occurrence: null }) },
		{ label: "contentHash missing", record: embedWithout("contentHash") },
		{ label: "contentHash not a string", record: goodEmbed({ contentHash: 9 }) },
		{ label: "folds missing", record: embedWithout("folds") },
		{ label: "folds not an array (object)", record: goodEmbed({ folds: {} }) },
		{ label: "folds not an array (string)", record: goodEmbed({ folds: "x" }) },
		{ label: "dormantSince a string (PR-7 R5)", record: goodEmbed({ dormantSince: "soon" }) },
		{ label: "dormantSince negative", record: goodEmbed({ dormantSince: -1 }) },
		{ label: "dormantSince NaN", record: goodEmbed({ dormantSince: Number.NaN }) },
		{ label: "dormantSince Infinity", record: goodEmbed({ dormantSince: Number.POSITIVE_INFINITY }) },
		{ label: "dormantSince null", record: goodEmbed({ dormantSince: null }) },
	];

	it.each(bad)("$label: that record is dropped, the neighbours on both sides survive", ({ record }) => {
		const before = goodEmbed({ host: "Before.md" });
		const after = goodEmbed({ host: "After.md" });
		let result: ReturnType<typeof sanitizeStoreData> | undefined;
		expect(() => (result = sanitizeStoreData(withEmbeds([before, record, after])))).not.toThrow();
		expect(result?.embeds?.map((r) => r.host)).toEqual(["Before.md", "After.md"]);
		expect(result?.files).toEqual(NOTE_FILES); // notes untouched by a bad embed
	});

	it("an embeds array of only bad records yields no embeds key", () => {
		const result = sanitizeStoreData(withEmbeds(["x", 1, null, embedWithout("host")]));
		expect("embeds" in result).toBe(false);
	});

	it("a finite, non-negative dormantSince (0 included) is kept as written (PR-7 R5)", () => {
		for (const dormantSince of [0, 1_700_000_000_000]) {
			const record = goodEmbed({ dormantSince });
			expect(sanitizeStoreData(withEmbeds([record])).embeds).toEqual([record]);
		}
	});

	it("occurrence 0 is valid, and so is a subpath of '' (whole-note embed)", () => {
		const record = goodEmbed({ occurrence: 0, subpath: "" });
		expect(sanitizeStoreData(withEmbeds([record])).embeds).toEqual([record]);
	});
});

describe("sanitizeStoreData: inside a valid embed record (E8)", () => {
	it("a valid record round-trips field for field", () => {
		const record = goodEmbed();
		expect(sanitizeStoreData(withEmbeds([record])).embeds).toEqual([record]);
	});

	it("folds keeps only entries that pass parseAnchor: raw-text and half-formed anchors are dropped", () => {
		const record = goodEmbed({
			folds: [
				GOOD_ANCHOR,
				{ text: "## Tuesday", kind: "heading", indent: 0 }, // PR-2-era raw text, no siblingIndex/parentChain
				{ kind: "heading", indent: 0, text: "half", siblingIndex: 0 }, // no parentChain
				{ kind: "nonsense", indent: 0, text: "x", siblingIndex: 0, parentChain: [] },
				{ kind: "heading", indent: -1, text: "x", siblingIndex: 0, parentChain: [] },
				"string",
				7,
				null,
			],
		});
		expect(sanitizeStoreData(withEmbeds([record])).embeds?.[0].folds).toEqual([GOOD_ANCHOR]);
	});

	it("dormant keeps only entries that pass parseDormantAnchor", () => {
		const record = goodEmbed({
			dormant: [
				GOOD_DORMANT,
				GOOD_ANCHOR, // well-formed anchor but no dormantSince
				{ ...GOOD_ANCHOR, dormantSince: "5000" },
				{ ...GOOD_ANCHOR, dormantSince: -1 },
				{ ...GOOD_ANCHOR, dormantSince: Number.NaN },
				{ ...GOOD_ANCHOR, dormantSince: Number.POSITIVE_INFINITY },
				{ text: "raw", kind: "heading", indent: 0, dormantSince: 5000 },
				null,
			],
		});
		expect(sanitizeStoreData(withEmbeds([record])).embeds?.[0].dormant).toEqual([GOOD_DORMANT]);
	});

	it("dormant missing or not an array becomes [] without dropping the record", () => {
		for (const dormant of [undefined, "x", {}, 4, null]) {
			const record = goodEmbed({ dormant });
			expect(sanitizeStoreData(withEmbeds([record])).embeds?.[0].dormant).toEqual([]);
		}
	});

	it("unknown extra fields on a record are not carried through", () => {
		const record = goodEmbed({ extra: "x" });
		const out = sanitizeStoreData(withEmbeds([record])).embeds?.[0] as unknown as Record<string, unknown>;
		expect("extra" in out).toBe(false);
	});
});

describe("sanitizeStoreData: embed identity collapse (E8)", () => {
	it("two records with the same identity collapse to one, last wins, without throwing", () => {
		const first = goodEmbed({ contentHash: "first" });
		const second = goodEmbed({ contentHash: "second", folds: [] });
		let result: ReturnType<typeof sanitizeStoreData> | undefined;
		expect(() => (result = sanitizeStoreData(withEmbeds([first, second])))).not.toThrow();
		expect(result?.embeds).toEqual([second]);
	});

	it("identity is all four fields: a different occurrence, subpath, target or host is a different record", () => {
		const records = [
			goodEmbed(),
			goodEmbed({ occurrence: 1 }),
			goodEmbed({ subpath: "^other" }),
			goodEmbed({ target: "Other.md" }),
			goodEmbed({ host: "Other Host.md" }),
		];
		expect(sanitizeStoreData(withEmbeds(records)).embeds).toHaveLength(5);
	});

	it("paths that would collide under a composite key stay distinct", () => {
		const a = goodEmbed({ host: "x#y.md", target: "z.md", subpath: "" });
		const b = goodEmbed({ host: "x.md", target: "y#z.md", subpath: "" });
		expect(sanitizeStoreData(withEmbeds([a, b])).embeds).toEqual([a, b]);
	});

	it("through FoldStore.load(): duplicates collapse to one live record", async () => {
		const store = new FoldStore({
			loadData: async () => withEmbeds([goodEmbed({ contentHash: "first" }), goodEmbed({ contentHash: "second" })]),
			saveData: vi.fn(),
		});
		await store.load();
		expect(store.embedSize).toBe(1);
		expect(store.getEmbed({ host: "Host.md", target: "Source.md", subpath: "^abc123", occurrence: 0 })?.contentHash).toBe("second");
	});
});

describe("sanitizeStoreData: embeds never rescue an unreadable notes section", () => {
	it.each([
		{ label: "wrong version", raw: { version: 2, files: {}, embeds: [goodEmbed()] } },
		{ label: "files not an object", raw: { version: STORE_VERSION, files: "x", embeds: [goodEmbed()] } },
	])("$label: empty store, embeds included", ({ raw }) => {
		expect(sanitizeStoreData(raw)).toEqual({ version: 1, files: {} });
	});
});

describe("FoldStore.load: embeds with corrupt or missing files (E8)", () => {
	it("a rejecting or null loadData leaves both maps empty", async () => {
		for (const loadData of [async () => null, async (): Promise<unknown> => { throw new Error("boom"); }]) {
			const store = new FoldStore({ loadData, saveData: vi.fn() });
			await expect(store.load()).resolves.toBeUndefined();
			expect(store.size).toBe(0);
			expect(store.embedSize).toBe(0);
		}
	});

	it("load() replaces embeds from an earlier load rather than merging", async () => {
		let raw: unknown = withEmbeds([goodEmbed()]);
		const store = new FoldStore({ loadData: async () => raw, saveData: vi.fn() });
		await store.load();
		expect(store.embedSize).toBe(1);
		raw = null;
		await store.load();
		expect(store.embedSize).toBe(0);
	});
});

/** Warkworth-46 PR-4 (E14): the duplicate cleanup never throws out of `load()` / `onload`, however
 * broken the data it runs over. */
describe("FoldStore.load with duplicates: corrupt, absent or rejecting loadData() never throws (E14)", () => {
	const DUP = { ...GOOD_ANCHOR, dormantSince: Date.now() };
	const duplicated = { version: STORE_VERSION, files: { "Note.md": { contentHash: "abc", folds: [GOOD_ANCHOR], dormant: [DUP] } } };

	const loaders: { label: string; loadData: () => Promise<unknown> }[] = [
		{ label: "absent (null)", loadData: async () => null },
		{ label: "undefined", loadData: async () => undefined },
		{ label: "rejecting", loadData: async () => Promise.reject(new Error("disk read failed")) },
		{ label: "a string", loadData: async () => "{not json" },
		{ label: "an array", loadData: async () => [duplicated] },
		{ label: "wrong version", loadData: async () => ({ ...duplicated, version: 999 }) },
		{ label: "files is an array", loadData: async () => ({ version: STORE_VERSION, files: [DUP] }) },
		{ label: "folds is not an array, dormant has the anchor", loadData: async () => ({ version: STORE_VERSION, files: { "N.md": { contentHash: "a", folds: "x", dormant: [DUP] } } }) },
		{ label: "dormant is not an array", loadData: async () => ({ version: STORE_VERSION, files: { "N.md": { contentHash: "a", folds: [GOOD_ANCHOR], dormant: "x" } } }) },
		{ label: "folds and dormant full of junk beside a real duplicate", loadData: async () => ({ version: STORE_VERSION, files: { "N.md": { contentHash: "a", folds: [null, 1, "x", GOOD_ANCHOR], dormant: [null, [], DUP, { kind: 3 }] } } }) },
		{ label: "an embeds section with a duplicate and junk records", loadData: async () => ({ version: STORE_VERSION, files: {}, embeds: [null, 5, { host: "H.md", target: "T.md", subpath: "", occurrence: 0, contentHash: "h", folds: [GOOD_ANCHOR], dormant: [DUP, null] }] }) },
	];

	for (const { label, loadData } of loaders) {
		it(`${label}: load() resolves`, async () => {
			const store = new FoldStore({ loadData, saveData: vi.fn(async () => undefined) });
			await expect(store.load()).resolves.toBeUndefined();
		});
	}

	it("a duplicate with a rejecting saveData and a throwing diagnostic sink still completes the load", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const store = new FoldStore({
				loadData: async () => duplicated,
				saveData: async () => Promise.reject(new Error("disk full")),
				diagnosticLog: () => {
					throw new Error("log failed");
				},
			});
			await expect(store.load()).resolves.toBeUndefined();
			expect(store.get("Note.md")?.dormant).toEqual([]);
		} finally {
			consoleError.mockRestore();
		}
	});
});
