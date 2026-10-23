/**
 * Nested embeds in the store (PR-4, G12): an embed inside an embedded block is identified by the
 * chain of embeds that contain it (`outer`, outermost first) as well as by host, target, subpath
 * and occurrence. A flat embed's record is byte-for-byte what it was before `outer` existed, and
 * a record with a malformed `outer` is dropped on load, never read as flat.
 */
import { describe, expect, it, vi } from "vitest";
import { FoldStore, STORE_VERSION } from "../../src/fold-store";
import type { EmbedFoldRecord, EmbedIdentity } from "../../src/types";

const FLAT: EmbedIdentity = { host: "Host.md", target: "Lessons.md", subpath: "", occurrence: 0 };
const OUTER_A = { target: "Outer.md", subpath: "^o1", occurrence: 0 };
const OUTER_B = { target: "Other.md", subpath: "", occurrence: 1 };
const FOLD = { kind: "task", indent: 0, text: "lesson 2: maps", siblingIndex: 1, parentChain: [] };

function record(id: EmbedIdentity, hash = "h"): EmbedFoldRecord {
	return { ...id, contentHash: hash, folds: [FOLD], dormant: [] };
}

function storeWith(embeds: unknown[]) {
	const saveData = vi.fn(async (_data: unknown) => undefined);
	const store = new FoldStore({ loadData: async () => structuredClone({ version: STORE_VERSION, files: {}, embeds }), saveData });
	return { store, saveData };
}

async function emptyStore() {
	const saveData = vi.fn(async (_data: unknown) => undefined);
	const store = new FoldStore({ loadData: async () => null, saveData });
	await store.load();
	return { store, saveData };
}

describe("nested embeds: identity includes the chain of containing embeds", () => {
	it("a nested embed and the flat embed of the same content in the same host are two records", async () => {
		const { store } = await emptyStore();
		store.setEmbed(record(FLAT, "flat"));
		store.setEmbed(record({ ...FLAT, outer: [OUTER_A] }, "nested"));

		expect(store.embedSize).toBe(2);
		expect(store.getEmbed(FLAT)?.contentHash).toBe("flat");
		expect(store.getEmbed({ ...FLAT, outer: [OUTER_A] })?.contentHash).toBe("nested");
	});

	it("different chains, and chains of different depth, are different records", async () => {
		const { store } = await emptyStore();
		store.setEmbed(record({ ...FLAT, outer: [OUTER_A] }, "a"));
		store.setEmbed(record({ ...FLAT, outer: [OUTER_B] }, "b"));
		store.setEmbed(record({ ...FLAT, outer: [OUTER_A, OUTER_B] }, "ab"));
		store.setEmbed(record({ ...FLAT, outer: [OUTER_B, OUTER_A] }, "ba"));

		expect(store.embedSize).toBe(4);
		expect(store.getEmbed({ ...FLAT, outer: [OUTER_A] })?.contentHash).toBe("a");
		expect(store.getEmbed({ ...FLAT, outer: [OUTER_B] })?.contentHash).toBe("b");
		expect(store.getEmbed({ ...FLAT, outer: [OUTER_A, OUTER_B] })?.contentHash).toBe("ab");
		expect(store.getEmbed({ ...FLAT, outer: [OUTER_B, OUTER_A] })?.contentHash).toBe("ba");
	});

	it("the chain's occurrence counts: the same outer embed at another index is another record", async () => {
		const { store } = await emptyStore();
		store.setEmbed(record({ ...FLAT, outer: [{ ...OUTER_A, occurrence: 0 }] }, "first"));
		store.setEmbed(record({ ...FLAT, outer: [{ ...OUTER_A, occurrence: 1 }] }, "second"));

		expect(store.embedSize).toBe(2);
		expect(store.getEmbed({ ...FLAT, outer: [{ ...OUTER_A, occurrence: 1 }] })?.contentHash).toBe("second");
	});

	it("an empty `outer` is the flat embed", async () => {
		const { store } = await emptyStore();
		store.setEmbed(record(FLAT, "flat"));
		expect(store.getEmbed({ ...FLAT, outer: [] })?.contentHash).toBe("flat");
	});

	it("paths holding the separator characters cannot make two chains collide", async () => {
		const { store } = await emptyStore();
		store.setEmbed(record({ ...FLAT, outer: [{ target: "a", subpath: "b", occurrence: 0 }, { target: "c", subpath: "", occurrence: 0 }] }, "one"));
		store.setEmbed(record({ ...FLAT, outer: [{ target: "a", subpath: "b\",[\"c", occurrence: 0 }] }, "two"));
		expect(store.embedSize).toBe(2);
	});

	it("forgetEmbed removes only the nested record it names", async () => {
		const { store } = await emptyStore();
		store.setEmbed(record(FLAT, "flat"));
		store.setEmbed(record({ ...FLAT, outer: [OUTER_A] }, "nested"));

		expect(store.forgetEmbed({ ...FLAT, outer: [OUTER_A] })).toBe(true);
		expect(store.getEmbed(FLAT)?.contentHash).toBe("flat");
		expect(store.embedSize).toBe(1);
	});

	it("forgetting the host removes its nested embed records too", async () => {
		const { store } = await emptyStore();
		store.setEmbed(record({ ...FLAT, outer: [OUTER_A] }));
		store.setEmbed(record({ ...FLAT, host: "Elsewhere.md", outer: [OUTER_A] }));

		expect(store.forgetEmbedsForHost("Host.md")).toBe(1);
		expect(store.embedRecords().map((r) => r.host)).toEqual(["Elsewhere.md"]);
	});
});

describe("nested embeds: what is written and read back", () => {
	it("a flat embed is written byte-for-byte as before: no `outer` field at all, not even an empty one", async () => {
		const { store, saveData } = await emptyStore();
		store.setEmbed(record(FLAT));
		await store.flush();

		const written = saveData.mock.calls[0][0] as { embeds: unknown[] };
		expect(JSON.stringify(written.embeds)).toBe(
			'[{"host":"Host.md","target":"Lessons.md","subpath":"","occurrence":0,"contentHash":"h","folds":[{"kind":"task","indent":0,"text":"lesson 2: maps","siblingIndex":1,"parentChain":[]}],"dormant":[]}]'
		);
	});

	it("a flat record with an explicit empty `outer` is written without it", async () => {
		const { store, saveData } = await emptyStore();
		store.setEmbed(record({ ...FLAT, outer: [] }));
		await store.flush();

		const written = saveData.mock.calls[0][0] as { embeds: Record<string, unknown>[] };
		expect(Object.keys(written.embeds[0])).not.toContain("outer");
	});

	it("a nested record is written with its chain and round-trips through load", async () => {
		const first = await emptyStore();
		first.store.setEmbed(record({ ...FLAT, outer: [OUTER_A, OUTER_B] }, "n"));
		await first.store.flush();
		const written = first.saveData.mock.calls[0][0];
		expect((written as { embeds: Record<string, unknown>[] }).embeds[0].outer).toEqual([OUTER_A, OUTER_B]);

		const second = new FoldStore({ loadData: async () => structuredClone(written), saveData: vi.fn(async () => undefined) });
		await second.load();
		expect(second.getEmbed({ ...FLAT, outer: [OUTER_A, OUTER_B] })?.contentHash).toBe("n");
		expect(second.getEmbed(FLAT)).toBeUndefined();
	});

	it("a stored flat record (no `outer`) loads as flat", async () => {
		const { store } = storeWith([{ ...FLAT, contentHash: "h", folds: [FOLD], dormant: [] }]);
		await store.load();
		expect(store.getEmbed(FLAT)?.contentHash).toBe("h");
		expect(store.embedRecords()[0]).not.toHaveProperty("outer");
	});

	it("a stored record with an empty `outer` loads as flat, and its outer is not kept", async () => {
		const { store } = storeWith([{ ...FLAT, outer: [], contentHash: "h", folds: [], dormant: [] }]);
		await store.load();
		expect(store.getEmbed(FLAT)?.contentHash).toBe("h");
		expect(store.embedRecords()[0]).not.toHaveProperty("outer");
	});
});

describe("nested embeds: a malformed `outer` drops the record, it is never read as flat", () => {
	const base = { ...FLAT, contentHash: "h", folds: [], dormant: [] };
	const BAD: [string, unknown][] = [
		["a string", "Outer.md"],
		["an object", { target: "Outer.md", subpath: "", occurrence: 0 }],
		["a number", 3],
		["null", null],
		["an entry that is a string", ["Outer.md"]],
		["an entry that is null", [null]],
		["an entry that is an array", [["Outer.md", "", 0]]],
		["an entry with no target", [{ subpath: "", occurrence: 0 }]],
		["an entry with an empty target", [{ target: "", subpath: "", occurrence: 0 }]],
		["an entry with a non-string target", [{ target: 4, subpath: "", occurrence: 0 }]],
		["an entry with no subpath", [{ target: "Outer.md", occurrence: 0 }]],
		["an entry with a non-string subpath", [{ target: "Outer.md", subpath: 1, occurrence: 0 }]],
		["an entry with no occurrence", [{ target: "Outer.md", subpath: "" }]],
		["an entry with a negative occurrence", [{ target: "Outer.md", subpath: "", occurrence: -1 }]],
		["an entry with a fractional occurrence", [{ target: "Outer.md", subpath: "", occurrence: 0.5 }]],
		["an entry with a string occurrence", [{ target: "Outer.md", subpath: "", occurrence: "0" }]],
		["one good entry and one bad", [OUTER_A, { target: "x" }]],
	];

	it.each(BAD)("outer is %s", async (_name, outer) => {
		const good = { ...FLAT, host: "Good.md", contentHash: "good", folds: [], dormant: [] };
		const { store } = storeWith([{ ...base, outer }, good]);
		await store.load();

		expect(store.embedSize).toBe(1);
		expect(store.getEmbed(FLAT)).toBeUndefined();
		expect(store.embedRecords()[0].contentHash).toBe("good");
	});

	it("extra fields on a chain entry are not carried into the record", async () => {
		const { store } = storeWith([{ ...base, outer: [{ ...OUTER_A, junk: "x" }] }]);
		await store.load();
		expect(store.embedRecords()[0].outer).toEqual([OUTER_A]);
	});
});
