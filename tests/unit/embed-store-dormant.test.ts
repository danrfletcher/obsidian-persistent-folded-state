/**
 * Ticket warkworth-21, PR-7 (G6, E6, E8, E9, F2): the `embeds` section of the store forgets state
 * that has been dormant for 10 minutes, at load and at flush, exactly as `expireDormant` already
 * does for a note's dormant folds, by the wall clock (`now` injected). Whole-embed dormancy
 * (`dormantSince` on a record) survives a relaunch through a fake `saveData`/`loadData` round
 * trip, and `files` is never touched. Table-driven; the real FoldStore throughout.
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_DORMANT_AGE_MS } from "../../src/dormant";
import { FoldStore, STORE_VERSION } from "../../src/fold-store";
import type { EmbedPresence } from "../../src/embed-dormant";
import type { EmbedFoldRecord, StoredAnchor } from "../../src/types";

const T0 = 5_000_000;
const WINDOW = MAX_DORMANT_AGE_MS;
const ANCHOR = { kind: "task", indent: 0, text: "lesson 8", siblingIndex: 0, parentChain: [] } as unknown as StoredAnchor;
// A note with no dormant entry of its own, so moving the clock never changes it through the
// (older) note-level expiry: what these tests watch is that the embed step leaves it alone.
const FILES = {
	"Host.md": { contentHash: "n1", folds: [ANCHOR], dormant: [] },
};

function rec(occurrence: number, over: Partial<EmbedFoldRecord> = {}): EmbedFoldRecord {
	return { host: "Host.md", target: "Source.md", subpath: "^a", occurrence, contentHash: `h${occurrence}`, folds: [ANCHOR], dormant: [], ...over };
}

/** A store over an in-memory "disk" and a clock the test moves. */
function disk(initial: unknown, start = T0) {
	let stored: unknown = initial;
	const clock = { now: start };
	const saveData = vi.fn(async (data: unknown) => {
		stored = JSON.parse(JSON.stringify(data));
	});
	const open = async (): Promise<FoldStore> => {
		const store = new FoldStore({ loadData: async () => structuredClone(stored), saveData, now: () => clock.now });
		await store.load();
		return store;
	};
	return { clock, saveData, open, read: () => stored as { version: number; files: Record<string, unknown>; embeds?: EmbedFoldRecord[] } };
}

const AGES = [
	{ age: 0, kept: true },
	{ age: 1, kept: true },
	{ age: WINDOW - 1, kept: true },
	{ age: WINDOW, kept: false },
	{ age: WINDOW + 1, kept: false },
	{ age: 30 * 24 * 3_600_000, kept: false },
];

describe("load() forgets embed state that has been dormant for 10 minutes", () => {
	it.each(AGES)("a record dormant for $age ms: kept is $kept", async ({ age, kept }) => {
		const d = disk({ version: STORE_VERSION, files: FILES, embeds: [rec(0, { dormantSince: T0 - age })] });
		const store = await d.open();
		expect(store.embedSize).toBe(kept ? 1 : 0);
	});

	it.each(AGES)("a per-anchor dormant entry (G14) inside a live embed, $age ms old: kept is $kept", async ({ age, kept }) => {
		const entry = { ...ANCHOR, dormantSince: T0 - age } as unknown as StoredAnchor;
		const d = disk({ version: STORE_VERSION, files: FILES, embeds: [rec(0, { dormant: [entry] })] });
		const store = await d.open();
		expect(store.embedRecords()[0].dormant).toEqual(kept ? [entry] : []);
		expect(store.embedRecords()[0].folds).toEqual([ANCHOR]); // the live embed's folds are never touched
	});

	it("a kept dormant record comes back field for field, dormantSince included", async () => {
		const original = rec(0, { dormantSince: T0 - 12_345, contentHash: "keep-me" });
		const d = disk({ version: STORE_VERSION, files: FILES, embeds: [original] });
		expect((await d.open()).embedRecords()).toEqual([original]);
	});

	it("an expired record does not take its neighbours with it (G8)", async () => {
		const live = rec(0);
		const dormant = rec(1, { dormantSince: T0 - 1000 });
		const d = disk({ version: STORE_VERSION, files: FILES, embeds: [live, rec(2, { dormantSince: T0 - WINDOW }), dormant] });
		expect((await d.open()).embedRecords()).toEqual([live, dormant]);
	});

	it("the notes' own records are untouched by the embed pruning (F2)", async () => {
		const d = disk({ version: STORE_VERSION, files: FILES, embeds: [rec(0, { dormantSince: T0 - WINDOW })] });
		const store = await d.open();
		expect(JSON.stringify(store.get("Host.md"))).toBe(JSON.stringify(FILES["Host.md"]));
	});

	it("a file with no embeds section loads unchanged and still has none after a flush", async () => {
		const d = disk({ version: STORE_VERSION, files: FILES });
		const store = await d.open();
		expect(store.embedSize).toBe(0);
		store.set("Other.md", { contentHash: "x", folds: [], dormant: [] });
		await store.flush();
		expect("embeds" in d.read()).toBe(false);
	});
});

describe("load() writes out what it forgot, without waiting for an unrelated write (T16)", () => {
	const withTimers = async (run: () => Promise<void>): Promise<void> => {
		vi.useFakeTimers();
		try {
			await run();
		} finally {
			vi.useRealTimers();
		}
	};

	it("a record that expired while the plugin was off leaves data.json by the ordinary debounce, and nothing else is needed", async () => {
		await withTimers(async () => {
			const keep = rec(1, { dormantSince: T0 - 1000 });
			const d = disk({ version: STORE_VERSION, files: FILES, embeds: [rec(0, { dormantSince: T0 - WINDOW }), keep] });
			const store = await d.open();
			expect(store.embedRecords()).toEqual([keep]);
			expect(d.read().embeds).toHaveLength(2); // still on disk the instant after load
			expect(d.saveData).not.toHaveBeenCalled(); // debounced, not at once

			await vi.advanceTimersByTimeAsync(150);
			expect(d.saveData).toHaveBeenCalledTimes(1);
			expect(d.read().embeds).toEqual([keep]);
			expect(d.read().files).toEqual(FILES); // the notes' own records are written as they were (F2)
		});
	});

	it("the only record expired: data.json loses its embeds section", async () => {
		await withTimers(async () => {
			const d = disk({ version: STORE_VERSION, files: FILES, embeds: [rec(0, { dormantSince: T0 - WINDOW - 1 })] });
			await d.open();
			await vi.advanceTimersByTimeAsync(150);
			expect("embeds" in d.read()).toBe(false);
			expect(d.read().version).toBe(STORE_VERSION);
		});
	});

	it("a per-anchor dormant entry that aged out is written out the same way, the embed's folds kept", async () => {
		await withTimers(async () => {
			const entry = { ...ANCHOR, dormantSince: T0 - WINDOW } as unknown as StoredAnchor;
			const d = disk({ version: STORE_VERSION, files: FILES, embeds: [rec(0, { dormant: [entry] })] });
			await d.open();
			await vi.advanceTimersByTimeAsync(150);
			expect(d.read().embeds).toEqual([rec(0)]);
		});
	});

	it("nothing expired, or no embeds at all: load writes nothing", async () => {
		await withTimers(async () => {
			for (const initial of [
				{ version: STORE_VERSION, files: FILES, embeds: [rec(0), rec(1, { dormantSince: T0 - (WINDOW - 1) })] },
				{ version: STORE_VERSION, files: FILES },
				undefined,
			]) {
				const d = disk(initial);
				await d.open();
				await vi.advanceTimersByTimeAsync(5000);
				expect(d.saveData).not.toHaveBeenCalled();
			}
		});
	});
});

describe("flush() forgets embed state that aged out while the store was open", () => {
	it.each(AGES)("dormant since T0 - 1 ms... then the clock moves $age ms: kept is $kept", async ({ age, kept }) => {
		const d = disk({ version: STORE_VERSION, files: FILES, embeds: [rec(0, { dormantSince: T0 }), rec(1)] });
		const store = await d.open();
		expect(store.embedSize).toBe(2);
		d.clock.now = T0 + age;
		store.set("Host.md", { contentHash: "changed", folds: [], dormant: [] }); // something to write
		await store.flush();
		const written = d.read().embeds ?? [];
		expect(written.map((r) => r.occurrence)).toEqual(kept ? [0, 1] : [1]);
		expect(store.embedSize).toBe(kept ? 2 : 1);
	});

	it("prunes a per-anchor dormant entry that aged out, leaving the embed's folds", async () => {
		const entry = { ...ANCHOR, dormantSince: T0 } as unknown as StoredAnchor;
		const d = disk({ version: STORE_VERSION, files: FILES, embeds: [rec(0, { dormant: [entry] })] });
		const store = await d.open();
		d.clock.now = T0 + WINDOW;
		store.set("Host.md", { contentHash: "changed", folds: [], dormant: [] });
		await store.flush();
		expect(d.read().embeds).toEqual([rec(0)]);
	});
});

describe("whole-embed dormancy survives a relaunch (E9)", () => {
	it("stamp, flush, close, reopen inside the window: the same record with the same dormantSince", async () => {
		const original = rec(0);
		const d = disk({ version: STORE_VERSION, files: FILES, embeds: [original] });
		const first = await d.open();
		first.reconcileEmbedDormancy("Host.md", () => "absent");
		await first.flush();
		expect(d.read().embeds).toEqual([{ ...original, dormantSince: T0 }]);

		d.clock.now = T0 + WINDOW - 1; // "relaunch" 9 min 59.999 s later: plugin was disabled meanwhile
		const second = await d.open();
		expect(second.embedRecords()).toEqual([{ ...original, dormantSince: T0 }]);
	});

	it("reopened at or after 10 minutes the record is gone, and so is its entry on disk after the next flush", async () => {
		const d = disk({ version: STORE_VERSION, files: FILES, embeds: [rec(0), rec(1)] });
		const first = await d.open();
		first.reconcileEmbedDormancy("Host.md", (r) => (r.occurrence === 0 ? "absent" : "live"));
		await first.flush();

		d.clock.now = T0 + WINDOW;
		const second = await d.open();
		expect(second.embedRecords().map((r) => r.occurrence)).toEqual([1]);
		second.set("Host.md", { contentHash: "n2", folds: [], dormant: [] });
		await second.flush();
		expect((d.read().embeds ?? []).map((r) => r.occurrence)).toEqual([1]);
	});

	it("the 10 minutes keep running while the plugin is disabled: stamp, disable 6 min, enable, disable 6 min more", async () => {
		const d = disk({ version: STORE_VERSION, files: FILES, embeds: [rec(0)] });
		const first = await d.open();
		first.reconcileEmbedDormancy("Host.md", () => "broken");
		await first.flush();
		d.clock.now = T0 + 6 * 60_000;
		const second = await d.open();
		expect(second.embedRecords()[0].dormantSince).toBe(T0); // not restarted by the relaunch
		await second.flush();
		d.clock.now = T0 + 12 * 60_000;
		expect((await d.open()).embedSize).toBe(0);
	});

	it("a stored dormantSince that is negative, non-numeric or not finite drops that record on load, never throws (E8)", async () => {
		for (const bad of [-1, "soon", null, Number.NaN, {}, [], true]) {
			const d = disk({ version: STORE_VERSION, files: FILES, embeds: [rec(0), { ...rec(1), dormantSince: bad }, rec(2)] });
			// JSON turns NaN into null: both are "not a number" on the way back in.
			const store = await d.open();
			expect(store.embedRecords().map((r) => r.occurrence)).toEqual([0, 2]);
		}
	});
});

describe("reconcileEmbedDormancy: the one dormancy step in the store (G6, E6, E12, F2)", () => {
	const make = async (records: EmbedFoldRecord[]) => {
		const d = disk({ version: STORE_VERSION, files: FILES, embeds: records });
		return { d, store: await d.open() };
	};

	it("first seen absent or broken: stamped at now, folds, dormant list and hash left exactly as they were", async () => {
		const original = rec(0, { dormant: [{ ...ANCHOR, dormantSince: T0 - 10 } as unknown as StoredAnchor] });
		const { store } = await make([original]);
		expect(store.reconcileEmbedDormancy("Host.md", () => "absent")).toEqual({ stamped: 1, revived: 0, forgotten: 0 });
		expect(store.embedRecords()).toEqual([{ ...original, dormantSince: T0 }]);
	});

	it("seen absent again later: the stamp does not move", async () => {
		const { d, store } = await make([rec(0)]);
		store.reconcileEmbedDormancy("Host.md", () => "absent");
		for (const minutes of [1, 3, 9]) {
			d.clock.now = T0 + minutes * 60_000;
			expect(store.reconcileEmbedDormancy("Host.md", () => "broken")).toEqual({ stamped: 0, revived: 0, forgotten: 0 });
			expect(store.embedRecords()[0].dormantSince).toBe(T0);
		}
	});

	it("live again inside the window: the stamp is removed and the folds are as they were", async () => {
		const original = rec(0);
		const { d, store } = await make([original]);
		store.reconcileEmbedDormancy("Host.md", () => "absent");
		d.clock.now = T0 + WINDOW - 1;
		expect(store.reconcileEmbedDormancy("Host.md", () => "live")).toEqual({ stamped: 0, revived: 1, forgotten: 0 });
		expect(store.embedRecords()).toEqual([original]);
		expect("dormantSince" in store.embedRecords()[0]).toBe(false);
	});

	it("live again after the window: forgotten, not revived, and the embed starts with no record (G13)", async () => {
		const { d, store } = await make([rec(0)]);
		store.reconcileEmbedDormancy("Host.md", () => "absent");
		d.clock.now = T0 + WINDOW;
		expect(store.reconcileEmbedDormancy("Host.md", () => "live")).toEqual({ stamped: 0, revived: 0, forgotten: 1 });
		expect(store.embedSize).toBe(0);
	});

	it("only the records of that host change, and only those the caller assessed", async () => {
		const mine = rec(0);
		const unassessed = rec(1);
		const elsewhere: EmbedFoldRecord = { ...rec(0), host: "Other Host.md" };
		const { store } = await make([mine, unassessed, elsewhere]);
		store.reconcileEmbedDormancy("Host.md", (r): EmbedPresence | undefined => (r.occurrence === 0 ? "absent" : undefined));
		expect(store.embedRecords()).toEqual([{ ...mine, dormantSince: T0 }, unassessed, elsewhere]);
	});

	it("never creates a record (E12), and leaves the notes' own records byte-identical (F2)", async () => {
		const { store } = await make([]);
		expect(store.reconcileEmbedDormancy("Host.md", () => "absent")).toEqual({ stamped: 0, revived: 0, forgotten: 0 });
		expect(store.embedSize).toBe(0);

		const { d, store: other } = await make([rec(0), rec(1)]);
		const filesBefore = JSON.stringify(d.read().files);
		const noteBefore = JSON.stringify(other.get("Host.md"));
		other.reconcileEmbedDormancy("Host.md", (r) => (r.occurrence === 0 ? "absent" : "broken"));
		d.clock.now = T0 + WINDOW;
		other.reconcileEmbedDormancy("Host.md", () => "absent");
		await other.flush();
		expect(JSON.stringify(other.get("Host.md"))).toBe(noteBefore);
		expect(JSON.stringify(d.read().files)).toBe(filesBefore);
		expect(d.read().version).toBe(1);
	});

	it("the change is flushed by the ordinary debounce, not at once, and nothing changes when nothing is to be done", async () => {
		vi.useFakeTimers();
		try {
			const { store, d } = await make([rec(0)]);
			d.saveData.mockClear();
			store.reconcileEmbedDormancy("Host.md", () => "live");
			await vi.advanceTimersByTimeAsync(5000);
			expect(d.saveData).not.toHaveBeenCalled();

			store.reconcileEmbedDormancy("Host.md", () => "absent");
			expect(d.saveData).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(5000);
			expect(d.saveData).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
