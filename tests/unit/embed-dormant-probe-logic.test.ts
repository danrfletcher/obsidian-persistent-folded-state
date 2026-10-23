/**
 * The decision logic of scripts/e2e-embed-dormant-probe.mjs (ticket warkworth-21, PR-7, G6, E6, F2,
 * F7), run on states shaped like the ones the probe reads from a real Obsidian, plus the fixtures it
 * writes and the page-side expressions it sends. The probe itself (CDP, a real Obsidian) is
 * container-only; these are the parts a wrong rule would silently skew.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildAnchors } from "../../src/anchors";
import { findEmbeds } from "../../src/embed-key";
import { sliceEmbed } from "../../src/embed-slice";
import { isEmbedDormancyExpired } from "../../src/embed-dormant";
import { MAX_DORMANT_AGE_MS } from "../../src/dormant";
import { World, arrowFor } from "../fixtures/embed-recording-world";
import {
	arrowPointExpression,
	backdateDormantSince,
	dataShapeProblems,
	dormantRecordProblems,
	embedRecords,
	foldProblems,
	liveRecordProblems,
	noRecordProblems,
	parseArgs,
	plan,
	readEmbedsExpression,
	screenshotName,
	withoutHostEmbeds,
} from "../../scripts/e2e-embed-dormant-probe.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, "tests", "fixtures");
const PROBE = join(ROOT, "scripts", "e2e-embed-dormant-probe.mjs");
const read = (...parts: string[]) => readFileSync(join(FIXTURES, ...parts), "utf8");
const HOST_TEXT = read("embed-dormant", "host.md");
const RETARGETED_TEXT = read("embed-dormant", "host-retargeted.md");
const SOURCE_TEXT = read("embed-rematch", "competitive-coding-fundamentals-before.md");
const BROKEN_TEXT = read("embed-dormant", "source-broken.md");

const HOST = "Salesforce Tech Test Rocketship Course.md";
const SOURCE = "Competitive Coding Fundamentals.md";
const ids = { host: HOST, source: SOURCE };
const resolve = (linktext: string) => (linktext === "Competitive Coding Fundamentals" ? SOURCE : null);

/** The record the plugin stores for the fold, built from the fixtures with the real extractor. */
function recordFor(block: string, extra: Record<string, unknown> = {}) {
	const slice = sliceEmbed(SOURCE_TEXT, block);
	const anchor = buildAnchors(slice?.text ?? "").find((b) => b.anchor.text.startsWith("lesson 8"))?.anchor;
	return { host: HOST, target: SOURCE, subpath: block, occurrence: 0, contentHash: slice?.hash ?? "", folds: [anchor], dormant: [], ...extra };
}

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	document.body.replaceChildren();
	delete (document as { elementFromPoint?: unknown }).elementFromPoint; // a test that stubs hit-testing
});

describe("the fixtures the probe writes", () => {
	it("the host embeds the Lesson 8 block, and the retargeted host differs only in naming another real block", () => {
		const live = findEmbeds(HOST, HOST_TEXT, resolve);
		expect(live.map((e) => [e.target, e.subpath, e.occurrence])).toEqual([[SOURCE, "^0169a6", 0]]);
		const moved = findEmbeds(HOST, RETARGETED_TEXT, resolve);
		expect(moved.map((e) => [e.target, e.subpath, e.occurrence])).toEqual([[SOURCE, "^bbb222", 0]]);
		expect(HOST_TEXT.replace("^0169a6", "^bbb222")).toBe(RETARGETED_TEXT);
		expect(sliceEmbed(SOURCE_TEXT, "^bbb222")).not.toBeNull();
	});

	it("the broken source is the source minus the Lesson 8 block id, and nothing else", () => {
		expect(sliceEmbed(SOURCE_TEXT, "^0169a6")).not.toBeNull();
		expect(sliceEmbed(BROKEN_TEXT, "^0169a6")).toBeNull();
		expect(SOURCE_TEXT.replace(" ^0169a6", "")).toBe(BROKEN_TEXT);
		expect(sliceEmbed(BROKEN_TEXT, "^bbb222")).not.toBeNull();
	});
});

describe("foldProblems", () => {
	const embed = (...arrows: { row: string; collapsed: boolean }[]) => ({ arrows });
	it("an expanded embed passes with nothing wanted folded, and any fold is reported as beyond the set", () => {
		expect(foldProblems("x", embed({ row: "Lesson 9: Graphs", collapsed: false }), { folded: [], unfolded: ["Lesson 9"] })).toEqual([]);
		expect(foldProblems("x", embed({ row: "Lesson 8: Collections", collapsed: true }), { folded: [] })).toEqual(["x: folds beyond the expected set: Lesson 8: Collections"]);
	});

	it("reports a missing embed, a wanted fold that is open and a missing arrow", () => {
		expect(foldProblems("x", undefined, { folded: ["Lesson 8"] })).toEqual(["x: the embed is not on the page"]);
		expect(foldProblems("x", embed({ row: "Lesson 8: C", collapsed: false }), { folded: ["Lesson 8"] })).toEqual(['x: "Lesson 8" is not folded']);
		expect(foldProblems("x", embed(), { folded: [], unfolded: ["Lesson 8"] })).toEqual(['x: no "Lesson 8" arrow in the embed']);
	});
});

describe("the stored record checks", () => {
	const live = recordFor("^0169a6");

	it("embedRecords picks the host's embed of the block and nothing else", () => {
		const data = { embeds: [live, { ...live, host: "Other.md" }, { ...live, subpath: "^bbb222" }, { ...live, target: "Else.md" }] };
		expect(embedRecords(data, ids)).toEqual([live]);
		expect(embedRecords(data, ids, "^bbb222")).toEqual([{ ...live, subpath: "^bbb222" }]);
		expect(embedRecords({}, ids)).toEqual([]);
	});

	it("liveRecordProblems wants one record, Lesson 8 only, no dormantSince, and the same as before", () => {
		expect(liveRecordProblems("d", [live])).toEqual([]);
		expect(liveRecordProblems("d", [live], live)).toEqual([]);
		expect(liveRecordProblems("d", [])).toEqual(["d: expected exactly one embeds entry for the block, found 0"]);
		expect(liveRecordProblems("d", [{ ...live, folds: [] }])[0]).toContain("the stored folds are []");
		expect(liveRecordProblems("d", [{ ...live, dormantSince: 5 }])[0]).toContain("the record is dormant");
		expect(liveRecordProblems("d", [{ ...live, contentHash: "other" }], live)).toEqual(["d: the stored content hash changed"]);
	});

	it("dormantRecordProblems wants the stamp inside the step's time and everything else untouched", () => {
		const dormant = { ...live, dormantSince: 1500 };
		expect(dormantRecordProblems("d", [dormant], live, { since: 1000, now: 2000 })).toEqual([]);
		expect(dormantRecordProblems("d", [live], live, { since: 1000, now: 2000 })[0]).toContain("no numeric dormantSince");
		expect(dormantRecordProblems("d", [{ ...live, dormantSince: Number.NaN }], live, { since: 1000, now: 2000 })[0]).toContain("no numeric dormantSince");
		expect(dormantRecordProblems("d", [{ ...live, dormantSince: 999 }], live, { since: 1000, now: 2000 })[0]).toContain("outside the time of the step");
		expect(dormantRecordProblems("d", [{ ...dormant, folds: [] }], live, { since: 1000, now: 2000 })[0]).toContain("folds changed");
		expect(dormantRecordProblems("d", [{ ...dormant, dormant: live.folds }], live, { since: 1000, now: 2000 })[0]).toContain("per-anchor dormant list changed");
		expect(dormantRecordProblems("d", [], live, { since: 1000, now: 2000 })[0]).toContain("found 0 entries");
	});

	it("noRecordProblems passes only for no entry", () => {
		expect(noRecordProblems("d", [])).toEqual([]);
		expect(noRecordProblems("d", [{ ...live, dormantSince: 7 }])[0]).toContain("found 1 (dormantSince [7])");
	});

	it("dataShapeProblems keeps version 1 and the files section it started with", () => {
		const files = { "A.md": { folds: [], dormant: [] } };
		const baseline = JSON.stringify(files);
		expect(dataShapeProblems("d", { version: 1, files }, baseline)).toEqual([]);
		expect(dataShapeProblems("d", { version: 2, files }, baseline)[0]).toContain("version is 2");
		expect(dataShapeProblems("d", { version: 1, files: { ...files, "B.md": {} } }, baseline)).toEqual(["d: the files section of data.json changed"]);
		expect(dataShapeProblems("d", { version: 1, files }, undefined)[0]).toContain("no files baseline");
	});
});

describe("backdating dormantSince while the plugin is disabled", () => {
	const live = recordFor("^0169a6");
	const other = { ...recordFor("^bbb222"), dormantSince: 123 };

	it("moves only the host's record for the block, 11 minutes behind now, which is past the 600,000 ms window", () => {
		const data = { version: 1, files: { "A.md": { folds: [], dormant: [] } }, embeds: [{ ...live, dormantSince: 5000 }, other] };
		const { data: aged, since } = backdateDormantSince(data, ids, 10_000_000, 11 * 60 * 1000);
		expect(since).toBe(10_000_000 - 660_000);
		expect(aged.embeds[0].dormantSince).toBe(since);
		expect(aged.embeds[1]).toBe(other);
		expect(aged.files).toBe(data.files);
		expect(data.embeds[0].dormantSince).toBe(5000); // the input is not changed
		// The real expiry rule forgets it: this is what makes the probe's S4 skip the real wait.
		expect(isEmbedDormancyExpired(since, 10_000_000)).toBe(true);
		expect(10_000_000 - since).toBeGreaterThan(MAX_DORMANT_AGE_MS);
	});

	it("throws when there is no record to age instead of passing the step", () => {
		expect(() => backdateDormantSince({ embeds: [] }, ids, 1, 1)).toThrow("expected one embeds entry, found 0");
		expect(() => backdateDormantSince({}, ids, 1, 1)).toThrow("found 0");
	});

	it("withoutHostEmbeds drops this host's records only, and the section when none are left", () => {
		const data = { version: 1, files: {}, embeds: [live, { ...live, host: "Other.md" }] };
		expect(withoutHostEmbeds(data, HOST)).toEqual({ version: 1, files: {}, embeds: [{ ...live, host: "Other.md" }] });
		expect(withoutHostEmbeds({ version: 1, files: {}, embeds: [live] }, HOST)).toEqual({ version: 1, files: {} });
		expect(withoutHostEmbeds({ version: 1, files: {} }, HOST)).toEqual({ version: 1, files: {} });
	});
});

describe("plan, screenshots and arguments", () => {
	it("all is seed and S1 to S5 in Live Preview, then seed and S1 to S3 in Reading view (S6)", () => {
		expect(plan("all", "live-preview").map((s) => `${s.view}:${s.step}`)).toEqual([
			"live-preview:seed",
			"live-preview:s1-fold",
			"live-preview:s2-retarget",
			"live-preview:s3-revert",
			"live-preview:s4-expire",
			"live-preview:s5-break",
			"reading:seed",
			"reading:s1-fold",
			"reading:s2-retarget",
			"reading:s3-revert",
		]);
		expect(plan("s2-retarget", "reading")).toEqual([{ step: "s2-retarget", view: "reading" }]);
	});

	it("names screenshots S1 to S5 for Live Preview and S6 for Reading view", () => {
		expect(screenshotName("s1-fold", "live-preview", "folded")).toBe("PR-7-S1-folded.png");
		expect(screenshotName("s5-break", "live-preview", "broken")).toBe("PR-7-S5-broken.png");
		expect(screenshotName("s3-revert", "reading", "refolded")).toBe("PR-7-S6-reading-S3-refolded.png");
	});

	it("defaults to all phases in Live Preview on the Rocketship host and the vault's data.json", () => {
		const args = parseArgs([]);
		expect(args).toMatchObject({ phase: "all", view: "live-preview", host: HOST, source: SOURCE, cdpPort: 9222, waitMs: 1500, docker: null });
		expect(args.data).toBe("/config/test-vault/.obsidian/plugins/persistent-folded-state/data.json");
	});

	it("takes the vault root, the flags and --docker", () => {
		const args = parseArgs(["--phase", "s4-expire", "--view", "reading", "--vault-root", "/v", "--docker", "box", "--cdp-port", "9333", "--wait-ms", "10"]);
		expect(args).toMatchObject({ phase: "s4-expire", view: "reading", vaultRoot: "/v", docker: "box", cdpPort: 9333, waitMs: 10 });
		expect(args.data).toBe("/v/.obsidian/plugins/persistent-folded-state/data.json");
		expect(parseArgs(["--data", "/d.json"]).data).toBe("/d.json");
	});

	it("an unknown phase or view prints the usage and exits 1; --help exits 0", () => {
		const phase = spawnSync(process.execPath, [PROBE, "--phase", "nonsense"], { encoding: "utf8" });
		expect(phase.status).toBe(1);
		expect(phase.stdout).toContain("--phase <all|seed|s1-fold|s2-retarget|s3-revert|s4-expire|s5-break>");
		expect(spawnSync(process.execPath, [PROBE, "--view", "sideways"], { encoding: "utf8" }).status).toBe(1);
		expect(spawnSync(process.execPath, [PROBE, "--help"], { encoding: "utf8" }).status).toBe(0);
	});

	it("with no Obsidian to reach it fails with a message, not a hang", () => {
		const dir = mkdtempSync(join(tmpdir(), "pfs-dormant-probe-"));
		tempDirs.push(dir);
		const run = spawnSync(process.execPath, [PROBE, "--phase", "s1-fold", "--vault-root", dir, "--state", join(dir, "s.json"), "--cdp-port", "1"], { encoding: "utf8", timeout: 20_000 });
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("e2e-embed-dormant-probe failed");
	});

	it("is wired to npm as test:e2e:embed-dormant", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
		expect(pkg.scripts["test:e2e:embed-dormant"]).toBe("node scripts/e2e-embed-dormant-probe.mjs");
	});
});

describe("the page-side expressions, evaluated against the DOM the plugin tests share with the real-Obsidian probe", () => {
	/** Runs an expression the way CDP's Runtime.evaluate does, with `app` in scope. */
	function evaluate(host: ReturnType<World["addHost"]>, expression: string): unknown {
		const app = { workspace: { getLeavesOfType: () => [{ view: { ...host.view, file: { path: HOST }, containerEl: host.view.containerEl, getMode: () => host.view.getMode() } }] } };
		return new Function("app", `return ${expression}`)(app);
	}

	for (const mode of ["live-preview", "reading-view"] as const) {
		it(`readEmbeds reports each arrow's own row text and fold state in ${mode}`, () => {
			const w = new World();
			w.addNote(SOURCE, SOURCE_TEXT);
			const host = w.addHost(HOST, mode, HOST_TEXT);
			w.renderToggle(arrowFor(host.embeds[0], "Lesson 8"), true);

			const embeds = JSON.parse(evaluate(host, readEmbedsExpression(HOST)) as string);

			expect(embeds).toHaveLength(1);
			expect(embeds[0].src).toBe("Competitive Coding Fundamentals#^0169a6");
			expect(embeds[0].arrows).toEqual([
				{ row: "Lesson 8: Collections and frequency counting", collapsed: true },
				{ row: "Count word frequency with a map", collapsed: false },
			]);
			expect(foldProblems("x", embeds[0], { folded: ["Lesson 8"], unfolded: ["Count word frequency"] })).toEqual([]);
		});
	}

	it("only reads the surface the pane shows: a Live Preview pane's hidden reading surface is ignored", () => {
		const w = new World();
		w.addNote(SOURCE, SOURCE_TEXT);
		const host = w.addHost(HOST, "live-preview", HOST_TEXT);
		const stray = document.createElement("div");
		stray.className = "internal-embed markdown-embed";
		stray.setAttribute("src", "Stray#^x");
		host.view.readingSurface().append(stray);

		const embeds = JSON.parse(evaluate(host, readEmbedsExpression(HOST)) as string);

		expect(embeds.map((e: { src: string }) => e.src)).toEqual(["Competitive Coding Fundamentals#^0169a6"]);
	});

	it("arrowPoint finds the arrow by row text prefix within the embed with that src, and null for another", () => {
		const w = new World();
		w.addNote(SOURCE, SOURCE_TEXT);
		const host = w.addHost(HOST, "reading-view", HOST_TEXT);
		const src = "Competitive Coding Fundamentals#^0169a6";
		Element.prototype.scrollIntoView = () => {}; // jsdom has no layout engine, so no scrolling
		expect(evaluate(host, arrowPointExpression(HOST, src, "Lesson 8"))).toEqual({ x: 0, y: 0 });
		expect(evaluate(host, arrowPointExpression(HOST, src, "No such row"))).toBeNull();
		expect(evaluate(host, arrowPointExpression(HOST, "Another#^zzz", "Lesson 8"))).toBeNull();
	});

	/** Real Obsidian lays a task row out so the task's checkbox covers the middle of the arrow's
	 * 42 px box (87 to 129 px, checkbox 105 to 123 px): hit-testing is stubbed to that layout. */
	function laidOutLikeObsidian(host: ReturnType<World["addHost"]>, coverage: "checkbox-in-the-middle" | "everything"): HTMLElement {
		const arrow = arrowFor(host.embeds[0], "Lesson 8");
		const checkbox = arrow.parentElement?.querySelector<HTMLElement>("input.task-list-item-checkbox") as HTMLElement;
		Element.prototype.scrollIntoView = () => {};
		arrow.getBoundingClientRect = () => ({ left: 87, top: 229, width: 42, height: 24, right: 129, bottom: 253, x: 87, y: 229, toJSON: () => ({}) });
		document.elementFromPoint = (x: number) => (coverage === "everything" || (x >= 105 && x < 123) ? checkbox : arrow);
		return arrow;
	}

	it("arrowPoint picks a point where the arrow itself is on top, not the checkbox that covers its centre (T1)", () => {
		const w = new World();
		w.addNote(SOURCE, SOURCE_TEXT);
		const host = w.addHost(HOST, "live-preview", HOST_TEXT);
		const arrow = laidOutLikeObsidian(host, "checkbox-in-the-middle");

		const point = evaluate(host, arrowPointExpression(HOST, "Competitive Coding Fundamentals#^0169a6", "Lesson 8")) as { x: number; y: number };

		expect(point.x).toBeLessThan(105); // the centre (108) is the checkbox
		expect(point.x).toBeGreaterThanOrEqual(87);
		expect(document.elementFromPoint(point.x, point.y)).toBe(arrow);
	});

	it("arrowPoint reports what covers the arrow when no point of it can be clicked, rather than clicking the cover", () => {
		const w = new World();
		w.addNote(SOURCE, SOURCE_TEXT);
		const host = w.addHost(HOST, "live-preview", HOST_TEXT);
		laidOutLikeObsidian(host, "everything");

		const point = evaluate(host, arrowPointExpression(HOST, "Competitive Coding Fundamentals#^0169a6", "Lesson 8")) as { x?: number; blockedBy?: string };

		expect(point.x).toBeUndefined();
		expect(point.blockedBy).toBe("input.task-list-item-checkbox");
	});
});
