/**
 * The decision logic of scripts/e2e-embed-rematch-probe.mjs (ticket warkworth-21, PR-6, GP4, GP6,
 * F2, F7), run on states shaped like the ones the probe reads from a real Obsidian, and the one
 * phase that needs no Obsidian: `rewrite` writes the "after" fixture over the source note byte for
 * byte. The probe itself (CDP, a real Obsidian) is container-only; these are the parts a wrong
 * rule would silently skew.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnchors } from "../../src/anchors";
import { SOURCE_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";
import { sliceEmbed } from "../../src/embed-slice";
import { arrowPointExpression, embedRecords, foldProblems, parseArgs, readEmbedsExpression, refreshedRecordProblems, rewriteSource, sha256, sourceFoldProblems, storedFoldProblems } from "../../scripts/e2e-embed-rematch-probe.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "embed-rematch");
const BEFORE_FILE = join(FIXTURES, "competitive-coding-fundamentals-before.md");
const AFTER_FILE = join(FIXTURES, "competitive-coding-fundamentals-after.md");
const PROBE = join(ROOT, "scripts", "e2e-embed-rematch-probe.mjs");

const HOST = "Salesforce Tech Test Rocketship Course.md";
const SOURCE = "Competitive Coding Fundamentals.md";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempVault(): string {
	const dir = mkdtempSync(join(tmpdir(), "pfs-rematch-probe-"));
	tempDirs.push(dir);
	return dir;
}

const arrow = (row: string, collapsed: boolean) => ({ row, collapsed });
const embedShowing = (...arrows: ReturnType<typeof arrow>[]) => ({ src: "Competitive Coding Fundamentals#^0169a6", arrows });

/** The record the plugin stores for the fold, built from the fixtures with the real extractor. */
function recordFor(text: string) {
	const slice = sliceEmbed(text, "^0169a6");
	const anchor = buildAnchors(slice?.text ?? "").find((block) => block.anchor.text.startsWith("lesson 8"))?.anchor;
	return { host: HOST, target: SOURCE, subpath: "^0169a6", occurrence: 0, contentHash: slice?.hash ?? "", folds: [anchor], dormant: [] };
}

describe("foldProblems", () => {
	it("passes when exactly the wanted row is folded", () => {
		const embed = embedShowing(arrow("Lesson 8 (revised): Collections and frequency counting", true), arrow("Count word frequency with a map", false));
		expect(foldProblems("x", embed, { folded: ["Lesson 8 (revised)"], unfolded: ["Count word frequency"] })).toEqual([]);
	});

	it("reports a wanted fold that is open, a row folded that never was, and any fold beyond the stored set", () => {
		const embed = embedShowing(arrow("Lesson 8: Collections", false), arrow("Count word frequency with a map", true), arrow("Other", true));
		const problems = foldProblems("x", embed, { folded: ["Lesson 8"], unfolded: ["Count word frequency"] });
		expect(problems).toContain('x: "Lesson 8" is not folded');
		expect(problems).toContain('x: "Count word frequency" is folded but was never folded');
		expect(problems).toContain("x: folds beyond the stored set: Count word frequency with a map, Other");
	});

	it("reports a missing arrow or a missing embed instead of passing", () => {
		expect(foldProblems("x", embedShowing(), { folded: ["Lesson 8"] })).toEqual(['x: no "Lesson 8" arrow in the embed']);
		expect(foldProblems("x", undefined, { folded: ["Lesson 8"] })).toEqual(["x: the embed is not on the page"]);
	});
});

describe("the stored record checks", () => {
	const before = readFileSync(BEFORE_FILE, "utf8");
	const after = readFileSync(AFTER_FILE, "utf8");
	const key = { host: HOST, source: SOURCE };

	it("embedRecords picks the host's embed of the block and nothing else", () => {
		const mine = recordFor(before);
		const data = { embeds: [mine, { ...mine, host: "Other.md" }, { ...mine, subpath: "Lesson 8" }, { ...mine, target: "Else.md" }] };
		expect(embedRecords(data, key)).toEqual([mine]);
		expect(embedRecords({}, key)).toEqual([]);
	});

	it("storedFoldProblems wants exactly one record holding only Lesson 8", () => {
		expect(storedFoldProblems("d", [recordFor(before)], "lesson 8")).toEqual([]);
		expect(storedFoldProblems("d", [], "lesson 8")).toEqual(["d: expected exactly one embeds entry for the block, found 0"]);
		expect(storedFoldProblems("d", [{ ...recordFor(before), folds: [] }], "lesson 8")[0]).toContain("the stored folds are []");
	});

	it("refreshedRecordProblems passes for the record the re-match writes and fails for the record it started with", () => {
		const stored = recordFor(before);
		expect(refreshedRecordProblems("d", stored, [recordFor(after)])).toEqual([]);
		const unchanged = refreshedRecordProblems("d", stored, [stored]);
		expect(unchanged.join("\n")).toContain("the stored folds are");
		expect(unchanged.join("\n")).toContain("did not change");
		expect(unchanged.join("\n")).toContain("still the old ones");
	});
});

describe("sourceFoldProblems (F2)", () => {
	it("is the same state when the rows only differ by the rename", () => {
		expect(sourceFoldProblems("s", ["Lesson 7: Sorting"], ["Lesson 7: Sorting"])).toEqual([]);
		expect(sourceFoldProblems("s", ["Lesson 8: Collections"], ["Lesson 8 (revised): Collections"])).toEqual([]);
		expect(sourceFoldProblems("s", [], [])).toEqual([]);
	});

	it("reports a fold the source note did not have, or lost", () => {
		expect(sourceFoldProblems("s", [], ["Lesson 8 (revised): Collections"])[0]).toContain('now ["Lesson 8: Collections"]');
		expect(sourceFoldProblems("s", ["Lesson 7: Sorting"], [])[0]).toContain('were ["Lesson 7: Sorting"]');
	});
});

describe("parseArgs", () => {
	it("defaults to the Rocketship host, the fixtures and the vault's data.json", () => {
		const args = parseArgs([]);
		expect(args).toMatchObject({ host: HOST, source: SOURCE, before: BEFORE_FILE, after: AFTER_FILE, live: false, writeBefore: false, cdpPort: 9222 });
		expect(args.data).toBe("/config/test-vault/.obsidian/plugins/persistent-folded-state/data.json");
	});

	it("takes the vault root, the flags and --docker", () => {
		const args = parseArgs(["--phase", "rewrite", "--live", "--write-before", "--vault-root", "/v", "--docker", "box", "--cdp-port", "9333"]);
		expect(args).toMatchObject({ phase: "rewrite", live: true, writeBefore: true, vaultRoot: "/v", docker: "box", cdpPort: 9333 });
		expect(args.data).toBe("/v/.obsidian/plugins/persistent-folded-state/data.json");
	});
});

describe("the rewrite phase, run as the tester runs it (Obsidian quit: no CDP)", () => {
	it("writes the after fixture over the source byte for byte and leaves the host alone", () => {
		const vault = tempVault();
		const hostText = "![[Competitive Coding Fundamentals#^0169a6]]\n";
		writeFileSync(join(vault, HOST), hostText, "utf8");
		writeFileSync(join(vault, SOURCE), readFileSync(BEFORE_FILE, "utf8"), "utf8");
		const state = join(vault, "state.json");

		const run = spawnSync(process.execPath, [PROBE, "--phase", "rewrite", "--vault-root", vault, "--state", state], { encoding: "utf8" });

		expect(run.status).toBe(0);
		expect(run.stdout).toContain("PASS rewrite");
		const after = readFileSync(AFTER_FILE);
		expect(readFileSync(join(vault, SOURCE)).equals(after)).toBe(true);
		expect(readFileSync(join(vault, HOST), "utf8")).toBe(hostText);
		const saved = JSON.parse(readFileSync(state, "utf8"));
		expect(saved.rewrite).toMatchObject({ sourceSha: sha256(after.toString("utf8")), hostSha: sha256(hostText), live: false });
	});

	it("rewriteSource returns the hash and size of what it wrote", () => {
		const vault = tempVault();
		const target = join(vault, "n.md");
		const written = rewriteSource(target, "héllo\n");
		expect(readFileSync(target, "utf8")).toBe("héllo\n");
		expect(written).toEqual({ sourcePath: target, sourceSha: sha256("héllo\n"), bytes: 7 });
	});

	it("after-relaunch with no Obsidian to reach fails with a message, not a hang", () => {
		const vault = tempVault();
		const run = spawnSync(process.execPath, [PROBE, "--phase", "after-relaunch", "--vault-root", vault, "--state", join(vault, "s.json"), "--cdp-port", "1", "--connect-retries", "1"], { encoding: "utf8", timeout: 20_000 });
		expect(run.status).toBe(1);
		expect(run.stderr).toContain("e2e-embed-rematch-probe failed");
	});

	it("an unknown phase prints the usage and exits 1", () => {
		const run = spawnSync(process.execPath, [PROBE, "--phase", "nonsense"], { encoding: "utf8" });
		expect(run.status).toBe(1);
		expect(run.stdout).toContain("--phase <before-quit|rewrite|after-relaunch>");
	});
});

describe("the page-side expressions, evaluated against the DOM the plugin tests share with the real-Obsidian probe", () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	/** Runs an expression the way CDP's Runtime.evaluate does, with `app` in scope. */
	function evaluate(host: ReturnType<World["addHost"]>, expression: string): unknown {
		const app = { workspace: { getLeavesOfType: () => [{ view: host.view }] } };
		return new Function("app", `return ${expression}`)(app);
	}

	it("readEmbeds reports each arrow's own row text and fold state", () => {
		const w = new World();
		w.addNote("Competitive Coding Fundamentals.md", SOURCE_TEXT);
		const host = w.addHost(HOST, "live-preview", "![[Competitive Coding Fundamentals#^0169a6]]\n");
		w.renderToggle(arrowFor(host.embeds[0], "Lesson 8"), true);

		const embeds = JSON.parse(evaluate(host, readEmbedsExpression(HOST)) as string);

		expect(embeds).toHaveLength(1);
		expect(embeds[0].src).toBe("Competitive Coding Fundamentals#^0169a6");
		expect(embeds[0].arrows).toEqual([
			{ row: "Lesson 8: Collections and frequency counting", collapsed: true },
			{ row: "Count word frequency with a map", collapsed: false },
		]);
		// And the decision functions accept exactly this shape.
		expect(foldProblems("x", embeds[0], { folded: ["Lesson 8"], unfolded: ["Count word frequency"] })).toEqual([]);
	});

	it("arrowPoint finds the arrow by row text prefix within the embed with that src, and null for another", () => {
		const w = new World();
		w.addNote("Competitive Coding Fundamentals.md", SOURCE_TEXT);
		const host = w.addHost(HOST, "live-preview", "![[Competitive Coding Fundamentals#^0169a6]]\n");
		const src = "Competitive Coding Fundamentals#^0169a6";
		const scrolled = vi.fn();
		Element.prototype.scrollIntoView = scrolled; // jsdom has no layout engine, so no scrolling
		expect(evaluate(host, arrowPointExpression(HOST, src, "Lesson 8"))).toEqual({ x: 0, y: 0 }); // no layout in jsdom: the point is the arrow's zero rect
		expect(scrolled).toHaveBeenCalledTimes(1);
		expect(evaluate(host, arrowPointExpression(HOST, src, "No such row"))).toBeNull();
		expect(evaluate(host, arrowPointExpression(HOST, "Another#^zzz", "Lesson 8"))).toBeNull();
	});
});
