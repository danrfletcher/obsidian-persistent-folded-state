/**
 * scripts/e2e-restore-probe.mjs, the parts that run without Obsidian: where the report goes
 * (PR-3 T12: not into the worktree) and what a re-run on a healthy, already-folded note records
 * (PR-3 T16). The probe itself (CDP, a real Obsidian) is container-only.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_REPORT_PATH, foldIsSet, parseArgs, renderReport, runRewrite } from "../../scripts/e2e-restore-probe.mjs";

const ROOT = join(__dirname, "..", "..");
const inside = (path: string): boolean => {
	const rel = relative(ROOT, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

describe("the restore probe writes its report outside the repo (PR-3 T12)", () => {
	it("defaults to a file in the OS temp dir, not under the worktree", () => {
		const args = parseArgs([]);
		expect(args.report).toBe(DEFAULT_REPORT_PATH);
		expect(inside(args.report)).toBe(false);
	});

	it("--report chooses another path", () => {
		expect(parseArgs(["--report", "/tmp/elsewhere.md"]).report).toBe("/tmp/elsewhere.md");
		expect(parseArgs(["--phase", "report", "--report", "docs/x.md"]).report).toBe("docs/x.md");
	});
});

describe("a re-run on a note left healthy by an earlier run (PR-3 T16)", () => {
	const setup = {
		note: "/config/test-vault/Tasks.md",
		resetTuesday: { clicked: true, wasCollapsed: true },
		draftClick: { clicked: false, wasCollapsed: true, alreadyInState: true },
		tuesdayClick: { clicked: true, wasCollapsed: false },
		draftChildrenHidden: true,
		sendInvoicesVisibleAfterDraft: true,
		tuesdayBodyHidden: true,
		tuesdayCollapsed: true,
	};
	const verify = {
		tuesdayStillFolded: true,
		draftProposalV2StillFolded: true,
		sendInvoicesVisible: true,
		followUpCallVisible: true,
		fileByteIdentical: true,
	};

	it("records that Tuesday was opened first, and the gate passes", () => {
		const report = renderReport({ setup, verify });
		expect(report).toContain("Opened Tuesday first");
		expect(report).toContain('"clicked":true,"wasCollapsed":true');
		expect(report).toContain("**pass**");
	});

	it("a Draft proposal line that cannot be found is still a failed gate", () => {
		const lost = { ...setup, draftClick: { clicked: false, reason: 'no rendered .cm-line reads "Draft proposal"' } };
		expect(foldIsSet(lost.draftClick)).toBe(false);
		expect(renderReport({ setup: lost, verify })).toContain("**fail");
	});

	it("a fold already in the wanted state counts as set", () => {
		expect(foldIsSet({ clicked: false, alreadyInState: true })).toBe(true);
		expect(foldIsSet({ clicked: true })).toBe(true);
	});
});

describe("the restore probe's rewrite phase overwrites only a note in a test vault (PR-8 R6)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function noteIn(vaultName: string): { note: string; after: string } {
		const parent = mkdtempSync(join(tmpdir(), "pfs-restore-guard-"));
		dirs.push(parent);
		mkdirSync(join(parent, vaultName));
		const note = join(parent, vaultName, "Tasks.md");
		writeFileSync(note, "the real note\n", "utf8");
		const after = join(parent, "after.md");
		writeFileSync(after, "the rewritten note\n", "utf8");
		return { note, after };
	}

	it("refuses a note outside a test vault and leaves it as it was", async () => {
		const { note, after } = noteIn("Real Vault");
		await expect(runRewrite({ note, after, waitMs: 0 }, {})).rejects.toThrow(/test-vault guard/);
		expect(readFileSync(note, "utf8")).toBe("the real note\n");
	});

	it("overwrites a note inside a folder named test-vault with the after text", async () => {
		const { note, after } = noteIn("test-vault");
		const state: Record<string, unknown> = {};
		await runRewrite({ note, after, waitMs: 0 }, state);
		expect(readFileSync(note, "utf8")).toBe("the rewritten note\n");
		expect(state.rewrite).toMatchObject({ note, afterText: "the rewritten note\n" });
	});
});
