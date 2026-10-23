/**
 * The decision logic of scripts/e2e-embed-rematch-probe.mjs (ticket warkworth-21, PR-6, GP4, GP6,
 * F2, F7), run on states shaped like the ones the probe reads from a real Obsidian, and the one
 * phase that needs no Obsidian: `rewrite` writes the "after" fixture over the source note byte for
 * byte. The probe itself (CDP, a real Obsidian) is container-only; these are the parts a wrong
 * rule would silently skew.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnchors } from "../../src/anchors";
import { SOURCE_TEXT, World, arrowFor } from "../fixtures/embed-recording-world";
import { sliceEmbed } from "../../src/embed-slice";
import { ARROW_GLYPH_OFFSET_PX, arrowClickPoint, arrowPointExpression, clickWroteProblems, embedRecords, foldProblems, noteWriteProblem, parseArgs, readEmbedsExpression, refreshedRecordProblems, rewriteSource, rewriteSourceViaDocker, sha256, sourceFoldProblems, storedFoldProblems } from "../../scripts/e2e-embed-rematch-probe.mjs";

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
/** A scratch vault. Named test-vault by default, as the probe's test-vault guard requires; pass
 * another name for a vault the guard has to refuse. */
function tempVault(name = "test-vault"): string {
	const parent = mkdtempSync(join(tmpdir(), "pfs-rematch-probe-"));
	tempDirs.push(parent);
	const dir = join(parent, name);
	mkdirSync(dir);
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

		const run = spawnSync(process.execPath, [PROBE, "--phase", "rewrite", "--vault-root", vault, "--state", state, "--cdp-port", "1"], { encoding: "utf8" });

		expect(run.status).toBe(0);
		expect(run.stdout).toContain("PASS rewrite");
		const after = readFileSync(AFTER_FILE);
		expect(readFileSync(join(vault, SOURCE)).equals(after)).toBe(true);
		expect(readFileSync(join(vault, HOST), "utf8")).toBe(hostText);
		const saved = JSON.parse(readFileSync(state, "utf8"));
		expect(saved.rewrite).toMatchObject({ sourceSha: sha256(after.toString("utf8")), hostSha: sha256(hostText), live: false });
	});

	it("refuses to overwrite the source in a vault that is not a test vault, and leaves it untouched", () => {
		const vault = tempVault("Real Vault");
		const original = readFileSync(BEFORE_FILE, "utf8");
		writeFileSync(join(vault, SOURCE), original, "utf8");

		const run = spawnSync(process.execPath, [PROBE, "--phase", "rewrite", "--vault-root", vault, "--state", join(vault, "state.json"), "--cdp-port", "1"], { encoding: "utf8" });

		expect(run.status).toBe(1);
		expect(run.stderr).toContain("test-vault guard");
		expect(readFileSync(join(vault, SOURCE), "utf8")).toBe(original);
	});

	it("--write-before is refused in a vault that is not a test vault, before it writes", () => {
		const vault = tempVault("Real Vault");
		writeFileSync(join(vault, SOURCE), "real note\n", "utf8");

		const run = spawnSync(process.execPath, [PROBE, "--phase", "before-quit", "--write-before", "--vault-root", vault, "--state", join(vault, "state.json"), "--cdp-port", "1"], { encoding: "utf8" });

		expect(run.status).toBe(1);
		expect(run.stderr).toContain("test-vault guard");
		expect(readFileSync(join(vault, SOURCE), "utf8")).toBe("real note\n");
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

describe("where the probe clicks an arrow (PR-6 T1)", () => {
	it("presses on the glyph at the arrow's left edge, not its centre where the checkbox sits", () => {
		const rect = { left: 100, top: 40, width: 42, height: 24 };
		expect(arrowClickPoint(rect, ARROW_GLYPH_OFFSET_PX)).toEqual({ x: 106, y: 52 });
		expect(arrowClickPoint(rect, ARROW_GLYPH_OFFSET_PX).x).toBeLessThan(rect.left + rect.width / 2);
	});

	it("stays inside an arrow narrower than twice the offset", () => {
		expect(arrowClickPoint({ left: 10, top: 0, width: 8, height: 8 }, 6)).toEqual({ x: 14, y: 4 });
	});

	it("the page expression computes the point with that same function", () => {
		const expression = arrowPointExpression(HOST, "Competitive Coding Fundamentals#^0169a6", "Lesson 8");
		expect(expression).toContain(arrowClickPoint.toString());
		expect(expression).toContain(`arrowClickPoint(r, ${ARROW_GLYPH_OFFSET_PX})`);
		expect(expression).not.toContain("r.width / 2, y");
	});
});

describe("a click must not write to a note (PR-6 T1, F7)", () => {
	it("reports a note whose bytes differ after the click, and nothing for unchanged notes", () => {
		const before = { [SOURCE]: "- [ ] Lesson 8 ^0169a6\n", [HOST]: "![[x]]\n" };
		expect(clickWroteProblems("after the click", before, { ...before })).toEqual([]);
		const problems = clickWroteProblems("after the click", before, { ...before, [SOURCE]: "- [x] Lesson 8 ^0169a6\n" });
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain(SOURCE);
		expect(problems[0]).toContain("task checkbox");
	});
});

describe("the live rewrite goes through the container (PR-6 T2)", () => {
	it("runs docker exec with the text on stdin and the path as an argument, never through a shell string", () => {
		const run = vi.fn(() => ({ status: 0, stderr: "" }));
		const written = rewriteSourceViaDocker("desktop-warkworth", "/config/test-vault/Competitive Coding Fundamentals.md", "new text\n", run as never);
		expect(run).toHaveBeenCalledWith(
			"docker",
			["exec", "-i", "desktop-warkworth", "sh", "-c", 'cat > "$1"', "sh", "/config/test-vault/Competitive Coding Fundamentals.md"],
			{ input: "new text\n", encoding: "utf8" },
		);
		expect(written).toEqual({ sourcePath: "desktop-warkworth:/config/test-vault/Competitive Coding Fundamentals.md", sourceSha: sha256("new text\n"), bytes: 9 });
	});

	it("throws with the container's complaint when the write fails", () => {
		const run = () => ({ status: 1, stderr: "sh: cannot create: Permission denied\n" });
		expect(() => rewriteSourceViaDocker("box", "/v/x.md", "t", run as never)).toThrow(/exit 1: sh: cannot create: Permission denied/);
		expect(() => rewriteSourceViaDocker("box", "/v/x.md", "t", (() => ({ error: new Error("docker not found") })) as never)).toThrow(/docker not found/);
	});

	it("--container-vault-root defaults to /config/test-vault and can be set", () => {
		expect(parseArgs([]).containerVaultRoot).toBe("/config/test-vault");
		expect(parseArgs(["--container-vault-root", "/vault"]).containerVaultRoot).toBe("/vault");
	});
});

describe("noteWriteProblem: when the probe may overwrite the source note", () => {
	const none = () => false;
	const args = (over: Record<string, unknown> = {}) => ({ ...parseArgs([]), ...over });

	it("allows the default test vault when Obsidian has it open, or cannot be asked (host write)", () => {
		expect(noteWriteProblem(args(), "/config/test-vault", false, none)).toBeNull();
		expect(noteWriteProblem(args(), null, false, none)).toBeNull();
	});

	it("refuses a vault root that is not a test vault, with or without Obsidian reachable", () => {
		const real = args({ vaultRoot: "/Users/dan/Vault" });
		expect(noteWriteProblem(real, "/Users/dan/Vault", false, none)).toMatch(/not a test vault/);
		expect(noteWriteProblem(real, null, false, none)).toMatch(/not a test vault/);
	});

	it("refuses when the connected Obsidian has another vault open", () => {
		expect(noteWriteProblem(args(), "/Users/dan/Vault", false, none)).toMatch(/has \/Users\/dan\/Vault open/);
	});

	it("a source that climbs out of the vault root is refused", () => {
		expect(noteWriteProblem(args({ source: "../Vault/Competitive Coding Fundamentals.md" }), "/config/test-vault", false, none)).toMatch(/outside --vault-root/);
		expect(noteWriteProblem(args({ source: "/Users/dan/Vault/x.md" }), "/config/test-vault", false, none)).toMatch(/outside --vault-root/);
	});

	it("the write from inside the container needs Obsidian to confirm the container's vault", () => {
		const docker = args({ docker: "box", vaultRoot: "/host/mount/test-vault", containerVaultRoot: "/config/test-vault" });
		expect(noteWriteProblem(docker, "/config/test-vault", true, none)).toBeNull();
		expect(noteWriteProblem(docker, null, true, none)).toMatch(/could not read/);
		// The container's Obsidian has some other vault open: its path is not the --container-vault-root.
		expect(noteWriteProblem(docker, "/config/real-vault", true, none)).toMatch(/has \/config\/real-vault open/);
	});

	it("refuses a container vault root that is not a test vault even when Obsidian has it open and --vault-root is a test vault", () => {
		const docker = args({ docker: "box", vaultRoot: "/host/mount/test-vault", containerVaultRoot: "/config/Dan Vault" });
		// The write from inside the container (--live --docker) and a host write beside the container.
		expect(noteWriteProblem(docker, "/config/Dan Vault", true, none)).toMatch(/--container-vault-root \/config\/Dan Vault is not a test vault/);
		expect(noteWriteProblem(docker, "/config/Dan Vault", false, none)).toMatch(/--container-vault-root .* is not a test vault/);
		expect(noteWriteProblem(docker, null, true, none)).toMatch(/is not a test vault/);
		// A trailing slash on a test-vault root is still a test vault; a name that merely ends in test-vault is not.
		expect(noteWriteProblem({ ...docker, containerVaultRoot: "/config/test-vault/" }, "/config/test-vault/", true, none)).toBeNull();
		expect(noteWriteProblem({ ...docker, containerVaultRoot: "/config/not-test-vault" }, "/config/not-test-vault", true, none)).toMatch(/is not a test vault/);
	});

	it("a host write beside a container still checks Obsidian's view against the container root", () => {
		const docker = args({ docker: "box", vaultRoot: "/host/mount/test-vault", containerVaultRoot: "/config/test-vault" });
		expect(noteWriteProblem(docker, "/config/test-vault", false, none)).toBeNull();
		expect(noteWriteProblem(docker, "/host/mount/test-vault", false, none)).toMatch(/has \/host\/mount\/test-vault open/);
	});
});
