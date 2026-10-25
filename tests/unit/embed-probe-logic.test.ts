/**
 * The decision logic of scripts/e2e-embed-probe.mjs (E10, G18), run on states shaped like the ones
 * the probe saves from a real Obsidian: how an experiment's raw readings become the fold-memory
 * answer (per embed kind), the "kept across reopen / edit" flags, the verdict for a combination,
 * and the guard that stops the probe deleting a vault folder it did not create. The probe itself
 * (CDP, a real Obsidian) is container-only; these are the parts a wrong rule would silently skew.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LAZY_NOTE, buildReport, comboFor, editRetentionCaveat, foldMemoryAnswer as foldMemoryAnswerTyped, guardFixtureFolder, installFixtures, removeFixtureFolder, reportMarkdown, retention, writeReports } from "../../scripts/e2e-embed-probe.mjs";

const UNOBSERVABLE = "unobservable";
const KINDS = ["block", "heading", "whole-note"] as const;
type Kind = (typeof KINDS)[number];
const KEY: Record<Kind, string> = {
	block: "Probe Fundamentals#^0169a6|0",
	heading: "Probe Fundamentals#Lesson 8|0",
	"whole-note": "Probe Whole Note|0",
};
const ITEM: Record<Kind, string> = { block: "Lesson 8", heading: "Lesson 8", "whole-note": "Item A1" };
const SOURCE_KEY: Record<Kind, string> = {
	block: "app-note-fold-embed-probe/Probe Fundamentals.md",
	heading: "app-note-fold-embed-probe/Probe Fundamentals.md",
	"whole-note": "app-note-fold-embed-probe/Probe Whole Note.md",
};

// ---- fold-memory answer (R1) ------------------------------------------------------------------------

// The probe is plain JS: its results are inspected structurally here.
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const foldMemoryAnswer = (state: Any): Any => foldMemoryAnswerTyped(state);

/** What runKindMemory records for one kind when nothing leaks. */
function memoryFor(kind: Kind, over: Any = {}): Any {
	return {
		folded: true,
		wasFoldedBeforeClick: false,
		storageKeys: [SOURCE_KEY[kind]],
		storage: {},
		sourceNote: { method: "reading-view indicator", found: true, collapsed: false },
		secondHost: { found: true, folded: false, foldedLabels: [] },
		sameHost: kind === "whole-note" ? { found: true, folded: false, foldedLabels: [], primaryEmbedFolded: true } : "not-applicable",
		...over,
	};
}

function memoryState(overrides: Partial<Record<Kind, Any>> = {}, modes = ["lp", "rv"]): Any {
	const state: Any = { modes: {} };
	for (const mode of modes) {
		state.modes[mode] = { memory: { kinds: Object.fromEntries(KINDS.map((k) => [k, overrides[k] ?? memoryFor(k)])) } };
	}
	return state;
}

describe("foldMemoryAnswer: Dan's observation, answered per embed kind (E10, R1)", () => {
	it("is confirmed only when every kind in every mode was read and none leaked", () => {
		const a = foldMemoryAnswer(memoryState());
		expect(a.danObservation).toBe("confirmed");
		expect(a.perKind).toEqual({ block: "confirmed", heading: "confirmed", "whole-note": "confirmed" });
		expect(a.keyedToSourceNote).toBe(true); // Obsidian wrote a per-source-note key, yet nothing leaked
		expect(a.statement).toMatch(/^Confirmed for block embed, heading embed, whole-note embed/);
	});

	it("is refuted for the whole-note kind when the md-link embed of the same note comes back folded, even though block and heading are independent", () => {
		const a = foldMemoryAnswer(
			memoryState({ "whole-note": memoryFor("whole-note", { sameHost: { found: true, folded: true, foldedLabels: ["Item A1"], primaryEmbedFolded: true } }) })
		);
		expect(a.danObservation).toBe("refuted");
		expect(a.perKind).toEqual({ block: "confirmed", heading: "confirmed", "whole-note": "refuted" });
		expect(a.perMode.lp["whole-note"].leakedTo).toEqual([expect.stringContaining("`![](x.md)` embed of the same note in the same host")]);
		expect(a.statement).toMatch(/^Refuted for whole-note embed\. Folded on its own, whole-note embed: the fold also showed up in .*not independent of the source note for that kind\. Confirmed independent for block embed, heading embed\./);
	});

	it("is refuted for a kind whose fold shows when the source note is opened on its own", () => {
		const a = foldMemoryAnswer(memoryState({ heading: memoryFor("heading", { sourceNote: { method: "x", found: true, collapsed: true } }) }));
		expect(a.perKind.heading).toBe("refuted");
		expect(a.perKind.block).toBe("confirmed");
		expect(a.danObservation).toBe("refuted");
		expect(a.perMode.rv.heading.leakedTo).toEqual(["the source note opened on its own"]);
	});

	it("is refuted for a kind whose fold shows in the same embed in a second host", () => {
		const a = foldMemoryAnswer(memoryState({ block: memoryFor("block", { secondHost: { found: true, folded: true, foldedLabels: ["Lesson 8"] } }) }));
		expect(a.perKind.block).toBe("refuted");
		expect(a.danObservation).toBe("refuted");
	});

	it("a leak in one host mode is enough to refute the kind", () => {
		const state = memoryState();
		state.modes.lp.memory.kinds["whole-note"] = memoryFor("whole-note", { sourceNote: { found: true, collapsed: true } });
		const a = foldMemoryAnswer(state);
		expect(a.perKind["whole-note"]).toBe("refuted");
		expect(a.perMode.rv["whole-note"].answer).toBe("confirmed");
	});

	it("is unobservable, never confirmed, when a reading could not be taken", () => {
		const a = foldMemoryAnswer(memoryState({ block: memoryFor("block", { sourceNote: { method: "x", found: false, collapsed: null } }) }));
		expect(a.perKind.block).toBe(UNOBSERVABLE);
		expect(a.danObservation).toBe(UNOBSERVABLE);
		expect(a.perMode.lp.block.reason).toMatch(/source note opened on its own/);
		expect(a.statement).toMatch(/Confirmed independent for heading embed, whole-note embed/);
	});

	it("is unobservable when the item was not folded while the checks ran (a fold that never existed proves nothing)", () => {
		const a = foldMemoryAnswer(memoryState({ heading: memoryFor("heading", { folded: false }) }));
		expect(a.perKind.heading).toBe(UNOBSERVABLE);
		expect(a.danObservation).toBe(UNOBSERVABLE);
	});

	it("is unobservable for a kind whose experiment step threw (recorded as the string 'unobservable')", () => {
		const a = foldMemoryAnswer(memoryState({ "whole-note": UNOBSERVABLE }));
		expect(a.perKind["whole-note"]).toBe(UNOBSERVABLE);
		expect(a.danObservation).toBe(UNOBSERVABLE);
	});

	it("a leak still refutes when another kind could not be read", () => {
		const a = foldMemoryAnswer(
			memoryState({ block: UNOBSERVABLE, "whole-note": memoryFor("whole-note", { sameHost: { found: true, folded: true } }) })
		);
		expect(a.danObservation).toBe("refuted");
		expect(a.statement).toMatch(/Could not be read for block embed/);
	});

	it("is unobservable with no memory data at all", () => {
		expect(foldMemoryAnswer({ modes: {} }).danObservation).toBe(UNOBSERVABLE);
		expect(foldMemoryAnswer({ modes: { lp: {} } }).danObservation).toBe(UNOBSERVABLE);
	});

	it("does not call a missing md-link embed independent (found: false reads as unobservable)", () => {
		const a = foldMemoryAnswer(memoryState({ "whole-note": memoryFor("whole-note", { sameHost: { found: false, folded: UNOBSERVABLE } }) }));
		expect(a.perKind["whole-note"]).toBe(UNOBSERVABLE);
	});
});

// ---- retention (R2) ------------------------------------------------------------------------------------

describe("retention: did the fold survive a reopen or an edit (E10, R2)", () => {
	it("an item folded before and after is kept; folded before and gone after is not", () => {
		expect(retention(["Lesson 8"], ["Lesson 8"])).toEqual({ retained: true, reason: null });
		expect(retention(["Lesson 8"], [])).toEqual({ retained: false, reason: null });
	});

	it("nothing folded at close time is unobservable with a reason, not 'no'", () => {
		const r = retention([], []);
		expect(r.retained).toBe(UNOBSERVABLE);
		expect(r.reason).toMatch(/nothing in the embed was folded/);
		expect(retention([], ["Lesson 8"]).retained).toBe(UNOBSERVABLE);
	});

	it("an unreadable state on either side is unobservable", () => {
		expect(retention(UNOBSERVABLE, ["a"]).retained).toBe(UNOBSERVABLE);
		expect(retention(["a"], UNOBSERVABLE).retained).toBe(UNOBSERVABLE);
		expect(retention(null, ["a"]).retained).toBe(UNOBSERVABLE);
		expect(retention(["a"], null).retained).toBe(UNOBSERVABLE);
	});

	it("compares labels across a reopen but only the count across an edit (labels change with the edit)", () => {
		expect(retention(["Item A1"], ["Item A1 (revised)"]).retained).toBe(false);
		expect(retention(["Item A1"], ["Item A1 (revised)"], { compare: "count" }).retained).toBe(true);
		expect(retention(["Item A1"], [], { compare: "count" }).retained).toBe(false);
	});
});

// ---- verdict for a combination (R2, R3) -------------------------------------------------------------------

/** A complete, healthy state for one mode: what a fully observed run saves. */
function comboState(over: { reopen?: Any; edit?: Any } = {}): Any {
	const keyed = (v: Any) => Object.fromEntries(KINDS.map((k) => [KEY[k], v]));
	const perKind = (v: Any) => Object.fromEntries(KINDS.map((k) => [k, typeof v === "function" ? v(k) : v]));
	const burst = { firstEventMs: 20, loadedMs: 20, firstRenderSettledMs: 30, bursts: 1, replacedElements: 0, burstStartsMs: [20] };
	return {
		modes: {
			lp: {
				snapshotBeforeFold: {
					embeds: KINDS.map((k) => ({ key: KEY[k], src: KEY[k].split("|")[0], rendered: true, toggles: [{ type: k === "heading" ? "heading" : "list", label: `${ITEM[k]} label`, collapsed: false }] })),
				},
				render: keyed(burst),
				folds: perKind(() => ({ events: [{ type: "click", isTrusted: true }], changed: true, folded: true })),
				reopen: {
					render: keyed(burst),
					drive: perKind(() => ({ changed: true, foldedAgain: true })),
					retained: perKind(true),
					retainedReason: perKind(null),
					...over.reopen,
				},
				edit: {
					render: keyed(burst),
					retained: perKind(true),
					retainedReason: perKind(null),
					contentUpdated: perKind(true),
					contentUpdatedMethod: perKind("visible"),
					...over.edit,
				},
			},
		},
	};
}

describe("comboFor: the verdict never hides what could not be shown (G18, R2, R3)", () => {
	it("a fully observed combination is supported", () => {
		for (const k of KINDS) {
			const c = comboFor(comboState(), "lp", k);
			expect(c.verdict).toBe("supported");
			expect(c.reason).toBeNull();
			expect(c.unobservable).toEqual([]);
		}
	});

	it("R2: a fold that was never there at close time makes retention unobservable and the combination partial, with the reason", () => {
		const why = retention([], []).reason;
		const state = comboState({
			reopen: {
				retained: { block: UNOBSERVABLE, heading: UNOBSERVABLE, "whole-note": true },
				retainedReason: { block: why, heading: why, "whole-note": null },
			},
		});
		const block = comboFor(state, "lp", "block");
		expect(block.retainedAcrossReopen).toBe(UNOBSERVABLE);
		expect(block.retainedAcrossReopenWhy).toBe(why);
		expect(block.verdict).toBe("partial");
		expect(block.reason).toMatch(/closing and reopening the host could not be observed \(nothing in the embed was folded/);
		expect(block.unobservable.join(" ")).toMatch(/closing and reopening the host/);
		expect(comboFor(state, "lp", "whole-note").verdict).toBe("supported");
	});

	it("R3: an embed that was not seen to show the edited text is partial with that reason, not 'supported'", () => {
		const state = comboState({
			edit: {
				contentUpdated: { block: true, heading: false, "whole-note": true },
				contentUpdatedMethod: { block: "visible", heading: "after-unfold", "whole-note": "visible" },
			},
		});
		const heading = comboFor(state, "lp", "heading");
		expect(heading.sourceContentUpdatedAfterEdit).toBe(false);
		expect(heading.verdict).toBe("partial");
		expect(heading.reason).toMatch(/did not show the externally edited source text \(read after-unfold\)/);
		expect(comboFor(state, "lp", "block").verdict).toBe("supported");
	});

	it("R3: an edited-text reading that could not be taken is partial and listed as unobservable", () => {
		const state = comboState({ edit: { contentUpdated: { block: UNOBSERVABLE, heading: true, "whole-note": true } } });
		const block = comboFor(state, "lp", "block");
		expect(block.verdict).toBe("partial");
		expect(block.reason).toMatch(/edited source text could not be read/);
		expect(block.unobservable).toContain("whether the embed showed the edited source text could not be read");
	});

	it("a retention reading lost to a failed edit step is partial, not supported", () => {
		const state = comboState({ edit: { retained: { block: UNOBSERVABLE, heading: true, "whole-note": true }, retainedReason: { block: "the fold state afterwards could not be read", heading: null, "whole-note": null } } });
		const block = comboFor(state, "lp", "block");
		expect(block.verdict).toBe("partial");
		expect(block.reason).toMatch(/external source edit could not be observed \(the fold state afterwards could not be read\)/);
	});
});

// ---- fixture-folder guard (R4) ------------------------------------------------------------------------------

const made: string[] = [];
function tempVault(): string {
	const dir = mkdtempSync(join(tmpdir(), "pfs-embed-probe-test-"));
	made.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the probe never deletes an embed-probe folder it did not create (R4)", () => {
	it("a vault with no embed-probe folder is fine, and installing writes the marker plus the fixtures", () => {
		const vault = tempVault();
		expect(guardFixtureFolder(vault)).toBe("absent");
		installFixtures(vault);
		const files = readdirSync(join(vault, "embed-probe"));
		expect(files).toContain(".pfs-embed-probe");
		expect(files).toContain("Probe Host.md");
		expect(files).toContain("Probe Host 51.md");
		expect(guardFixtureFolder(vault)).toBe("leftover");
	});

	it("a pre-existing embed-probe folder without the marker is refused and left intact", () => {
		const vault = tempVault();
		mkdirSync(join(vault, "embed-probe"));
		writeFileSync(join(vault, "embed-probe", "My real note.md"), "do not delete me", "utf8");
		expect(() => guardFixtureFolder(vault)).toThrow(/refusing to run: .*embed-probe already exists and was not created by this probe/);
		expect(() => installFixtures(vault)).toThrow(/refusing to run/);
		expect(() => removeFixtureFolder(vault)).toThrow(/refusing to run/);
		expect(readFileSync(join(vault, "embed-probe", "My real note.md"), "utf8")).toBe("do not delete me");
		expect(readdirSync(join(vault, "embed-probe"))).toEqual(["My real note.md"]);
	});

	it("an empty pre-existing embed-probe folder is also somebody else's and is refused", () => {
		const vault = tempVault();
		mkdirSync(join(vault, "embed-probe"));
		expect(() => installFixtures(vault)).toThrow(/refusing to run/);
		expect(existsSync(join(vault, "embed-probe"))).toBe(true);
	});

	it("a folder the probe itself left behind (marker present) is replaced, and cleanup removes it", () => {
		const vault = tempVault();
		installFixtures(vault);
		writeFileSync(join(vault, "embed-probe", "stale.md"), "from a crashed run", "utf8");
		installFixtures(vault);
		expect(existsSync(join(vault, "embed-probe", "stale.md"))).toBe(false);
		removeFixtureFolder(vault);
		expect(existsSync(join(vault, "embed-probe"))).toBe(false);
	});

	it("cleanup of a vault with no fixture folder does nothing and notes outside the folder are never touched", () => {
		const vault = tempVault();
		writeFileSync(join(vault, "Daily.md"), "keep", "utf8");
		removeFixtureFolder(vault);
		installFixtures(vault);
		removeFixtureFolder(vault);
		expect(readFileSync(join(vault, "Daily.md"), "utf8")).toBe("keep");
		expect(readdirSync(vault)).toEqual(["Daily.md"]);
	});
});

describe("the second-host fixture carries an embed of every kind the fold-memory experiment checks (R1)", () => {
	it("Probe Second Host embeds the block, the heading and the whole note", () => {
		const text = readFileSync(join(__dirname, "..", "fixtures", "embed-probe", "Probe Second Host.md"), "utf8");
		expect(text).toContain("![[Probe Fundamentals#^0169a6]]");
		expect(text).toContain("![[Probe Fundamentals#Lesson 8]]");
		expect(text).toContain("![[Probe Whole Note]]");
	});
});

// ---- a partly failed probe still writes a complete report (G18 edge case, PR-2 R7) ------------------------
describe("buildReport and writeReports: a probe that mostly failed still writes valid, schema-complete output", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** What the probe's state file holds when only the setup step got as far as recording an error. */
	const partialState = (): Any => ({
		startedAt: "2026-10-23T00:00:00.000Z",
		vault: null,
		obsidian: null,
		preSnapshot: null,
		modes: {},
		hover: null,
		fixtureRestored: null,
		stepErrors: [{ step: "open-host", mode: "lp", error: "CDP connection refused" }],
	});

	it("gives all six combinations as unsupported, each with a reason", () => {
		const report = buildReport(partialState()) as Any;
		expect(report.combinations).toHaveLength(6);
		for (const mode of ["live-preview", "reading-view"]) {
			for (const kind of KINDS) {
				expect(report.verdicts[mode][kind].verdict).toBe("unsupported");
				expect(String(report.verdicts[mode][kind].reason).length).toBeGreaterThan(0);
			}
		}
	});

	it("keeps every top-level field of the schema, with the unobservable marker where nothing was read", () => {
		const report = buildReport(partialState()) as Any;
		expect(Object.keys(report).sort()).toEqual(
			["combinations", "fixtureCoverage", "fixtureRestored", "foldMemory", "generatedAt", "generatedBy", "hostDetection", "hoverPreview", "lazyRendering", "obsidianVersion", "schemaVersion", "stepErrors", "verdicts"].sort(),
		);
		expect(report.schemaVersion).toBe(1);
		expect(report.obsidianVersion).toBe(UNOBSERVABLE);
		expect(report.hoverPreview).toBe(UNOBSERVABLE);
		expect(report.lazyRendering).toEqual({ "live-preview": UNOBSERVABLE, "reading-view": UNOBSERVABLE });
		expect(report.stepErrors).toEqual(partialState().stepErrors);
	});

	it("writes embed-probe.json that parses back to the same report, plus both markdown files", () => {
		const dir = mkdtempSync(join(tmpdir(), "embed-probe-docs-"));
		dirs.push(dir);
		const report = buildReport(partialState()) as Any;
		writeReports({ writeDocs: true }, report, dir);
		expect(readdirSync(dir).sort()).toEqual(["embed-probe.json", "embed-probe.md", "embed-release-gaps.md"]);
		const written = JSON.parse(readFileSync(join(dir, "embed-probe.json"), "utf8"));
		expect(written).toEqual(JSON.parse(JSON.stringify(report)));
		expect(readFileSync(join(dir, "embed-release-gaps.md"), "utf8")).toContain("Live Preview, block embed (unsupported)");
		expect(readFileSync(join(dir, "embed-probe.md"), "utf8")).toContain("CDP connection refused");
	});

	it("writes nothing with --no-write-docs", () => {
		const dir = join(mkdtempSync(join(tmpdir(), "embed-probe-docs-")), "docs");
		dirs.push(join(dir, ".."));
		writeReports({ writeDocs: false }, buildReport(partialState()), dir);
		expect(existsSync(dir)).toBe(false);
	});
});

describe("report wording that keeps two readings honest (PR-2 R5, R8)", () => {
	it("the edit-retention caveat is added only to a no for a block or heading embed", () => {
		expect(editRetentionCaveat({ kind: "block", retainedAcrossSourceEdit: false })).toContain("interference");
		expect(editRetentionCaveat({ kind: "heading", retainedAcrossSourceEdit: false })).toContain("interference");
		expect(editRetentionCaveat({ kind: "whole-note", retainedAcrossSourceEdit: false })).toBe("");
		expect(editRetentionCaveat({ kind: "block", retainedAcrossSourceEdit: true })).toBe("");
		expect(editRetentionCaveat({ kind: "block", retainedAcrossSourceEdit: UNOBSERVABLE })).toBe("");
	});

	it("the lazy-rendering section says Live Preview embeds unmount and remount on scroll", () => {
		const md = reportMarkdown(buildReport({ ...{ startedAt: "", modes: {}, hover: null, fixtureRestored: null, stepErrors: [] } }) as Any);
		expect(md).toContain(LAZY_NOTE);
		expect(LAZY_NOTE).toContain("unmounted");
		expect(LAZY_NOTE).toContain("not measured");
	});
});
