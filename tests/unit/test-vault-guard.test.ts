import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TEST_VAULT_MARKER, assertDataFileInVault, assertNoteInTestVault, assertTestVault, assertTestVaultName, dataFileProblem, enclosingTestVault, testVaultNameProblem, testVaultProblem } from "../../scripts/lib/test-vault-guard.mjs";

const never = () => false;
const markerOnly = (path: unknown): boolean => path === `/Users/dan/Vault/${TEST_VAULT_MARKER}`;

describe("the e2e test-vault guard (PR-8 R6)", () => {
	it("accepts a folder named test-vault that is the vault Obsidian has open", () => {
		expect(testVaultProblem("/config/test-vault", "/config/test-vault", never)).toBeNull();
		expect(testVaultProblem("/config/test-vault/", "/config/test-vault", never)).toBeNull();
	});

	it("accepts a differently named folder that holds the marker file", () => {
		expect(testVaultProblem("/Users/dan/Vault", "/Users/dan/Vault", markerOnly)).toBeNull();
	});

	it("refuses a real vault: a name that is not test-vault and no marker", () => {
		expect(testVaultProblem("/Users/dan/Vault", "/Users/dan/Vault", never)).toMatch(/not a test vault/);
		expect(() => assertTestVault("/Users/dan/Vault", "/Users/dan/Vault", never)).toThrow(/test-vault guard/);
	});

	it("refuses a test vault that is not the one Obsidian has open (the CDP port points at another vault)", () => {
		expect(testVaultProblem("/config/test-vault", "/Users/dan/Vault", never)).toMatch(/has \/Users\/dan\/Vault open/);
	});

	it("refuses when the open vault cannot be read", () => {
		expect(testVaultProblem("/config/test-vault", null, never)).toMatch(/could not read/);
		expect(testVaultProblem("/config/test-vault", "", never)).toMatch(/could not read/);
	});

	it("a name that merely contains test-vault is not enough", () => {
		expect(testVaultProblem("/Users/dan/my-test-vault-copy", "/Users/dan/my-test-vault-copy", never)).toMatch(/not a test vault/);
	});

	it("looks for the marker on the real file system by default", () => {
		expect(testVaultProblem("/nonexistent-pfs-dir/Vault", "/nonexistent-pfs-dir/Vault")).toMatch(/not a test vault/);
	});
});

const identity = (path: string): string => path;

describe("the test-vault guard also covers the data.json that is deleted (PR-1 R1 of review 1)", () => {
	const vault = "/config/test-vault";
	const own = `${vault}/.obsidian/plugins/persistent-folded-state/data.json`;

	it("accepts the vault's own plugin data.json (the default --data)", () => {
		expect(dataFileProblem(vault, own, identity)).toBeNull();
		expect(dataFileProblem(`${vault}/`, own, identity)).toBeNull();
	});

	it("refuses a real vault's data.json given with --data while --vault-root is a test vault", () => {
		const real = "/Users/dan/Vault/.obsidian/plugins/persistent-folded-state/data.json";
		expect(dataFileProblem(vault, real, identity)).toMatch(/is not <vault root>/);
		expect(() => assertDataFileInVault(vault, real, identity)).toThrow(/test-vault guard/);
	});

	it("refuses a path that climbs out of the vault with ..", () => {
		expect(dataFileProblem(vault, `${vault}/.obsidian/plugins/../../../Vault/.obsidian/plugins/x/data.json`, identity)).not.toBeNull();
	});

	it("refuses a file inside the vault that is not a plugin data.json", () => {
		expect(dataFileProblem(vault, `${vault}/Notes/data.json`, identity)).not.toBeNull();
		expect(dataFileProblem(vault, `${vault}/.obsidian/plugins/x/main.js`, identity)).not.toBeNull();
		expect(dataFileProblem(vault, `${vault}/Salesforce Tech Test Rocketship Course.md`, identity)).not.toBeNull();
		expect(dataFileProblem(vault, vault, identity)).not.toBeNull();
	});

	it("refuses a sibling folder that merely starts with the vault's path", () => {
		expect(dataFileProblem(vault, "/config/test-vault-real/.obsidian/plugins/x/data.json", identity)).not.toBeNull();
	});

	it("follows symlinks: a plugin folder that links out of the vault is refused", () => {
		const root = mkdtempSync(join(tmpdir(), "pfs-guard-"));
		try {
			const vaultDir = join(root, "test-vault");
			const realDir = join(root, "real-vault", ".obsidian", "plugins", "x");
			mkdirSync(join(vaultDir, ".obsidian", "plugins"), { recursive: true });
			mkdirSync(realDir, { recursive: true });
			symlinkSync(realDir, join(vaultDir, ".obsidian", "plugins", "x"));
			expect(dataFileProblem(vaultDir, join(vaultDir, ".obsidian", "plugins", "x", "data.json"))).not.toBeNull();
			mkdirSync(join(vaultDir, ".obsidian", "plugins", "y"));
			expect(dataFileProblem(vaultDir, join(vaultDir, ".obsidian", "plugins", "y", "data.json"))).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("the name-only and note-in-vault checks (for scripts that write with Obsidian quit)", () => {
	it("testVaultNameProblem needs no open vault", () => {
		expect(testVaultNameProblem("/config/test-vault", never)).toBeNull();
		expect(testVaultNameProblem("/Users/dan/Vault", markerOnly)).toBeNull();
		expect(testVaultNameProblem("/Users/dan/Vault", never)).toMatch(/not a test vault/);
		expect(() => assertTestVaultName("/Users/dan/Vault", never)).toThrow(/test-vault guard/);
	});

	it("testVaultProblem can expect Obsidian to report another path (a container's view of the vault)", () => {
		expect(testVaultProblem("/host/mount/test-vault", "/config/test-vault", never, "/config/test-vault")).toBeNull();
		expect(testVaultProblem("/host/mount/test-vault", "/Users/dan/Vault", never, "/config/test-vault")).toMatch(/has \/Users\/dan\/Vault open/);
	});

	it("enclosingTestVault finds the vault a note sits in, however deep", () => {
		expect(enclosingTestVault("/config/test-vault/Tasks.md", never)).toBe("/config/test-vault");
		expect(enclosingTestVault("/config/test-vault/Folder/Sub/Tasks.md", never)).toBe("/config/test-vault");
		expect(enclosingTestVault("/Users/dan/Vault/Tasks.md", never)).toBeNull();
		expect(enclosingTestVault("/Users/dan/Vault/Tasks.md", markerOnly)).toBe("/Users/dan/Vault");
	});

	it("assertNoteInTestVault refuses a note in a real vault", () => {
		expect(() => assertNoteInTestVault("/Users/dan/Vault/Competitive Coding Fundamentals.md", never)).toThrow(/not inside a test vault/);
		expect(() => assertNoteInTestVault("/config/test-vault/Tasks.md", never)).not.toThrow();
	});
});
