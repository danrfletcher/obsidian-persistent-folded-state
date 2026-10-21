import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyExternalWrite, docWriteBlocker, renderReport } from "../../scripts/e2e-reload-probe.mjs";

/**
 * T58 (PR-1 polish round 4): a no-argument `npm run test:e2e` run that observed no transactions
 * rewrote the tracked docs/reload-shape.md with "Obsidian appears to replace the editor
 * state/view outright" and "userEvent values seen: (none)", contradicting the committed raw log
 * from a conclusive run of the same build. These tests cover the outcome classification, the
 * report text, and (by running the real script as a child process) that the default run never
 * touches the tracked doc.
 */

const SCRIPT = join(__dirname, "..", "..", "scripts", "e2e-reload-probe.mjs");
const TRACKED_DOC = join(__dirname, "..", "..", "docs", "reload-shape.md");

const EMPTY_WINDOW = {
	transactionCount: 0,
	docChangedCount: 0,
	docChangedNoAnnotationCount: 0,
	annotationsSeen: [] as string[],
	transactionsWithEffectsCount: 0,
	foldShapedEffectCount: 0,
	entries: [] as unknown[],
};

function externalWrite(overrides: Record<string, unknown>) {
	return {
		note: "/config/test-vault/Tasks.md",
		activeNotePath: "Tasks.md",
		waitMs: 3000,
		diskBytesUnchangedByPlugin: true,
		...EMPTY_WINDOW,
		...overrides,
	};
}

describe("classifyExternalWrite", () => {
	it("is emitted when a document-changing transaction was logged", () => {
		expect(
			classifyExternalWrite({ transactionCount: 1, docChangedCount: 1, activeNotePath: "Tasks.md", note: "/config/test-vault/Tasks.md" }),
		).toEqual({ outcome: "emitted" });
	});

	it("is inconclusive, not 'not emitted', when the spy logged nothing at all", () => {
		const result = classifyExternalWrite({
			transactionCount: 0,
			docChangedCount: 0,
			activeNotePath: "Tasks.md",
			note: "/config/test-vault/Tasks.md",
		});
		expect(result.outcome).toBe("inconclusive");
		expect(result.reason).toContain("no CM6 transaction at all");
	});

	it("is inconclusive when the active editor shows a different note", () => {
		const result = classifyExternalWrite({
			transactionCount: 3,
			docChangedCount: 0,
			activeNotePath: "Other/Scratch.md",
			note: "/config/test-vault/Tasks.md",
		});
		expect(result.outcome).toBe("inconclusive");
		expect(result.reason).toContain("Other/Scratch.md");
	});

	it("T130: a document change logged on a different active note is NOT 'emitted' (the tester's default run: Tasks.md written while Quarry/Empty.md was active)", () => {
		const result = classifyExternalWrite({
			transactionCount: 2,
			docChangedCount: 1,
			activeNotePath: "Quarry/Empty.md",
			note: "/config/test-vault/Tasks.md",
		});
		expect(result.outcome).toBe("inconclusive");
		expect(result.reason).toContain("Quarry/Empty.md");
		expect(result.reason).toContain("/config/test-vault/Tasks.md");
	});

	it("T130: the active note is compared on whole path segments, not as a string suffix", () => {
		const base = { transactionCount: 1, docChangedCount: 1, note: "/config/test-vault/Tasks.md" };
		expect(classifyExternalWrite({ ...base, activeNotePath: "MyTasks.md" }).outcome).toBe("inconclusive");
		expect(classifyExternalWrite({ ...base, activeNotePath: "Tasks.md" }).outcome).toBe("emitted");
		expect(
			classifyExternalWrite({ ...base, note: "/config/test-vault/Projects/Quarry/Tasks.md", activeNotePath: "Projects/Quarry/Tasks.md" }).outcome,
		).toBe("emitted");
	});

	it("T130: given the vault-relative key the run activated, only that exact path counts as the active note", () => {
		const base = { transactionCount: 1, docChangedCount: 1, note: "/config/test-vault/Projects/Quarry/Tasks.md" };
		const expectedActivePath = "Projects/Quarry/Tasks.md";
		expect(classifyExternalWrite({ ...base, expectedActivePath, activeNotePath: "Projects/Quarry/Tasks.md" }).outcome).toBe("emitted");
		expect(classifyExternalWrite({ ...base, expectedActivePath, activeNotePath: "Quarry/Tasks.md" }).outcome).toBe("inconclusive");
	});

	it("is 'not emitted' only when transactions were observed on the right note and none changed the document", () => {
		expect(
			classifyExternalWrite({ transactionCount: 2, docChangedCount: 0, activeNotePath: "Tasks.md", note: "/config/test-vault/Tasks.md" }),
		).toEqual({ outcome: "not emitted" });
	});

	it("still reports emitted when the active note path is unknown", () => {
		expect(classifyExternalWrite({ transactionCount: 1, docChangedCount: 1, activeNotePath: null, note: "/x/Tasks.md" })).toEqual({
			outcome: "emitted",
		});
	});
});

describe("docWriteBlocker", () => {
	it("blocks writing the tracked doc without an external-write run or after an inconclusive one", () => {
		expect(docWriteBlocker({})).toContain("has not been run");
		expect(docWriteBlocker({ externalWrite: { outcome: "inconclusive", reason: "spy saw nothing" } })).toContain("spy saw nothing");
	});

	it("allows a conclusive run", () => {
		expect(docWriteBlocker({ externalWrite: { outcome: "emitted" } })).toBeNull();
		expect(docWriteBlocker({ externalWrite: { outcome: "not emitted" } })).toBeNull();
	});
});

describe("renderReport", () => {
	it("an inconclusive run never claims Obsidian replaces the editor state outright", () => {
		const outcome = classifyExternalWrite({ transactionCount: 0, docChangedCount: 0, activeNotePath: "Tasks.md", note: "/config/test-vault/Tasks.md" });
		const report = renderReport({ obsidianVersion: "1.14.4", externalWrite: externalWrite(outcome) });
		expect(report).toContain("Outcome: **inconclusive**");
		expect(report).toContain("proves nothing about it");
		expect(report).not.toMatch(/replace the editor state/i);
		expect(report).not.toContain("**not emitted**");
		expect(report).toContain("(none: no transactions were observed at all)");
	});

	it("a conclusive emitted run reports the 'set' annotation and the classifier row", () => {
		const report = renderReport({
			obsidianVersion: "1.14.4",
			externalWrite: externalWrite({
				outcome: "emitted",
				transactionCount: 1,
				docChangedCount: 1,
				annotationsSeen: ["set"],
				entries: [{ t: 1, docChanged: true, userEvent: "set", effects: [] }],
			}),
		});
		expect(report).toContain("Outcome: **emitted**");
		expect(report).toContain("`userEvent` values seen in that window: set");
		expect(report).toContain("transaction-classifier.ts");
	});

	it("a 'not emitted' run does not assert that Obsidian replaces the editor outright", () => {
		const report = renderReport({
			externalWrite: externalWrite({ outcome: "not emitted", transactionCount: 2 }),
		});
		expect(report).toContain("Outcome: **not emitted**");
		expect(report).not.toMatch(/replace the editor state/i);
	});
});

describe("the script's default report destination (child process, no Obsidian needed)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pfs-reload-probe-test-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

	function run(args: string[]) {
		return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
	}

	it("`--phase report` renders to --report and leaves the tracked docs/reload-shape.md byte-identical", () => {
		const state = join(dir, "state.json");
		const report = join(dir, "report.md");
		writeFileSync(state, JSON.stringify({ externalWrite: externalWrite({ outcome: "inconclusive", reason: "spy saw nothing" }) }));
		const before = sha(TRACKED_DOC);
		const result = run(["--phase", "report", "--state", state, "--report", report]);
		expect(result.status).toBe(0);
		expect(sha(TRACKED_DOC)).toBe(before);
		expect(readFileSync(report, "utf8")).toContain("Outcome: **inconclusive**");
	});

	it("`--write-doc` refuses an inconclusive run: the tracked doc is untouched and the exit code is 1", () => {
		const state = join(dir, "state.json");
		const report = join(dir, "report.md");
		writeFileSync(state, JSON.stringify({ externalWrite: externalWrite({ outcome: "inconclusive", reason: "spy saw nothing" }) }));
		const before = sha(TRACKED_DOC);
		const result = run(["--phase", "report", "--state", state, "--report", report, "--write-doc"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Refusing to write");
		expect(result.stderr).toContain("spy saw nothing");
		expect(sha(TRACKED_DOC)).toBe(before);
		expect(existsSync(report)).toBe(true);
	});

	it("the committed docs/reload-shape.md is the conclusive result, not the inconclusive wording", () => {
		const doc = readFileSync(TRACKED_DOC, "utf8");
		expect(doc).toContain("Outcome: **emitted**");
		expect(doc).not.toMatch(/replace the editor state/i);
	});
});
