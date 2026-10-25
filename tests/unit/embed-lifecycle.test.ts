/**
 * PR-8 (ticket warkworth-21): coverage of `src/embed-lifecycle.ts`: the pure rename (G10), delete
 * (G11), prune-at-load and heading-rename (G17) rules for embed records, the discrimination rule
 * between a heading rename Obsidian performed and a hand edit, and the E15 occurrence rule. Every
 * case calls the real functions with explicit inputs on deep-frozen data, so a rule that mutated its
 * input would throw.
 */
import { describe, expect, it } from "vitest";
import {
	deleteEmbeds,
	embedsTouchPath,
	headingRenameSubpath,
	isWithinPath,
	migrateEmbedHeading,
	pruneOrphanEmbeds,
	remapPath,
	renameEmbeds,
} from "../../src/embed-lifecycle";
import type { HeadingEntry } from "../../src/embed-lifecycle";
import type { EmbedFoldRecord } from "../../src/types";

const FOLD = { kind: "task", indent: 0, text: "lesson 8", siblingIndex: 0, parentChain: [] };
const DORMANT = { kind: "task", indent: 2, text: "old child", siblingIndex: 1, parentChain: ["lesson 8"], dormantSince: 5_000 };

/** A plain embed record, with a distinct hash so a test can tell which record it is looking at. */
function record(host: string, target: string, subpath: string, occurrence = 0, contentHash = `${host}>${target}${subpath}#${occurrence}`): EmbedFoldRecord {
	return { host, target, subpath, occurrence, contentHash, folds: [FOLD], dormant: [DORMANT] };
}

/** A nested embed: `outer` is the chain of containing embeds (target, subpath, occurrence). */
function nested(host: string, outer: [string, string, number][], target: string, subpath: string, occurrence = 0): EmbedFoldRecord {
	return {
		...record(host, target, subpath, occurrence, `nested ${host}>${outer.map((l) => l[0]).join(">")}>${target}`),
		outer: outer.map(([t, s, o]) => ({ target: t, subpath: s, occurrence: o })),
	};
}

/** Deep-freezes `value`: any rule that mutates its input throws in strict mode. */
function frozen<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) frozen(child);
	}
	return value;
}

describe("remapPath / isWithinPath: full path-segment prefix", () => {
	const cases: [string, string, string, string][] = [
		["Projects/Quarry/Tasks.md", "Projects/Quarry", "Archive/Quarry", "Archive/Quarry/Tasks.md"],
		["Projects/Quarry", "Projects/Quarry", "Archive/Quarry", "Archive/Quarry"],
		["Projects/Quarry2024/Tasks.md", "Projects/Quarry", "Archive/Quarry", "Projects/Quarry2024/Tasks.md"],
		["Projects/Quarry.md", "Projects/Quarry", "Archive/Quarry", "Projects/Quarry.md"],
		["Other.md", "", "X", "Other.md"],
	];
	it.each(cases)("%s under %s -> %s", (path, oldPath, newPath, expected) => {
		expect(remapPath(path, oldPath, newPath)).toBe(expected);
	});
	it("isWithinPath matches the path itself and its children only", () => {
		expect(isWithinPath("A/B.md", "A")).toBe(true);
		expect(isWithinPath("A", "A")).toBe(true);
		expect(isWithinPath("AB/C.md", "A")).toBe(false);
		expect(isWithinPath("A/B.md", "")).toBe(false);
	});
});

describe("renameEmbeds (G10)", () => {
	const HOST = "Projects/Course.md";
	const SOURCE = "Projects/Source.md";

	it("host rename: every record of that host is re-keyed; target fields, occurrence, folds, hash and dormant carry over; the old host survives nowhere", () => {
		const before = frozen([record(HOST, SOURCE, "^a1"), record(HOST, SOURCE, "Lesson 8", 0), record(HOST, "Whole.md", "", 2), record("Other.md", SOURCE, "^a1")]);
		const after = renameEmbeds(before, HOST, "Projects/Course Q4.md");
		expect(after.map((r) => [r.host, r.target, r.subpath, r.occurrence])).toEqual([
			["Projects/Course Q4.md", SOURCE, "^a1", 0],
			["Projects/Course Q4.md", SOURCE, "Lesson 8", 0],
			["Projects/Course Q4.md", "Whole.md", "", 2],
			["Other.md", SOURCE, "^a1", 0],
		]);
		expect(after.map((r) => r.contentHash)).toEqual(before.map((r) => r.contentHash));
		expect(after[0].folds).toEqual([FOLD]);
		expect(after[0].dormant).toEqual([DORMANT]);
		expect(JSON.stringify(after)).not.toContain(`"host":"${HOST}"`);
		expect(after[3]).toBe(before[3]); // untouched records come back as the same object
	});

	it("host moved to another folder", () => {
		const after = renameEmbeds([record(HOST, SOURCE, "^a1")], HOST, "Archive/Course.md");
		expect(after.map((r) => r.host)).toEqual(["Archive/Course.md"]);
	});

	it("target rename: every record, in every host, whose target is that note is re-keyed; subpath and occurrence untouched; the host is unaffected", () => {
		const before = frozen([record(HOST, SOURCE, "^a1", 1), record("Other.md", SOURCE, "Lesson 8"), record("Other.md", SOURCE, ""), record(HOST, "Whole.md", "")]);
		const after = renameEmbeds(before, SOURCE, "Projects/Source v2.md");
		expect(after.map((r) => [r.host, r.target, r.subpath, r.occurrence])).toEqual([
			[HOST, "Projects/Source v2.md", "^a1", 1],
			["Other.md", "Projects/Source v2.md", "Lesson 8", 0],
			["Other.md", "Projects/Source v2.md", "", 0],
			[HOST, "Whole.md", "", 0],
		]);
		expect(after[3]).toBe(before[3]);
	});

	it("a note embedding its own heading (host === target) has both fields updated", () => {
		const after = renameEmbeds(frozen([record("Self.md", "Self.md", "Intro")]), "Self.md", "Self 2.md");
		expect(after.map((r) => [r.host, r.target])).toEqual([["Self 2.md", "Self 2.md"]]);
	});

	describe("folder rename or move", () => {
		it("re-keys host and target paths nested beneath the folder, and a record with both under it has both fields updated in one pass", () => {
			const before = frozen([
				record("Projects/Quarry/Course.md", "Projects/Quarry/Sub/Source.md", "^a1"),
				record("Projects/Quarry/Course.md", "Resources/Source.md", "^a1"),
				record("Home.md", "Projects/Quarry/Sub/Source.md", "Lesson 8"),
				record("Home.md", "Resources/Source.md", "^a1"),
			]);
			const after = renameEmbeds(before, "Projects/Quarry", "Archive/Quarry");
			expect(after.map((r) => [r.host, r.target])).toEqual([
				["Archive/Quarry/Course.md", "Archive/Quarry/Sub/Source.md"],
				["Archive/Quarry/Course.md", "Resources/Source.md"],
				["Home.md", "Archive/Quarry/Sub/Source.md"],
				["Home.md", "Resources/Source.md"],
			]);
		});

		it("matches on a full path segment: Projects/Quarry does not match Projects/Quarry2024", () => {
			const before = frozen([record("Projects/Quarry2024/Course.md", "Projects/Quarry2024/Source.md", "^a1"), record("Projects/Quarry.md", "Projects/Quarry-notes.md", "")]);
			const after = renameEmbeds(before, "Projects/Quarry", "Archive/Quarry");
			expect(after).toEqual(before);
			after.forEach((r, i) => expect(r).toBe(before[i]));
		});
	});

	describe("nested chain: a rename of the host, of any intermediate note, or of the innermost target re-keys the record", () => {
		const chain = (): EmbedFoldRecord =>
			nested("Host.md", [["Outer.md", "Section", 0], ["Middle.md", "^m1", 1]], "Inner.md", "^i1", 2);
		const cases: [string, string, string, unknown][] = [
			["host", "Host.md", "Host 2.md", { host: "Host 2.md", chain: ["Outer.md", "Middle.md"], target: "Inner.md" }],
			["first containing note", "Outer.md", "Outer 2.md", { host: "Host.md", chain: ["Outer 2.md", "Middle.md"], target: "Inner.md" }],
			["intermediate note", "Middle.md", "Middle 2.md", { host: "Host.md", chain: ["Outer.md", "Middle 2.md"], target: "Inner.md" }],
			["innermost target", "Inner.md", "Inner 2.md", { host: "Host.md", chain: ["Outer.md", "Middle.md"], target: "Inner 2.md" }],
		];
		it.each(cases)("%s", (_label, from, to, expected) => {
			const before = frozen([chain()]);
			const [after] = renameEmbeds(before, from, to);
			expect({ host: after.host, chain: (after.outer ?? []).map((l) => l.target), target: after.target }).toEqual(expected);
			// The order, subpaths and occurrences of the chain, and the record's own fields, are kept.
			expect((after.outer ?? []).map((l) => [l.subpath, l.occurrence])).toEqual([["Section", 0], ["^m1", 1]]);
			expect([after.subpath, after.occurrence]).toEqual(["^i1", 2]);
		});
	});

	describe("collision", () => {
		it("a rename onto an embed key that already has a record replaces it, and the old key never survives", () => {
			const moving = record("A.md", "Source.md", "^a1", 0, "moving");
			const existing = record("B.md", "Source.md", "^a1", 0, "existing");
			const bystander = record("C.md", "Source.md", "^a1", 0, "bystander");
			const after = renameEmbeds(frozen([existing, moving, bystander]), "A.md", "B.md");
			expect(after.map((r) => [r.host, r.contentHash])).toEqual([["B.md", "moving"], ["C.md", "bystander"]]);
		});

		it("holds in either order of the two records", () => {
			const after = renameEmbeds(frozen([record("A.md", "S.md", "", 0, "moving"), record("B.md", "S.md", "", 0, "existing")]), "A.md", "B.md");
			expect(after.map((r) => [r.host, r.contentHash])).toEqual([["B.md", "moving"]]);
		});

		it("a different occurrence index at the destination is a different key and both survive", () => {
			const after = renameEmbeds(frozen([record("A.md", "S.md", "", 0), record("B.md", "S.md", "", 1)]), "A.md", "B.md");
			expect(after.map((r) => [r.host, r.occurrence])).toEqual([["B.md", 0], ["B.md", 1]]);
		});
	});

	describe("a miss is a no-op that never throws", () => {
		it.each([
			["nothing matches the old path", "Nowhere.md", "Elsewhere.md"],
			["old path equals new path", HOST, HOST],
			["empty old path", "", "X.md"],
		])("%s", (_label, from, to) => {
			const before = frozen([record(HOST, SOURCE, "^a1")]);
			const after = renameEmbeds(before, from, to);
			expect(after).toEqual(before);
			expect(after[0]).toBe(before[0]);
		});
		it("an empty list", () => {
			expect(renameEmbeds([], "A.md", "B.md")).toEqual([]);
		});
	});

	it("E15: renaming a host does not renumber occurrence indices", () => {
		const after = renameEmbeds(frozen([record(HOST, SOURCE, "^a1", 0, "first"), record(HOST, SOURCE, "^a1", 1, "second")]), HOST, "Renamed.md");
		expect(after.map((r) => [r.host, r.occurrence, r.contentHash])).toEqual([["Renamed.md", 0, "first"], ["Renamed.md", 1, "second"]]);
	});

	it("a dormancy stamp is carried over, not cleared", () => {
		const stamped = { ...record(HOST, SOURCE, "^a1"), dormantSince: 123 };
		expect(renameEmbeds([stamped], HOST, "New.md")[0].dormantSince).toBe(123);
	});
});

describe("deleteEmbeds (G11)", () => {
	const records = () =>
		frozen([
			record("Course.md", "Source.md", "^a1"),
			record("Other.md", "Source.md", "Lesson 8"),
			record("Other.md", "Whole.md", ""),
			nested("Host.md", [["Middle.md", "", 0]], "Inner.md", "^i1"),
			record("Folder/Host.md", "Folder/Sub/Source.md", ""),
			record("Folder2/Host.md", "Folder2/Source.md", ""),
		]);

	it("deleting a host removes every record for that host, and no other", () => {
		expect(deleteEmbeds(records(), "Other.md").map((r) => r.host)).toEqual(["Course.md", "Host.md", "Folder/Host.md", "Folder2/Host.md"]);
	});

	it("deleting a target removes every record, in every host, that points at it", () => {
		expect(deleteEmbeds(records(), "Source.md").map((r) => [r.host, r.target])).toEqual([
			["Other.md", "Whole.md"],
			["Host.md", "Inner.md"],
			["Folder/Host.md", "Folder/Sub/Source.md"],
			["Folder2/Host.md", "Folder2/Source.md"],
		]);
	});

	it("deleting an intermediate note of a nested chain, or its innermost target, removes the record", () => {
		expect(deleteEmbeds(records(), "Middle.md").map((r) => r.host)).not.toContain("Host.md");
		expect(deleteEmbeds(records(), "Inner.md").map((r) => r.host)).not.toContain("Host.md");
	});

	it("deleting a folder removes host and target records beneath it, by full path segment (Folder does not match Folder2)", () => {
		expect(deleteEmbeds(records(), "Folder").map((r) => r.host)).toEqual(["Course.md", "Other.md", "Other.md", "Host.md", "Folder2/Host.md"]);
	});

	it("a miss returns the same records and never throws", () => {
		const before = records();
		const after = deleteEmbeds(before, "Nowhere.md");
		expect(after).toEqual(before);
		after.forEach((r, i) => expect(r).toBe(before[i]));
		expect(deleteEmbeds([], "A.md")).toEqual([]);
		expect(deleteEmbeds(before, "")).toEqual(before);
	});

	it("is removal, not dormancy: no record is returned stamped", () => {
		for (const r of deleteEmbeds(records(), "Source.md")) expect("dormantSince" in r).toBe(false);
	});
});

describe("pruneOrphanEmbeds (G10, outside Obsidian)", () => {
	const existing = new Set(["Course.md", "Source.md", "Outer.md", "Inner.md"]);
	const exists = (path: string): boolean => existing.has(path);

	it("keeps a record whose host and target both exist", () => {
		const before = frozen([record("Course.md", "Source.md", "^a1")]);
		expect(pruneOrphanEmbeds(before, exists)[0]).toBe(before[0]);
	});

	it.each([
		["host missing", record("Gone.md", "Source.md", "^a1")],
		["target missing", record("Course.md", "Gone.md", "^a1")],
		["a containing note in the chain missing", nested("Course.md", [["Gone.md", "", 0]], "Inner.md", "^i1")],
	])("drops a record when its %s", (_label, orphan) => {
		expect(pruneOrphanEmbeds(frozen([orphan, record("Course.md", "Source.md", "^a1")]), exists).map((r) => r.target)).toEqual(["Source.md"]);
	});

	it("keeps a nested record when the whole chain exists", () => {
		expect(pruneOrphanEmbeds([nested("Course.md", [["Outer.md", "", 0]], "Inner.md", "^i1")], exists)).toHaveLength(1);
	});

	it("an empty list stays empty", () => {
		expect(pruneOrphanEmbeds([], exists)).toEqual([]);
	});
});

describe("embedsTouchPath", () => {
	it("is true for host, target and chain notes, by path segment, and false otherwise", () => {
		const records = [nested("Host.md", [["Dir/Middle.md", "", 0]], "Inner.md", "")];
		expect(embedsTouchPath(records, "Host.md")).toBe(true);
		expect(embedsTouchPath(records, "Dir")).toBe(true);
		expect(embedsTouchPath(records, "Inner.md")).toBe(true);
		expect(embedsTouchPath(records, "Di")).toBe(false);
		expect(embedsTouchPath(records, "Nope.md")).toBe(false);
	});
});

const h = (text: string, level = 2): HeadingEntry => ({ text, level });

describe("headingRenameSubpath: the discrimination rule (G17)", () => {
	const base = [h("Intro", 1), h("Lesson 8"), h("Lesson 9"), h("Notes")];
	const revised = [h("Intro", 1), h("Lesson 8 (revised)"), h("Lesson 9"), h("Notes")];

	const cases: { label: string; before: HeadingEntry[]; after: HeadingEntry[]; stored: string; links: string[]; expected: string | null }[] = [
		{ label: "rename: one heading changed in place and the link was rewritten", before: base, after: revised, stored: "Lesson 8", links: ["Lesson 8 (revised)"], expected: "Lesson 8 (revised)" },
		{
			label: "rename of the first heading",
			before: base,
			after: [h("Start here", 1), h("Lesson 8"), h("Lesson 9"), h("Notes")],
			stored: "Intro",
			links: ["Start here"],
			expected: "Start here",
		},
		{
			label: "rename with other links in the note that still point at other headings",
			before: base,
			after: revised,
			stored: "Lesson 8",
			links: ["Lesson 9", "Lesson 8 (revised)", "Notes"],
			expected: "Lesson 8 (revised)",
		},
		{
			label: "rename of the parent segment of a nested subpath",
			before: [h("Part 1", 1), h("Lesson 8")],
			after: [h("Part One", 1), h("Lesson 8")],
			stored: "Part 1#Lesson 8",
			links: ["Part One#Lesson 8"],
			expected: "Part One#Lesson 8",
		},
		{
			label: "rename of the child segment of a nested subpath",
			before: [h("Part 1", 1), h("Lesson 8")],
			after: [h("Part 1", 1), h("Lesson eight")],
			stored: "Part 1#Lesson 8",
			links: ["Part 1#Lesson eight"],
			expected: "Part 1#Lesson eight",
		},
		{ label: "hand edit: the link names a different heading and the target still has the old one", before: base, after: base, stored: "Lesson 8", links: ["Lesson 9"], expected: null },
		{ label: "hand edit to a heading that does not exist at all", before: base, after: base, stored: "Lesson 8", links: ["Lesson 10"], expected: null },
		{
			label: "hand edit while an unrelated heading was renamed elsewhere in the target",
			before: base,
			after: [h("Intro", 1), h("Lesson 8"), h("Lesson 9"), h("Footnotes")],
			stored: "Lesson 8",
			links: ["Lesson 9"],
			expected: null,
		},
		{
			label: "delete-and-add: one heading deleted and another added elsewhere",
			before: base,
			after: [h("Intro", 1), h("Lesson 9"), h("Notes"), h("Lesson 8 (revised)")],
			stored: "Lesson 8",
			links: ["Lesson 8 (revised)"],
			expected: null,
		},
		{
			label: "delete: the heading is gone and the link points at a heading that was already there",
			before: base,
			after: [h("Intro", 1), h("Lesson 9"), h("Notes")],
			stored: "Lesson 8",
			links: ["Lesson 9"],
			expected: null,
		},
		{
			label: "ambiguous: two headings changed at once",
			before: base,
			after: [h("Intro", 1), h("Lesson 8 (revised)"), h("Lesson 9 (revised)"), h("Notes")],
			stored: "Lesson 8",
			links: ["Lesson 8 (revised)"],
			expected: null,
		},
		{
			label: "ambiguous: the old name is shared with another heading",
			before: [h("Notes"), h("Lesson 8"), h("Notes")],
			after: [h("Notes"), h("Lesson 8"), h("Remarks")],
			stored: "Notes",
			links: ["Remarks"],
			expected: null,
		},
		{
			label: "ambiguous: the new name is already another heading's",
			before: [h("Notes"), h("Lesson 8")],
			after: [h("Notes"), h("Notes")],
			stored: "Lesson 8",
			links: ["Notes"],
			expected: null,
		},
		{
			label: "ambiguous: two different links both look like the rewrite",
			before: base,
			after: revised,
			stored: "Lesson 8",
			links: ["Lesson 8 (revised)", "Lesson 8  (revised)"],
			expected: null,
		},
		{
			label: "the level changed along with the text",
			before: base,
			after: [h("Intro", 1), h("Lesson 8 (revised)", 3), h("Lesson 9"), h("Notes")],
			stored: "Lesson 8",
			links: ["Lesson 8 (revised)"],
			expected: null,
		},
		{ label: "the linking note still links the old heading, so it was not rewritten", before: base, after: revised, stored: "Lesson 8", links: ["Lesson 8", "Lesson 8 (revised)"], expected: null },
		{ label: "the link was changed to something other than the renamed heading's new text", before: base, after: revised, stored: "Lesson 8", links: ["Lesson 8 revised"], expected: null },
		{ label: "case-different heading: spellings compare exactly", before: base, after: revised, stored: "lesson 8", links: ["Lesson 8 (revised)"], expected: null },
		{ label: "case-different rewritten link: the link reads the new name in another case", before: base, after: revised, stored: "Lesson 8", links: ["lesson 8 (revised)"], expected: null },
		{
			label: "case-different heading renamed: the stored spelling is the old name in another case",
			before: [h("Intro", 1), h("lesson 8"), h("Lesson 9"), h("Notes")],
			after: [h("Intro", 1), h("lesson 8 (revised)"), h("Lesson 9"), h("Notes")],
			stored: "Lesson 8",
			links: ["lesson 8 (revised)"],
			expected: null,
		},
		{
			label: "similarly named heading: the stored name is a prefix of the renamed heading's",
			before: [h("Intro", 1), h("Lesson 8 and more"), h("Lesson 9")],
			after: [h("Intro", 1), h("Lesson 8 and beyond"), h("Lesson 9")],
			stored: "Lesson 8",
			links: ["Lesson 8 and beyond"],
			expected: null,
		},
		{
			label: "similarly named heading: the stored name differs by one character from the renamed heading's",
			before: [h("Intro", 1), h("Lesson 80"), h("Lesson 9")],
			after: [h("Intro", 1), h("Lesson 80 (revised)"), h("Lesson 9")],
			stored: "Lesson 8",
			links: ["Lesson 80 (revised)"],
			expected: null,
		},
		{ label: "similarly named heading: the other link still reads its own spelling beside the rewritten one", before: base, after: revised, stored: "Lesson 8", links: ["Lesson 8 (revised)", "Lesson 80", "lesson 8"], expected: "Lesson 8 (revised)" },
		{ label: "a block subpath is never a heading rename", before: base, after: revised, stored: "^0169a6", links: ["^0169a7"], expected: null },
		{ label: "a whole-note embed (empty subpath) is never a heading rename", before: base, after: revised, stored: "", links: [""], expected: null },
		{ label: "no links at all in the linking note", before: base, after: revised, stored: "Lesson 8", links: [], expected: null },
		{ label: "an unchanged target", before: base, after: base, stored: "Lesson 8", links: ["Lesson 8"], expected: null },
	];

	it.each(cases)("$label", ({ before, after, stored, links, expected }) => {
		expect(headingRenameSubpath(frozen({ before, after, storedSubpath: stored, linkSubpaths: links }))).toBe(expected);
	});
});

describe("migrateEmbedHeading (G17)", () => {
	const HOST = "Course.md";
	const SOURCE = "Source.md";
	const move = { source: HOST, target: SOURCE, from: "Lesson 8", to: "Lesson 8 (revised)" };

	it("moves the subpath to the new heading and keeps occurrence index, folds, hash and dormant anchors as they are", () => {
		const [after] = migrateEmbedHeading(frozen([record(HOST, SOURCE, "Lesson 8", 1, "keep-me")]), move);
		expect(after.subpath).toBe("Lesson 8 (revised)");
		expect(after.occurrence).toBe(1);
		expect(after.contentHash).toBe("keep-me");
		expect(after.folds).toEqual([FOLD]);
		expect(after.dormant).toEqual([DORMANT]);
		expect([after.host, after.target]).toEqual([HOST, SOURCE]);
	});

	it("migrates every record that follows the renamed heading and no other", () => {
		const before = frozen([
			record(HOST, SOURCE, "Lesson 8", 0),
			record(HOST, SOURCE, "Lesson 8", 1),
			record("Second.md", SOURCE, "Lesson 8", 0), // another host: its own links are rewritten separately
			record(HOST, SOURCE, "lesson 8", 0), // case-different
			record(HOST, SOURCE, "Lesson 8 and more", 0), // similar name
			record(HOST, SOURCE, "^lesson8", 0),
			record(HOST, SOURCE, "", 0),
			record(HOST, "Other Source.md", "Lesson 8", 0),
		]);
		const after = migrateEmbedHeading(before, move);
		expect(after.map((r) => [r.host, r.target, r.subpath, r.occurrence])).toEqual([
			[HOST, SOURCE, "Lesson 8 (revised)", 0],
			[HOST, SOURCE, "Lesson 8 (revised)", 1],
			["Second.md", SOURCE, "Lesson 8", 0],
			[HOST, SOURCE, "lesson 8", 0],
			[HOST, SOURCE, "Lesson 8 and more", 0],
			[HOST, SOURCE, "^lesson8", 0],
			[HOST, SOURCE, "", 0],
			[HOST, "Other Source.md", "Lesson 8", 0],
		]);
		for (const i of [2, 3, 4, 5, 6, 7]) expect(after[i]).toBe(before[i]);
		expect(migrateEmbedHeading(after, { ...move, source: "Second.md" })[2].subpath).toBe("Lesson 8 (revised)");
	});

	it("a destination that already has a record for the same key is replaced (the G10 collision rule)", () => {
		const after = migrateEmbedHeading(frozen([record(HOST, SOURCE, "Lesson 8 (revised)", 0, "stale"), record(HOST, SOURCE, "Lesson 8", 0, "migrating")]), move);
		expect(after.map((r) => [r.subpath, r.contentHash])).toEqual([["Lesson 8 (revised)", "migrating"]]);
	});

	it("a different occurrence at the destination is a different key, so both survive", () => {
		const after = migrateEmbedHeading(frozen([record(HOST, SOURCE, "Lesson 8 (revised)", 1), record(HOST, SOURCE, "Lesson 8", 0)]), move);
		expect(after.map((r) => [r.subpath, r.occurrence])).toEqual([["Lesson 8 (revised)", 1], ["Lesson 8 (revised)", 0]]);
	});

	it("clears a dormancy stamp: the migrated embed has no dormant period", () => {
		const stamped = { ...record(HOST, SOURCE, "Lesson 8"), dormantSince: 9_000 };
		const [after] = migrateEmbedHeading(frozen([stamped]), move);
		expect("dormantSince" in after).toBe(false);
	});

	it("a nested record follows when the rewritten link is the one in the containing note", () => {
		const before = frozen([nested(HOST, [["Middle.md", "", 0]], SOURCE, "Lesson 8")]);
		expect(migrateEmbedHeading(before, move)[0]).toBe(before[0]); // the host's own links are not the ones rewritten
		const [after] = migrateEmbedHeading(before, { ...move, source: "Middle.md" });
		expect(after.subpath).toBe("Lesson 8 (revised)");
		expect(after.outer).toEqual([{ target: "Middle.md", subpath: "", occurrence: 0 }]);
	});

	it("a nested record follows when the rewritten link is the outer embed's heading in the host", () => {
		const [after] = migrateEmbedHeading(frozen([nested(HOST, [[SOURCE, "Lesson 8", 0]], "Inner.md", "^i1")]), move);
		expect(after.outer).toEqual([{ target: SOURCE, subpath: "Lesson 8 (revised)", occurrence: 0 }]);
		expect(after.subpath).toBe("^i1");
	});

	it("block and whole-note migrations, a no-op rename and a miss all return the records unchanged", () => {
		const before = frozen([record(HOST, SOURCE, "Lesson 8")]);
		for (const m of [
			{ ...move, from: "^a1", to: "^a2" },
			{ ...move, from: "", to: "Lesson 8" },
			{ ...move, to: "Lesson 8" },
			{ ...move, target: "Elsewhere.md" },
			{ ...move, source: "Elsewhere.md" },
		]) {
			expect(migrateEmbedHeading(before, m)[0]).toBe(before[0]);
		}
		expect(migrateEmbedHeading([], move)).toEqual([]);
	});
});
