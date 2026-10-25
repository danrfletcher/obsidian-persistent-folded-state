/**
 * Ticket warkworth-21, PR-7 (G6, G14, E6, E7, E8, E12): the pure dormancy rules for embed state,
 * with a fake clock (`now` is always an argument, no timer is involved).
 *  - src/embed-dormant.ts: what happens to a whole embed record when its embed goes away or comes back;
 *  - src/embed-dormancy.ts: deciding `live` / `absent` / `broken` for a record, for every kind of
 *    embed (block, heading, whole note);
 *  - src/embed-anchor-dormancy.ts: a fold inside a live embed that the matcher cannot place.
 * Everything goes through the real functions; nothing is mocked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAnchors, parseAnchor } from "../../src/anchors";
import type { Anchor } from "../../src/anchors";
import { MAX_DORMANT_AGE_MS } from "../../src/dormant";
import { planEmbedPass } from "../../src/embed-anchor-dormancy";
import { EmbedDormancyTracker, HEADING_RENAME_GRACE_MS, classifyEmbedRecord } from "../../src/embed-dormancy";
import { expireEmbedRecords, isEmbedDormancyExpired, isValidDormantSince, nextEmbedDormancy } from "../../src/embed-dormant";
import type { EmbedDormancyAction, EmbedPresence } from "../../src/embed-dormant";
import { HostComparisonBudget } from "../../src/embed-rematch";
import { sliceEmbed } from "../../src/embed-slice";
import type { EmbedFoldRecord, StoredAnchor } from "../../src/types";

const T0 = 1_000_000;
const WINDOW = MAX_DORMANT_AGE_MS;

describe("the window is 10 minutes of wall clock", () => {
	it("is 600,000 ms", () => {
		expect(WINDOW).toBe(600_000);
	});

	it.each([
		{ age: 0, expired: false },
		{ age: 1, expired: false },
		{ age: 599_999, expired: false },
		{ age: 600_000, expired: true },
		{ age: 600_001, expired: true },
		{ age: 86_400_000, expired: true },
	])("dormant for $age ms: expired is $expired", ({ age, expired }) => {
		expect(isEmbedDormancyExpired(T0, T0 + age)).toBe(expired);
	});
});

describe("nextEmbedDormancy: one rule for every record (G6, E6)", () => {
	const rows: { label: string; since: number | undefined; presence: EmbedPresence; age: number; expected: EmbedDormancyAction }[] = [
		{ label: "healthy and live", since: undefined, presence: "live", age: 0, expected: { kind: "keep" } },
		{ label: "healthy, first seen retargeted", since: undefined, presence: "absent", age: 0, expected: { kind: "stamp", dormantSince: T0 } },
		{ label: "healthy, first seen broken", since: undefined, presence: "broken", age: 0, expected: { kind: "stamp", dormantSince: T0 } },
		{ label: "dormant, seen retargeted again", since: T0 - 1000, presence: "absent", age: 0, expected: { kind: "keep" } },
		{ label: "dormant, seen broken again", since: T0 - 1000, presence: "broken", age: 0, expected: { kind: "keep" } },
		{ label: "dormant and live again inside the window", since: T0 - 1000, presence: "live", age: 0, expected: { kind: "revive" } },
		{ label: "dormant 599,999 ms and live again", since: T0 - 599_999, presence: "live", age: 0, expected: { kind: "revive" } },
		{ label: "dormant 599,999 ms and still retargeted", since: T0 - 599_999, presence: "absent", age: 0, expected: { kind: "keep" } },
		{ label: "dormant 600,000 ms and still retargeted", since: T0 - 600_000, presence: "absent", age: 0, expected: { kind: "forget" } },
		{ label: "dormant 600,000 ms and still broken", since: T0 - 600_000, presence: "broken", age: 0, expected: { kind: "forget" } },
		{ label: "dormant 600,000 ms and live again: too late", since: T0 - 600_000, presence: "live", age: 0, expected: { kind: "forget" } },
	];
	it.each(rows)("$label", ({ since, presence, age, expected }) => {
		expect(nextEmbedDormancy(since, presence, T0 + age)).toEqual(expected);
	});

	it("the clock never restarts: seen absent or broken any number of times, the stamp stays the first one", () => {
		let since: number | undefined;
		const sightings: { at: number; presence: EmbedPresence }[] = [
			{ at: 0, presence: "absent" },
			{ at: 60_000, presence: "absent" },
			{ at: 120_000, presence: "broken" },
			{ at: 599_999, presence: "absent" },
		];
		for (const { at, presence } of sightings) {
			const action = nextEmbedDormancy(since, presence, T0 + at);
			if (action.kind === "stamp") since = action.dormantSince;
			else expect(action.kind).toBe("keep");
		}
		expect(since).toBe(T0);
		expect(nextEmbedDormancy(since, "absent", T0 + WINDOW)).toEqual({ kind: "forget" });
	});

	it("reverting twice in a row inside the window: each revert revives, none of them restarts the first clock", () => {
		let since: number | undefined;
		const step = (presence: EmbedPresence, at: number): void => {
			const action = nextEmbedDormancy(since, presence, T0 + at);
			if (action.kind === "stamp") since = action.dormantSince;
			if (action.kind === "revive") since = undefined;
		};
		step("absent", 0);
		expect(since).toBe(T0);
		step("live", 1000); // reverted
		expect(since).toBeUndefined();
		step("live", 2000); // seen live again: nothing to do
		expect(since).toBeUndefined();
	});
});

describe("isValidDormantSince", () => {
	it.each([0, 1, 1_700_000_000_000, 0.5])("%s is valid", (value) => {
		expect(isValidDormantSince(value)).toBe(true);
	});
	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined, {}, [], true])("%s is not", (value) => {
		expect(isValidDormantSince(value)).toBe(false);
	});
});

// --- Fixtures ------------------------------------------------------------------------------

const ANCHOR_LESSON_8 = { kind: "task", indent: 0, text: "lesson 8: collections and frequency counting ^0169a6", siblingIndex: 1, parentChain: [] };
const ANCHOR_OTHER = { kind: "task", indent: 0, text: "lesson 9: graphs ^bbb222", siblingIndex: 2, parentChain: [] };

function record(over: Partial<EmbedFoldRecord> = {}): EmbedFoldRecord {
	return {
		host: "Host.md",
		target: "Source.md",
		subpath: "^0169a6",
		occurrence: 0,
		contentHash: "h",
		folds: [ANCHOR_LESSON_8 as unknown as StoredAnchor],
		dormant: [],
		...over,
	};
}

describe("expireEmbedRecords: load and flush (G6, E9)", () => {
	it("a record dormant 599,999 ms is kept, one dormant 600,000 ms is forgotten", () => {
		const kept = record({ dormantSince: T0 });
		const forgotten = record({ occurrence: 1, dormantSince: T0 });
		expect(expireEmbedRecords([kept], T0 + 599_999)).toEqual([kept]);
		expect(expireEmbedRecords([forgotten], T0 + 600_000)).toEqual([]);
	});

	it("healthy records are never touched, however old the clock", () => {
		const healthy = [record(), record({ occurrence: 1 })];
		expect(expireEmbedRecords(healthy, Number.MAX_SAFE_INTEGER)).toEqual(healthy);
	});

	it("only the expired record goes: its neighbours, dormant or not, are kept as they are (G8)", () => {
		const a = record({ occurrence: 0 });
		const b = record({ occurrence: 1, dormantSince: T0 - WINDOW });
		const c = record({ occurrence: 2, dormantSince: T0 - 1000 });
		expect(expireEmbedRecords([a, b, c], T0)).toEqual([a, c]);
	});

	it("a kept record keeps folds, dormant list and hash exactly (a dormant embed's state is never altered)", () => {
		const dormantRecord = record({ dormantSince: T0 - 5000, folds: [ANCHOR_LESSON_8 as unknown as StoredAnchor], contentHash: "keep-me" });
		const [out] = expireEmbedRecords([dormantRecord], T0);
		expect(out).toBe(dormantRecord);
	});

	it("the per-anchor dormant list inside a record is pruned with the same rule", () => {
		const fresh = { ...ANCHOR_OTHER, dormantSince: T0 - 599_999 } as unknown as StoredAnchor;
		const stale = { ...ANCHOR_LESSON_8, dormantSince: T0 - 600_000 } as unknown as StoredAnchor;
		const [out] = expireEmbedRecords([record({ dormant: [fresh, stale] })], T0);
		expect(out.dormant).toEqual([fresh]);
	});

	it("does not mutate its input", () => {
		const input = [record({ dormant: [{ ...ANCHOR_LESSON_8, dormantSince: 0 } as unknown as StoredAnchor] })];
		const copy = structuredClone(input);
		expireEmbedRecords(input, T0);
		expect(input).toEqual(copy);
	});
});

// --- Retarget and broken-embed transitions, for every kind of embed -----------------------------

const SOURCE_TEXT = [
	"# Source",
	"",
	"- [ ] Lesson 8: Collections and frequency counting ^0169a6",
	"  - [ ] Count word frequency",
	"",
	"## Chapter Two",
	"- [ ] A task under chapter two",
	"  - [ ] A child",
	"",
].join("\n");

type Kind = "block" | "heading" | "whole-note";
const KINDS: { kind: Kind; subpath: string; elsewhere: string }[] = [
	{ kind: "block", subpath: "^0169a6", elsewhere: "^zzz999" },
	{ kind: "heading", subpath: "Chapter Two", elsewhere: "Source" },
	{ kind: "whole-note", subpath: "", elsewhere: "Chapter Two" },
];

const linkFor = (target: string, subpath: string): string => {
	const name = target.replace(/\.md$/, "");
	if (subpath === "") return `![[${name}]]`;
	return subpath.startsWith("^") ? `![[${name}#${subpath}]]` : `![[${name}#${subpath}]]`;
};

interface Vault {
	notes: Map<string, string>;
	/** Paths whose note reads as missing even though the link still resolves to them. */
	unreadable: Set<string>;
}

function deps(vault: Vault) {
	return {
		readNote: async (path: string) => (vault.unreadable.has(path) ? null : (vault.notes.get(path) ?? null)),
		resolveLink: (linktext: string) => (vault.notes.has(`${linktext}.md`) ? `${linktext}.md` : null),
	};
}

function vaultWith(extra: Record<string, string> = {}): Vault {
	return { notes: new Map(Object.entries({ "Source.md": SOURCE_TEXT, "Other.md": "- [ ] other\n  - [ ] child\n", ...extra })), unreadable: new Set() };
}

describe("classifyEmbedRecord: live, retargeted, broken, for block, heading and whole-note embeds", () => {
	it.each(KINDS)("$kind: the key is in the host and resolves: live", async ({ subpath }) => {
		const host = linkFor("Source.md", subpath);
		expect(await classifyEmbedRecord(record({ subpath }), host, deps(vaultWith()))).toBe("live");
	});

	it.each(KINDS)("$kind: the link now points at another note: absent (G6)", async ({ subpath }) => {
		const host = linkFor("Other.md", subpath);
		expect(await classifyEmbedRecord(record({ subpath }), host, deps(vaultWith()))).toBe("absent");
	});

	it.each(KINDS)("$kind: the link now points elsewhere in the same note: absent (G6)", async ({ subpath, elsewhere }) => {
		const host = linkFor("Source.md", elsewhere);
		expect(await classifyEmbedRecord(record({ subpath }), host, deps(vaultWith()))).toBe("absent");
	});

	it.each(KINDS)("$kind: the link is gone from the host: absent", async ({ subpath }) => {
		expect(await classifyEmbedRecord(record({ subpath }), "just text\n", deps(vaultWith()))).toBe("absent");
		expect(await classifyEmbedRecord(record({ subpath }), "", deps(vaultWith()))).toBe("absent");
	});

	it.each(KINDS)("$kind: the key is in the host but the target note cannot be read: broken (E6)", async ({ subpath }) => {
		const vault = vaultWith();
		vault.unreadable.add("Source.md");
		expect(await classifyEmbedRecord(record({ subpath }), linkFor("Source.md", subpath), deps(vault))).toBe("broken");
	});

	it.each(KINDS.filter((k) => k.kind !== "whole-note"))("$kind: the key is in the host but the block id or heading is gone from the target: broken (E6)", async ({ subpath }) => {
		const vault = vaultWith({ "Source.md": "# Source\n\n- [ ] nothing with that id or heading\n" });
		expect(await classifyEmbedRecord(record({ subpath }), linkFor("Source.md", subpath), deps(vault))).toBe("broken");
	});

	it("a retargeted second identical embed: only the second key is absent (E1)", async () => {
		const host = `${linkFor("Source.md", "^0169a6")}\n\n${linkFor("Source.md", "^zzz999")}\n`;
		const first = record({ occurrence: 0 });
		const second = record({ occurrence: 1 });
		expect(await classifyEmbedRecord(first, host, deps(vaultWith()))).toBe("live");
		expect(await classifyEmbedRecord(second, host, deps(vaultWith()))).toBe("absent");
	});

	it("a nested embed is absent when the outer link is retargeted, live when it is not, broken when the inner target is gone", async () => {
		const nestedRecord = record({ target: "Source.md", subpath: "^0169a6", outer: [{ target: "Lessons.md", subpath: "", occurrence: 0 }] });
		const vault = vaultWith({ "Lessons.md": `${linkFor("Source.md", "^0169a6")}\n` });
		expect(await classifyEmbedRecord(nestedRecord, "![[Lessons]]\n", deps(vault))).toBe("live");
		expect(await classifyEmbedRecord(nestedRecord, "![[Other]]\n", deps(vault))).toBe("absent");
		vault.notes.set("Lessons.md", `${linkFor("Other.md", "")}\n`);
		expect(await classifyEmbedRecord(nestedRecord, "![[Lessons]]\n", deps(vault))).toBe("absent");
		vault.notes.set("Lessons.md", `${linkFor("Source.md", "^0169a6")}\n`);
		vault.unreadable.add("Source.md");
		expect(await classifyEmbedRecord(nestedRecord, "![[Lessons]]\n", deps(vault))).toBe("broken");
	});
});

describe("EmbedDormancyTracker.reconcileHost: reads only, and only for records that exist (E12)", () => {
	function fakeStore(records: EmbedFoldRecord[]) {
		const calls: { host: string; verdicts: (EmbedPresence | undefined)[] }[] = [];
		return {
			calls,
			store: {
				embedRecordsForHost: (host: string) => records.filter((r) => r.host === host),
				reconcileEmbedDormancy: (host: string, presenceOf: (r: EmbedFoldRecord) => EmbedPresence | undefined) => {
					calls.push({ host, verdicts: records.filter((r) => r.host === host).map(presenceOf) });
					return { stamped: 0, revived: 0, forgotten: 0 };
				},
			},
		};
	}

	it("a host with no record reads nothing and reconciles nothing (typing a link creates no state)", async () => {
		const { store, calls } = fakeStore([]);
		const reads: string[] = [];
		const tracker = new EmbedDormancyTracker({ store, readNote: async (p) => (reads.push(p), "x"), resolveLink: () => null });
		await tracker.reconcileHost("Host.md", "![[Source#^0169a6]]\n");
		expect(reads).toEqual([]);
		expect(calls).toEqual([]);
	});

	it("reports each record of the host by its own key", async () => {
		const { store, calls } = fakeStore([record({ occurrence: 0 }), record({ occurrence: 1 })]);
		const tracker = new EmbedDormancyTracker({ store, ...deps(vaultWith()) });
		await tracker.reconcileHost("Host.md", `${linkFor("Source.md", "^0169a6")}\n\n${linkFor("Source.md", "^zzz999")}\n`);
		expect(calls).toEqual([{ host: "Host.md", verdicts: ["live", "absent"] }]);
	});

	it("when a note cannot be read because the reader throws, nothing is reported (a record is never changed on a guess)", async () => {
		const { store, calls } = fakeStore([record()]);
		const tracker = new EmbedDormancyTracker({
			store,
			readNote: async () => {
				throw new Error("disk");
			},
			resolveLink: () => "Source.md",
		});
		const spy = console.error;
		console.error = () => undefined;
		try {
			await tracker.reconcileHost("Host.md", linkFor("Source.md", "^0169a6"));
		} finally {
			console.error = spy;
		}
		expect(calls).toEqual([]);
	});
});

describe("EmbedDormancyTracker.reconcileHost: a heading link waits before its record is stamped (PR-8 R1)", () => {
	function fakeStore(records: EmbedFoldRecord[]) {
		const verdicts: (EmbedPresence | undefined)[][] = [];
		return {
			verdicts,
			store: {
				embedRecordsForHost: (host: string) => records.filter((r) => r.host === host),
				reconcileEmbedDormancy: (host: string, presenceOf: (r: EmbedFoldRecord) => EmbedPresence | undefined) => {
					verdicts.push(records.filter((r) => r.host === host).map(presenceOf));
					return { stamped: 0, revived: 0, forgotten: 0 };
				},
			},
		};
	}
	const headingRecord = (over: Partial<EmbedFoldRecord> = {}): EmbedFoldRecord => record({ subpath: "Chapter Two", ...over });
	const renamedText = "![[Source#Chapter Two (revised)]]\n";

	it("a heading-linked record seen absent is not assessed until the wait is over, then it is stamped", async () => {
		let now = T0;
		const { store, verdicts } = fakeStore([headingRecord()]);
		const tracker = new EmbedDormancyTracker({ store, ...deps(vaultWith()), now: () => now });

		expect(await tracker.reconcileHost("Host.md", renamedText)).toEqual({ deferred: 1 });
		now = T0 + HEADING_RENAME_GRACE_MS - 1;
		expect(await tracker.reconcileHost("Host.md", renamedText)).toEqual({ deferred: 1 });
		now = T0 + HEADING_RENAME_GRACE_MS;
		expect(await tracker.reconcileHost("Host.md", renamedText)).toEqual({ deferred: 0 });
		expect(verdicts).toEqual([[undefined], [undefined], ["absent"]]);
	});

	it("a heading-linked record seen broken waits the same way", async () => {
		const vault = vaultWith();
		vault.unreadable.add("Source.md");
		const { store, verdicts } = fakeStore([headingRecord()]);
		const tracker = new EmbedDormancyTracker({ store, ...deps(vault), now: () => T0 });
		expect(await tracker.reconcileHost("Host.md", "![[Source#Chapter Two]]\n")).toEqual({ deferred: 1 });
		expect(verdicts).toEqual([[undefined]]);
	});

	it("a block embed and a whole-note embed are stamped at once, and so is a heading record when the wait is off", async () => {
		for (const [records, options] of [
			[[record({ subpath: "^0169a6" })], {}],
			[[record({ subpath: "" })], {}],
			[[headingRecord()], { headingGraceMs: 0 }],
		] as const) {
			const { store, verdicts } = fakeStore([...records]);
			const tracker = new EmbedDormancyTracker({ store, ...deps(vaultWith()), now: () => T0, ...options });
			expect(await tracker.reconcileHost("Host.md", "![[Other]]\n")).toEqual({ deferred: 0 });
			expect(verdicts).toEqual([["absent"]]);
		}
	});

	it("a nested record with a heading link in its chain waits too", async () => {
		const nested = record({ subpath: "^0169a6", outer: [{ target: "Source.md", subpath: "Chapter Two", occurrence: 0 }] });
		const { store, verdicts } = fakeStore([nested]);
		const tracker = new EmbedDormancyTracker({ store, ...deps(vaultWith()), now: () => T0 });
		expect(await tracker.reconcileHost("Host.md", renamedText)).toEqual({ deferred: 1 });
		expect(verdicts).toEqual([[undefined]]);
	});

	it("the wait starts again when the embed was live in between, and an already stamped record is not held", async () => {
		let now = T0;
		const { store, verdicts } = fakeStore([headingRecord()]);
		const tracker = new EmbedDormancyTracker({ store, ...deps(vaultWith()), now: () => now });
		await tracker.reconcileHost("Host.md", renamedText);
		now = T0 + 6000;
		await tracker.reconcileHost("Host.md", "![[Source#Chapter Two]]\n"); // back
		now = T0 + HEADING_RENAME_GRACE_MS + 1;
		expect(await tracker.reconcileHost("Host.md", renamedText)).toEqual({ deferred: 1 }); // not 10 s since the first sighting
		expect(verdicts).toEqual([[undefined], ["live"], [undefined]]);

		const stamped = fakeStore([headingRecord({ dormantSince: T0 })]);
		const later = new EmbedDormancyTracker({ store: stamped.store, ...deps(vaultWith()), now: () => T0 });
		expect(await later.reconcileHost("Host.md", renamedText)).toEqual({ deferred: 0 });
		expect(stamped.verdicts).toEqual([["absent"]]);
	});
});

// --- Dormant folds inside a live embed (G14, G16, E7, E8) ------------------------------------------

const SLICE_TEXT = sliceEmbed(SOURCE_TEXT, "")?.text ?? "";
const SLICE_HASH = sliceEmbed(SOURCE_TEXT, "")?.hash ?? "";
const CANDIDATES = buildAnchors(SLICE_TEXT);
const lesson8Block = CANDIDATES.find((b) => b.anchor.text.startsWith("lesson 8"));
const chapterBlock = CANDIDATES.find((b) => b.anchor.kind === "heading");

function asStored(anchor: Anchor, since?: number): StoredAnchor {
	return (since === undefined ? anchor : { ...anchor, dormantSince: since }) as unknown as StoredAnchor;
}

const yieldNow = (): void => undefined;
const pass = (rec: EmbedFoldRecord | undefined, now: number, over: Partial<Parameters<typeof planEmbedPass>[0]> = {}) =>
	planEmbedPass({ record: rec, sliceHash: SLICE_HASH, candidates: CANDIDATES, budget: new HostComparisonBudget(), yieldToHost: yieldNow, now, ...over });

describe("planEmbedPass: a fold with no confident match goes dormant, then is retried (G14)", () => {
	const unmatched = parseAnchor({ kind: "task", indent: 0, text: "zebra migration patterns", siblingIndex: 0, parentChain: [] }) as Anchor;

	it("sanity: the fixture has the blocks the tests rely on", () => {
		expect(lesson8Block).toBeDefined();
		expect(chapterBlock).toBeDefined();
	});

	it("an unmatched fold leaves folds and becomes dormant, stamped now; the matched one stays", async () => {
		const rec = record({ subpath: "", contentHash: "old", folds: [asStored(lesson8Block!.anchor), asStored(unmatched)] });
		const out = await pass(rec, T0);
		expect(out.update?.folds).toEqual([lesson8Block!.anchor]);
		expect(out.update?.dormant).toEqual([{ ...unmatched, dormantSince: T0 }]);
		expect(out.update?.contentHash).toBe(SLICE_HASH);
	});

	it("only a stored fold can become dormant: a record-less embed writes nothing and a block with no fold is never added (E12, G16)", async () => {
		expect((await pass(undefined, T0)).update).toBeNull();
		const empty = await pass(record({ subpath: "", folds: [], contentHash: SLICE_HASH }), T0);
		expect(empty.update).toBeNull();
		expect(empty.matches).toEqual([]);
	});

	it("the clock never restarts: a repeated no-match keeps the original dormantSince", async () => {
		const rec = record({ subpath: "", contentHash: SLICE_HASH, folds: [], dormant: [asStored(unmatched, T0)] });
		const out = await pass(rec, T0 + 599_999);
		expect(out.update).toBeNull(); // nothing changed, and the stamp is T0
		expect(out.matches.every((m) => m.tier === "none")).toBe(true);
	});

	it("a dormant entry 600,000 ms old is forgotten, 599,999 ms old is not", async () => {
		const rec = record({ subpath: "", contentHash: SLICE_HASH, folds: [], dormant: [asStored(unmatched, T0)] });
		expect((await pass(rec, T0 + 599_999)).update).toBeNull();
		const gone = await pass(rec, T0 + 600_000);
		expect(gone.update?.dormant).toEqual([]);
	});

	it("a dormant anchor that now matches is promoted: it joins folds, leaves dormant, and is reported as a match to fold", async () => {
		const rec = record({ subpath: "", contentHash: "old", folds: [], dormant: [asStored(lesson8Block!.anchor, T0)] });
		const out = await pass(rec, T0 + 1000);
		expect(out.promoted).toBe(1);
		expect(out.update?.folds).toEqual([lesson8Block!.anchor]);
		expect(out.update?.dormant).toEqual([]);
		const target = out.matches.map((m, i) => ({ m, i })).find(({ m }) => (m.tier as string) !== "none");
		expect(target && target.m.tier !== "none" ? CANDIDATES[(target.m as { target: number }).target] : undefined).toBe(lesson8Block);
	});

	it("a dormant anchor that matches does so even if it is a revised version of the line (same matcher, same thresholds)", async () => {
		const revised = { ...lesson8Block!.anchor, text: "lesson 8 (revised): collections and frequency counting ^0169a6" };
		const rec = record({ subpath: "", contentHash: "old", folds: [], dormant: [asStored(revised, T0)] });
		const out = await pass(rec, T0 + 1000);
		expect(out.promoted).toBe(1);
		expect(out.update?.folds).toEqual([lesson8Block!.anchor]);
	});

	it("one fold only: a dormant anchor whose block an active fold already holds is dropped (dropDormantClaimedByActive)", async () => {
		const rec = record({ subpath: "", contentHash: SLICE_HASH, folds: [asStored(lesson8Block!.anchor)], dormant: [asStored(lesson8Block!.anchor, T0)] });
		const out = await pass(rec, T0 + 1000);
		expect(out.droppedClaimed).toBe(1);
		expect(out.promoted).toBe(0);
		expect(out.update?.folds).toEqual([lesson8Block!.anchor]);
		expect(out.update?.dormant).toEqual([]);
		expect(out.matches.filter((m) => m.tier !== "none")).toHaveLength(1);
	});

	it("a dormant anchor that matches nothing, active or not, stays dormant beside an unrelated active fold", async () => {
		const rec = record({ subpath: "", contentHash: SLICE_HASH, folds: [asStored(lesson8Block!.anchor)], dormant: [asStored(unmatched, T0)] });
		const out = await pass(rec, T0 + 1000);
		expect(out.droppedClaimed).toBe(0);
		expect(out.update).toBeNull();
	});

	it.each([
		{ label: "missing dormantSince", entry: { ...unmatched } },
		{ label: "negative dormantSince", entry: { ...unmatched, dormantSince: -5 } },
		{ label: "non-numeric dormantSince", entry: { ...unmatched, dormantSince: "soon" } },
		{ label: "NaN dormantSince", entry: { ...unmatched, dormantSince: Number.NaN } },
		{ label: "not an anchor at all", entry: { dormantSince: T0 } },
		{ label: "a string", entry: "lesson 8" },
		{ label: "null", entry: null },
	])("a malformed dormant entry ($label) is dropped without throwing", async ({ entry }) => {
		const rec = record({ subpath: "", contentHash: SLICE_HASH, folds: [asStored(lesson8Block!.anchor)], dormant: [entry as unknown as StoredAnchor] });
		const out = await pass(rec, T0);
		expect(out.update?.dormant).toEqual([]);
		expect(out.update?.folds).toEqual([lesson8Block!.anchor]);
	});
});

describe("planEmbedPass: caps and budget keep stored entries (E7)", () => {
	const second = chapterBlock!.anchor;

	it("folds beyond the per-embed cap are kept as stored, not made dormant", async () => {
		const rec = record({ subpath: "", contentHash: "old", folds: [asStored(lesson8Block!.anchor), asStored(second)] });
		const out = await pass(rec, T0, { matcherOptions: { maxFolds: 1 } });
		expect(out.update?.dormant ?? []).toEqual([]);
		expect(out.update?.folds ?? rec.folds).toHaveLength(2);
	});

	it("with the host budget spent, nothing is placed, nothing goes dormant and the record is not changed", async () => {
		const budget = new HostComparisonBudget(0);
		const unmatched = { kind: "task", indent: 0, text: "zebra migration patterns", siblingIndex: 0, parentChain: [] };
		const rec = record({ subpath: "", contentHash: "old", folds: [asStored(lesson8Block!.anchor), asStored(unmatched as unknown as Anchor)], dormant: [asStored(second, T0)] });
		const out = await pass(rec, T0 + 1000, { budget });
		expect(out.budgetExhausted).toBe(true);
		expect(out.update).toBeNull();
	});

	it("the retry draws on the same budget as the active re-match and yields to the host between chunks", async () => {
		const budget = new HostComparisonBudget();
		let yields = 0;
		const unmatched = { kind: "task", indent: 0, text: "zebra migration patterns", siblingIndex: 0, parentChain: [] };
		const rec = record({ subpath: "", contentHash: "old", folds: [], dormant: [asStored(unmatched as unknown as Anchor, T0), asStored(second, T0)] });
		await pass(rec, T0, { budget, yieldToHost: () => void yields++, matcherOptions: { chunkSize: 1 } });
		expect(budget.remaining).toBeLessThan(budget.total);
		expect(yields).toBeGreaterThan(0);
	});
});

describe("rename guard: the dormancy step is one function that no rename handler calls (G9, PR-8)", () => {
	const src = (name: string): string => readFileSync(join(__dirname, "..", "..", "src", name), "utf8");
	const code = (name: string): string => src(name).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

	it("the store exposes the step once, as reconcileEmbedDormancy", () => {
		expect(code("fold-store.ts").match(/\breconcileEmbedDormancy\s*\(/g)).toHaveLength(1);
		expect(code("fold-store.ts").match(/\bnextEmbedDormancy\s*\(/g)).toHaveLength(1);
	});

	it("handleRename, handleDelete and pruneOrphans never reach it", () => {
		const text = code("fold-store.ts");
		for (const name of ["handleRename", "handleDelete", "pruneOrphans"]) {
			const start = text.indexOf(`${name}(`);
			expect(start, name).toBeGreaterThan(-1);
			const body = text.slice(start, text.indexOf("\n\t}\n", start));
			expect(body, name).not.toMatch(/reconcileEmbedDormancy|nextEmbedDormancy|dormantSince/);
		}
	});

	it("main.ts's vault rename and delete handlers never reach it", () => {
		const text = code("main.ts");
		for (const event of ["rename", "delete"]) {
			const start = text.indexOf(`vault.on("${event}"`);
			expect(start, event).toBeGreaterThan(-1);
			const body = text.slice(start, text.indexOf("})", start));
			expect(body, event).not.toMatch(/dormancy|reconcile/i);
		}
	});

	it("the only callers of the host reconcile are the restore pass and the file-open handler (via reconcileOnOpen)", () => {
		const callers = ["main.ts", "embed-fold-restorer.ts", "embed-fold-recorder.ts", "vault-lifecycle.ts", "fold-restorer.ts", "open-restore.ts"].filter((name) =>
			/\.reconcile(Host|OnOpen)\s*\(/.test(code(name))
		);
		expect(callers.sort()).toEqual(["embed-fold-restorer.ts", "main.ts"]);
	});
});
