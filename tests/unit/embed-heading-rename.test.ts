/**
 * EmbedHeadingRenameTracker's memory and cost on a vault re-index (PR-8 R3, R5) and the baseline
 * for a heading embed's target (PR-8 R2). The tracker is driven with explicit metadata events and
 * a fake store that counts how often the records are read.
 */
import { describe, expect, it, vi } from "vitest";
import { EmbedHeadingRenameTracker, headingTargetsOf } from "../../src/embed-heading-rename";
import type { EmbedFoldRecord } from "../../src/types";

const HOST = "Course.md";
const SOURCE = "Lessons.md";
const BEFORE = [
	{ heading: "Intro", level: 1 },
	{ heading: "Lesson 8", level: 2 },
];
const AFTER = [
	{ heading: "Intro", level: 1 },
	{ heading: "Lesson 8 (revised)", level: 2 },
];

const record = (subpath: string, target = SOURCE, host = HOST): EmbedFoldRecord => ({ host, target, subpath, occurrence: 0, contentHash: "h", folds: [], dormant: [] });

function rig(records: EmbedFoldRecord[] = [record("Lesson 8")], withRevision = true) {
	let revision = 1;
	const embedRecords = vi.fn(() => [...records]);
	const migrateEmbedHeading = vi.fn(() => 1);
	const tracker = new EmbedHeadingRenameTracker({
		store: { embedRecords, migrateEmbedHeading, ...(withRevision ? { embedRevision: () => revision } : {}) },
		resolveLink: (linktext) => (linktext === "Lessons" ? SOURCE : null),
		now: () => 1000,
	});
	return { tracker, records, embedRecords, migrateEmbedHeading, bump: () => revision++ };
}

describe("heading baselines are kept only for notes that need one (PR-8 R3)", () => {
	it("a re-index of many unrelated notes remembers none of them", () => {
		const { tracker } = rig();
		for (let i = 0; i < 500; i++) tracker.onChanged(`Note ${i}.md`, { headings: BEFORE, embeds: [{ link: "Elsewhere" }] });
		expect(tracker.baselineCount()).toBe(0);
	});

	it("a stored heading embed's target gets a baseline from its first event, and a later rename is then noticed", () => {
		const { tracker, migrateEmbedHeading } = rig();
		tracker.onChanged(SOURCE, { headings: BEFORE }); // the re-index at startup, no file-open yet
		expect(tracker.baselineCount()).toBe(1);

		tracker.onChanged(SOURCE, { headings: AFTER });
		tracker.onChanged(HOST, { embeds: [{ link: "Lessons#Lesson 8 (revised)" }] });
		expect(migrateEmbedHeading).toHaveBeenCalledWith({ source: HOST, target: SOURCE, from: "Lesson 8", to: "Lesson 8 (revised)" });
	});

	it("a note that was opened or seeded keeps its baseline up to date even if no embed names it", () => {
		const { tracker } = rig();
		tracker.seed("Opened.md", { headings: BEFORE });
		tracker.onChanged("Opened.md", { headings: AFTER });
		expect(tracker.baselineCount()).toBe(1);
	});
});

describe("the index of stored heading links is rebuilt only when the records change (PR-8 R5)", () => {
	it("a re-index of many notes with embeds reads the records once", () => {
		const { tracker, embedRecords } = rig();
		for (let i = 0; i < 500; i++) tracker.onChanged(`Note ${i}.md`, { embeds: [{ link: "Lessons#Lesson 8" }] });
		expect(embedRecords.mock.calls.length).toBeLessThanOrEqual(1);
	});

	it("notes whose embeds name no heading read the records at most once, for the index", () => {
		const { tracker, embedRecords } = rig();
		for (let i = 0; i < 500; i++) tracker.onChanged(`Note ${i}.md`, { embeds: [{ link: "Lessons" }, { link: "Lessons|300" }] });
		expect(embedRecords.mock.calls.length).toBeLessThanOrEqual(1);
	});

	it("a changed store revision rebuilds the index: a record added later makes its target worth a baseline", () => {
		const { tracker, records, bump } = rig([]);
		tracker.onChanged(SOURCE, { headings: BEFORE });
		expect(tracker.baselineCount()).toBe(0);

		records.push(record("Lesson 8"));
		bump();
		tracker.onChanged(SOURCE, { headings: BEFORE });
		expect(tracker.baselineCount()).toBe(1);
	});

	it("a store without a revision still works, reading the records each time", () => {
		const { tracker } = rig([record("Lesson 8")], false);
		tracker.onChanged(SOURCE, { headings: BEFORE });
		expect(tracker.baselineCount()).toBe(1);
		expect(tracker.storedHeadingTargets()).toEqual([SOURCE]);
	});
});

describe("headingTargetsOf (PR-8 R2: the notes to give a baseline when a record is created)", () => {
	it("names the target of a heading embed, and of every heading link in its chain", () => {
		const nested: EmbedFoldRecord = { ...record("Section"), target: "C.md", outer: [{ target: "B.md", subpath: "Part", occurrence: 0 }] };
		expect(headingTargetsOf(nested)).toEqual(["B.md", "C.md"]);
	});

	it("names nothing for a block or whole-note embed", () => {
		expect(headingTargetsOf(record("^abc123"))).toEqual([]);
		expect(headingTargetsOf(record(""))).toEqual([]);
	});
});
