import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FoldStore, STORE_VERSION } from "../../src/fold-store";
import type { EmbedFoldRecord, EmbedIdentity } from "../../src/types";
import { ANCHOR_LESSON_8, ANCHOR_TASK, SEED_EMBEDS, SEED_FILES } from "../fixtures/embed-seed";

// The seed holds a dormant entry stamped at 1,000 ms. Since PR-7 the store forgets what has been
// dormant for 10 minutes by the wall clock, so these tests pin the clock (Date only) inside that window.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(2_000);
});
afterEach(() => {
	vi.useRealTimers();
});

function embed(id: EmbedIdentity, contentHash = "h", folds: Record<string, unknown>[] = []): EmbedFoldRecord {
	return { ...id, contentHash, folds, dormant: [] };
}

async function seededStore() {
	const saveData = vi.fn(async (_data: unknown) => undefined);
	const store = new FoldStore({
		loadData: async () => structuredClone({ version: STORE_VERSION, files: SEED_FILES, embeds: SEED_EMBEDS }),
		saveData,
	});
	await store.load();
	return { store, saveData };
}

async function emptyStore() {
	const saveData = vi.fn(async (_data: unknown) => undefined);
	const store = new FoldStore({ loadData: async () => null, saveData });
	await store.load();
	return { store, saveData };
}

describe("embed store: get/set/replace by structured fields", () => {
	it("a never-set embed is undefined and the store starts with no embeds", async () => {
		const { store } = await emptyStore();
		expect(store.embedSize).toBe(0);
		expect(store.getEmbed({ host: "A.md", target: "B.md", subpath: "", occurrence: 0 })).toBeUndefined();
		expect(store.embedRecords()).toEqual([]);
	});

	it("setEmbed then getEmbed returns the record, looked up by host/target/subpath/occurrence", async () => {
		const { store } = await emptyStore();
		const record = embed({ host: "A.md", target: "B.md", subpath: "^x", occurrence: 0 }, "h1", [ANCHOR_LESSON_8]);
		store.setEmbed(record);
		expect(store.getEmbed({ host: "A.md", target: "B.md", subpath: "^x", occurrence: 0 })).toEqual(record);
		expect(store.embedSize).toBe(1);
	});

	it("setEmbed on an existing identity replaces the record entirely", async () => {
		const { store } = await emptyStore();
		const id = { host: "A.md", target: "B.md", subpath: "^x", occurrence: 0 };
		store.setEmbed(embed(id, "v1", [ANCHOR_LESSON_8]));
		store.setEmbed(embed(id, "v2", [ANCHOR_TASK]));
		expect(store.embedSize).toBe(1);
		expect(store.getEmbed(id)).toEqual(embed(id, "v2", [ANCHOR_TASK]));
	});

	it("each of host, target, subpath and occurrence alone distinguishes two records", async () => {
		const { store } = await emptyStore();
		const base = { host: "A.md", target: "B.md", subpath: "^x", occurrence: 0 };
		const variants: EmbedIdentity[] = [
			base,
			{ ...base, host: "A2.md" },
			{ ...base, target: "B2.md" },
			{ ...base, subpath: "^y" },
			{ ...base, occurrence: 1 },
		];
		variants.forEach((id, i) => store.setEmbed(embed(id, `h${i}`)));
		expect(store.embedSize).toBe(5);
		variants.forEach((id, i) => expect(store.getEmbed(id)?.contentHash).toBe(`h${i}`));
	});

	it("occurrence 0 and 1 of the same host, target and subpath are two records", async () => {
		const { store } = await emptyStore();
		const id = { host: "A.md", target: "B.md", subpath: "^x" };
		store.setEmbed(embed({ ...id, occurrence: 0 }, "first"));
		store.setEmbed(embed({ ...id, occurrence: 1 }, "second"));
		expect(store.embedSize).toBe(2);
		expect(store.getEmbed({ ...id, occurrence: 0 })?.contentHash).toBe("first");
		expect(store.getEmbed({ ...id, occurrence: 1 })?.contentHash).toBe("second");
	});

	it("a subpath of '' (whole-note embed) is distinct from any non-empty subpath", async () => {
		const { store } = await emptyStore();
		store.setEmbed(embed({ host: "A.md", target: "B.md", subpath: "", occurrence: 0 }, "whole"));
		store.setEmbed(embed({ host: "A.md", target: "B.md", subpath: "Heading", occurrence: 0 }, "heading"));
		expect(store.getEmbed({ host: "A.md", target: "B.md", subpath: "", occurrence: 0 })?.contentHash).toBe("whole");
		expect(store.embedSize).toBe(2);
	});

	it("embeds and notes are separate maps", async () => {
		const { store } = await emptyStore();
		store.set("A.md", { contentHash: "n", folds: [], dormant: [] });
		store.setEmbed(embed({ host: "A.md", target: "B.md", subpath: "", occurrence: 0 }));
		expect(store.size).toBe(1);
		expect(store.embedSize).toBe(1);
	});
});

describe("embed store: identity collisions (paths with # | / > spaces unicode quotes)", () => {
	// Each pair would collide under a naive `host + "#" + target`-style composite key, or under
	// one joined on any of these separator characters.
	const pairs: { label: string; a: EmbedIdentity; b: EmbedIdentity }[] = [
		{
			label: "'#' moved between host and target",
			a: { host: "x#y.md", target: "z.md", subpath: "", occurrence: 0 },
			b: { host: "x.md", target: "y#z.md", subpath: "", occurrence: 0 },
		},
		{
			label: "'#' moved between target and subpath",
			a: { host: "h.md", target: "a#b.md", subpath: "c", occurrence: 0 },
			b: { host: "h.md", target: "a.md", subpath: "b.md#c", occurrence: 0 },
		},
		{
			label: "'|' moved between host and target",
			a: { host: "a|b.md", target: "c.md", subpath: "", occurrence: 0 },
			b: { host: "a.md", target: "b|c.md", subpath: "", occurrence: 0 },
		},
		{
			label: "'/' folder split vs file name",
			a: { host: "dir/a.md", target: "b.md", subpath: "", occurrence: 0 },
			b: { host: "dir", target: "a.md/b.md", subpath: "", occurrence: 0 },
		},
		{
			label: "'>' (nested chain separator) in a path",
			a: { host: "a>b.md", target: "c.md", subpath: "", occurrence: 0 },
			b: { host: "a.md", target: "b>c.md", subpath: "", occurrence: 0 },
		},
		{
			label: "spaces around separators",
			a: { host: "a b.md", target: "c.md", subpath: "", occurrence: 0 },
			b: { host: "a.md", target: "b c.md", subpath: "", occurrence: 0 },
		},
		{
			label: "unicode vs its decomposed form",
			a: { host: "Café.md", target: "t.md", subpath: "", occurrence: 0 },
			b: { host: "Cafe\u0301.md", target: "t.md", subpath: "", occurrence: 0 },
		},
		{
			label: "double quote, which a JSON-ish composite would escape",
			a: { host: 'a","b.md', target: "c.md", subpath: "", occurrence: 0 },
			b: { host: "a.md", target: 'b.md","c.md', subpath: "", occurrence: 0 },
		},
		{
			label: "occurrence digits vs a numeric-looking subpath",
			a: { host: "h.md", target: "t.md", subpath: "1", occurrence: 0 },
			b: { host: "h.md", target: "t.md", subpath: "", occurrence: 10 },
		},
		{
			label: "'|' moved between target and subpath",
			a: { host: "h.md", target: "t.md", subpath: "^a|b", occurrence: 0 },
			b: { host: "h.md", target: "t.md|^a", subpath: "b", occurrence: 0 },
		},
	];

	it.each(pairs)("$label: stays two records, each readable on its own", async ({ a, b }) => {
		const { store } = await emptyStore();
		store.setEmbed(embed(a, "A"));
		store.setEmbed(embed(b, "B"));
		expect(store.embedSize).toBe(2);
		expect(store.getEmbed(a)?.contentHash).toBe("A");
		expect(store.getEmbed(b)?.contentHash).toBe("B");
		expect(store.forgetEmbed(a)).toBe(true);
		expect(store.getEmbed(b)?.contentHash).toBe("B");
	});

	it("records with such paths survive a flush and reload as the same structured fields", async () => {
		let stored: unknown = null;
		const options = {
			loadData: async () => structuredClone(stored),
			saveData: async (data: unknown) => {
				stored = structuredClone(data);
			},
		};
		const first = new FoldStore(options);
		await first.load();
		for (const { a, b } of pairs) {
			first.setEmbed(embed(a, "A"));
			first.setEmbed(embed(b, "B"));
		}
		await first.flush();

		const second = new FoldStore(options);
		await second.load();
		expect(second.embedSize).toBe(first.embedSize);
		for (const { a, b } of pairs) {
			expect(second.getEmbed(a)?.contentHash).toBe("A");
			expect(second.getEmbed(b)?.contentHash).toBe("B");
		}
	});

	it("persists identity as structured fields, never a composite key", async () => {
		const { store, saveData } = await emptyStore();
		store.setEmbed(embed({ host: "a#b.md", target: "c|d.md", subpath: "^x", occurrence: 2 }));
		await store.flush();
		const written = saveData.mock.calls[0][0] as { embeds: Record<string, unknown>[] };
		expect(Array.isArray(written.embeds)).toBe(true);
		expect(written.embeds).toEqual([
			{ host: "a#b.md", target: "c|d.md", subpath: "^x", occurrence: 2, contentHash: "h", folds: [], dormant: [] },
		]);
	});
});

describe("embed store: forgetEmbed", () => {
	it("removes one record, flushes, and returns true", async () => {
		const { store, saveData } = await seededStore();
		const id = { host: "Rocketship.md", target: "Competitive Coding Fundamentals.md", subpath: "^0169a6", occurrence: 1 };
		expect(store.forgetEmbed(id)).toBe(true);
		expect(store.getEmbed(id)).toBeUndefined();
		expect(store.embedSize).toBe(4);
		await vi.waitFor(() => expect(saveData).toHaveBeenCalledTimes(1));
	});

	it("a miss is a no-op that never reaches saveData", async () => {
		const { store, saveData } = await seededStore();
		expect(store.forgetEmbed({ host: "Nope.md", target: "Nope.md", subpath: "", occurrence: 0 })).toBe(false);
		await store.flush();
		expect(saveData).not.toHaveBeenCalled();
	});
});

describe("embed store: forgetEmbedsForHost", () => {
	it("returns the count removed and flushes exactly once", async () => {
		const { store, saveData } = await seededStore();
		expect(store.forgetEmbedsForHost("Rocketship.md")).toBe(3);
		await store.flush();
		expect(saveData).toHaveBeenCalledTimes(1);
		const written = saveData.mock.calls[0][0] as { embeds: EmbedFoldRecord[] };
		expect(written.embeds.map((r) => r.contentHash)).toEqual(["e4", "e5"]);
	});

	it("matches the host exactly: a record whose target is that path stays", async () => {
		const { store } = await seededStore();
		// Rocketship.md is the *target* of e5 (hosted by Other Host.md).
		store.forgetEmbedsForHost("Rocketship.md");
		expect(store.getEmbed({ host: "Other Host.md", target: "Rocketship.md", subpath: "", occurrence: 0 })).toBeDefined();
	});

	it("does not match by path prefix", async () => {
		const { store } = await seededStore();
		expect(store.forgetEmbedsForHost("Rocket")).toBe(0);
		expect(store.forgetEmbedsForHost("Rocketship.md/extra")).toBe(0);
		expect(store.embedSize).toBe(5);
	});

	it("leaves every note record alone", async () => {
		const { store } = await seededStore();
		store.forgetEmbedsForHost("Rocketship.md");
		expect(store.size).toBe(2);
		expect(store.get("Rocketship.md")).toEqual(SEED_FILES["Rocketship.md"]);
	});

	it("a host with no embeds is a no-op that never reaches saveData", async () => {
		const { store, saveData } = await seededStore();
		expect(store.forgetEmbedsForHost("Unknown.md")).toBe(0);
		await store.flush();
		expect(saveData).not.toHaveBeenCalled();
	});
});

describe("embed store: forgetNote (note record plus hosted embeds, one flush)", () => {
	it("removes both, reports both, and writes once", async () => {
		const { store, saveData } = await seededStore();
		expect(store.forgetNote("Rocketship.md")).toEqual({ note: true, embeds: 3 });
		await store.flush();
		expect(saveData).toHaveBeenCalledTimes(1);
		const written = saveData.mock.calls[0][0] as { files: Record<string, unknown>; embeds: EmbedFoldRecord[] };
		expect(Object.keys(written.files)).toEqual(["Other Host.md"]);
		expect(written.embeds.map((r) => r.contentHash)).toEqual(["e4", "e5"]);
	});

	it("note record only, embeds only, and neither", async () => {
		const { store, saveData } = await seededStore();
		store.set("Plain.md", { contentHash: "p", folds: [], dormant: [] });
		store.setEmbed(embed({ host: "Embeds Only.md", target: "T.md", subpath: "", occurrence: 0 }));
		await store.flush();
		saveData.mockClear();

		expect(store.forgetNote("Plain.md")).toEqual({ note: true, embeds: 0 });
		expect(store.forgetNote("Embeds Only.md")).toEqual({ note: false, embeds: 1 });
		await store.flush();
		const callsBeforeMiss = saveData.mock.calls.length;
		expect(store.forgetNote("Missing.md")).toEqual({ note: false, embeds: 0 });
		await store.flush();
		expect(saveData).toHaveBeenCalledTimes(callsBeforeMiss); // the miss wrote nothing
	});
});

describe("embed store: forgetAll", () => {
	it("clears both sections, returns the note count and writes a snapshot with no embeds key", async () => {
		const { store, saveData } = await seededStore();
		expect(store.forgetAll()).toBe(2);
		expect(store.size).toBe(0);
		expect(store.embedSize).toBe(0);
		await store.flush();
		expect(saveData).toHaveBeenCalledTimes(1);
		const written = saveData.mock.calls[0][0] as Record<string, unknown>;
		expect(written).toEqual({ version: 1, files: {} });
		expect("embeds" in written).toBe(false);
	});

	it("a store holding only embeds is not treated as empty: it is cleared and flushed", async () => {
		const { store, saveData } = await emptyStore();
		store.setEmbed(embed({ host: "A.md", target: "B.md", subpath: "", occurrence: 0 }));
		store.setEmbed(embed({ host: "A.md", target: "C.md", subpath: "", occurrence: 0 }));
		await store.flush();
		saveData.mockClear();

		expect(store.forgetAll()).toBe(0);
		expect(store.embedSize).toBe(0);
		await store.flush();
		expect(saveData).toHaveBeenCalledTimes(1);
		expect(saveData.mock.calls[0][0]).toEqual({ version: 1, files: {} });
	});

	it("an entirely empty store is a no-op that never reaches saveData", async () => {
		const { store, saveData } = await emptyStore();
		expect(store.forgetAll()).toBe(0);
		await store.flush();
		expect(saveData).not.toHaveBeenCalled();
	});
});

describe("embed store: setEmbed refuses an identity the next load would drop (PR-1 R1)", () => {
	const good = { host: "A.md", target: "B.md", subpath: "^x", occurrence: 0 };
	const bad: { name: string; id: EmbedIdentity }[] = [
		{ name: "an empty host", id: { ...good, host: "" } },
		{ name: "an empty target", id: { ...good, target: "" } },
		{ name: "a negative occurrence", id: { ...good, occurrence: -1 } },
		{ name: "a fractional occurrence", id: { ...good, occurrence: 1.5 } },
		{ name: "a NaN occurrence", id: { ...good, occurrence: Number.NaN } },
		{ name: "a chain link with a negative occurrence", id: { ...good, outer: [{ target: "C.md", subpath: "", occurrence: -2 }] } },
		{ name: "a chain link with an empty target", id: { ...good, outer: [{ target: "", subpath: "", occurrence: 0 }] } },
	];

	for (const { name, id } of bad) {
		it(`refuses ${name}: nothing is kept in memory and nothing is written`, async () => {
			const { store, saveData } = await emptyStore();
			expect(store.setEmbed(embed(id))).toBe(false);
			expect(store.embedSize).toBe(0);
			expect(store.embedRecords()).toEqual([]);
			await store.flush();
			expect(saveData).not.toHaveBeenCalled();
		});
	}

	for (const { name, id } of bad) {
		it(`load drops ${name} from a data.json too (one rule for both paths)`, async () => {
			const raw = { version: 1, files: {}, embeds: [{ ...id, contentHash: "h", folds: [] }, { ...good, subpath: "^kept", contentHash: "h", folds: [] }] };
			const store = new FoldStore({ loadData: async () => raw, saveData: async () => undefined });
			await store.load();
			expect(store.embedRecords().map((r) => r.subpath)).toEqual(["^kept"]);
		});
	}

	it("accepts a valid record and reports it", async () => {
		const { store } = await emptyStore();
		expect(store.setEmbed(embed(good))).toBe(true);
		expect(store.embedSize).toBe(1);
	});

	it("accepts a nested record whose chain is valid, and what it stores survives a save and a load", async () => {
		const saved: unknown[] = [];
		const store = new FoldStore({ loadData: async () => null, saveData: async (data) => void saved.push(data) });
		await store.load();
		const nested = embed({ ...good, outer: [{ target: "C.md", subpath: "", occurrence: 0 }] });
		expect(store.setEmbed(nested)).toBe(true);
		await store.flush();
		const reloaded = new FoldStore({ loadData: async () => saved[0], saveData: async () => undefined });
		await reloaded.load();
		expect(reloaded.embedRecords()).toEqual([nested]);
	});
});

describe("embed store: writes", () => {
	it("a notes-only store writes no embeds key (the file is what 0.1.1 wrote)", async () => {
		const { store, saveData } = await emptyStore();
		store.set("A.md", { contentHash: "a", folds: [], dormant: [] });
		await store.flush();
		const written = saveData.mock.calls[0][0] as Record<string, unknown>;
		expect(written).toEqual({ version: 1, files: { "A.md": { contentHash: "a", folds: [], dormant: [] } } });
		expect("embeds" in written).toBe(false);
	});

	it("a flush with notes and embeds writes both sections", async () => {
		const { store, saveData } = await seededStore();
		store.set("Rocketship.md", { contentHash: "r2", folds: [], dormant: [] });
		await store.flush();
		const written = saveData.mock.calls[0][0] as { files: Record<string, unknown>; embeds: unknown[] };
		expect(Object.keys(written.files)).toEqual(["Rocketship.md", "Other Host.md"]);
		expect(written.embeds).toEqual(SEED_EMBEDS);
	});

	it("loading and flushing with no changes writes nothing", async () => {
		const { store, saveData } = await seededStore();
		await store.flush();
		expect(saveData).not.toHaveBeenCalled();
	});
});

describe("embed store: rename, delete and prune leave embeds untouched (PR-8 owns embed variants)", () => {
	// Pinned so PR-8 changes this deliberately: today these treat keys as note paths only.
	it("handleRename of a host and of a target leaves every embed record as it was", async () => {
		const { store, saveData } = await seededStore();
		expect(store.handleRename("Rocketship.md", "Renamed.md")).toBe(true); // the note record moves
		expect(store.handleRename("Competitive Coding Fundamentals.md", "CCF.md")).toBe(false); // no note record
		await store.flush();
		expect(store.embedRecords()).toEqual(SEED_EMBEDS);
		const written = saveData.mock.calls.at(-1)?.[0] as { embeds: unknown[] };
		expect(written.embeds).toEqual(SEED_EMBEDS);
	});

	it("handleRename of a folder prefix leaves embed records as they were", async () => {
		const { store } = await emptyStore();
		const record = embed({ host: "Dir/Host.md", target: "Dir/T.md", subpath: "", occurrence: 0 });
		store.setEmbed(record);
		expect(store.handleRename("Dir", "Moved")).toBe(false);
		expect(store.embedRecords()).toEqual([record]);
	});

	it("handleDelete of a host and of a target leaves every embed record as it was", async () => {
		const { store } = await seededStore();
		expect(store.handleDelete("Rocketship.md")).toBe(true); // the note record goes
		expect(store.handleDelete("Competitive Coding Fundamentals.md")).toBe(false);
		expect(store.embedRecords()).toEqual(SEED_EMBEDS);
	});

	it("pruneOrphans with a vault that contains none of the paths leaves every embed record", async () => {
		const { store, saveData } = await seededStore();
		expect(store.pruneOrphans(() => false)).toBe(2); // both note records are orphans
		await store.flush();
		expect(store.embedRecords()).toEqual(SEED_EMBEDS);
		const written = saveData.mock.calls.at(-1)?.[0] as { files: Record<string, unknown>; embeds: unknown[] };
		expect(written.files).toEqual({});
		expect(written.embeds).toEqual(SEED_EMBEDS);
	});

	it("a rename or delete that touches only embeds' paths never reaches saveData", async () => {
		const { store, saveData } = await seededStore();
		store.handleRename("Competitive Coding Fundamentals.md", "CCF.md");
		store.handleDelete("Competitive Coding Fundamentals.md");
		store.pruneOrphans((p) => p === "Rocketship.md" || p === "Other Host.md");
		await store.flush();
		expect(saveData).not.toHaveBeenCalled();
	});
});
