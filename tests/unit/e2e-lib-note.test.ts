import { afterEach, describe, expect, it } from "vitest";
import {
	ensureFolderExpression,
	renameDeletePaths,
	requireRecord,
	resolveNote,
	useNote,
	vaultPathForNote,
} from "../../scripts/e2e-lib.mjs";

/**
 * T99/T100/T101/T102 (PR-1 polish round 6). The real-Obsidian scripts folded whichever note was
 * the *active* editor, then looked its record up under a hand-typed vault key. In the tester's
 * container data.json held the folds under "Quarry/Tasks.md" while the script asked about
 * "Projects/Quarry/Tasks.md": the plugin had recorded a heading and a task correctly, for a
 * different note than the one the script was checking. These tests run the note-selection
 * helpers in scripts/e2e-lib.mjs through the same `evaluate` path the scripts use, against a
 * small model of Obsidian's vault and workspace. They prove the helpers' logic, not how real
 * Obsidian behaves; that stays the container run's job.
 */

interface FakeFile {
	path: string;
}

/** The slice of `app` the helpers touch: a vault with a root, a file index, and leaves. */
class FakeObsidian {
	files = new Map<string, FakeFile>();
	folders = new Set<string>();
	/** Path shown by each markdown leaf; `active` indexes it. */
	leaves: Array<{ file: FakeFile | null }> = [];
	active = -1;
	opened: string[] = [];

	constructor(
		readonly basePath: string,
		existing: string[],
	) {
		for (const path of existing) this.files.set(path, { path });
	}

	install(): void {
		const self = this;
		const leafFor = (index: number) => ({
			view: { get file() { return self.leaves[index].file; } },
			openFile: async (file: FakeFile) => {
				self.opened.push(file.path);
				self.leaves[index].file = file;
			},
		});
		(globalThis as unknown as { app: unknown }).app = {
			vault: {
				adapter: { getBasePath: () => self.basePath },
				getAbstractFileByPath: (path: string) =>
					self.files.get(path) ?? (self.folders.has(path) ? { path } : null),
				createFolder: async (path: string) => {
					self.folders.add(path);
				},
			},
			workspace: {
				get activeEditor() {
					const leaf = self.leaves[self.active];
					return leaf && leaf.file ? { file: leaf.file, editor: { cm: {} } } : null;
				},
				getLeavesOfType: () => self.leaves.map((_, index) => leafFor(index)),
				getLeaf: () => {
					if (self.leaves.length === 0) self.leaves.push({ file: null });
					return leafFor(self.active >= 0 ? self.active : 0);
				},
				setActiveLeaf: (leaf: { view: { file: FakeFile | null } }) => {
					const index = self.leaves.findIndex((candidate) => candidate.file === leaf.view.file);
					if (index >= 0) self.active = index;
				},
			},
		};
	}

	/** Leaf `index` shows `path`; `active` makes it the active one. */
	show(path: string, active = false): void {
		this.leaves.push({ file: this.files.get(path) ?? { path } });
		if (active) this.active = this.leaves.length - 1;
	}

	get activePath(): string | null {
		return this.leaves[this.active]?.file?.path ?? null;
	}
}

function fakeCdp() {
	return {
		send: async (method: string, params: Record<string, unknown> = {}) => {
			if (method !== "Runtime.evaluate") return {};
			const value = await (0, eval)(String(params.expression));
			return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
		},
		close: () => undefined,
	};
}

afterEach(() => {
	delete (globalThis as unknown as { app?: unknown }).app;
});

describe("vaultPathForNote", () => {
	it("is the path relative to the vault root, with forward slashes", () => {
		expect(vaultPathForNote("/config/test-vault", "/config/test-vault/Projects/Quarry/Tasks.md")).toBe("Projects/Quarry/Tasks.md");
		expect(vaultPathForNote("/config/test-vault/", "/config/test-vault/Tasks.md")).toBe("Tasks.md");
		expect(vaultPathForNote("C:\\vault", "C:\\vault\\Quarry\\Tasks.md")).toBe("Quarry/Tasks.md");
	});

	it("tells the two notes the tester's run confused apart", () => {
		const base = "/config/test-vault";
		expect(vaultPathForNote(base, `${base}/Quarry/Tasks.md`)).not.toBe(vaultPathForNote(base, `${base}/Projects/Quarry/Tasks.md`));
	});

	it("refuses a note outside the vault, or one that merely shares a name prefix", () => {
		expect(() => vaultPathForNote("/config/test-vault", "/elsewhere/Tasks.md")).toThrow(/not inside the vault root/);
		expect(() => vaultPathForNote("/config/test-vault", "/config/test-vault-2/Tasks.md")).toThrow(/not inside the vault root/);
		expect(() => vaultPathForNote("/config/test-vault", "/config/test-vault/")).toThrow(/not inside the vault root/);
	});
});

describe("requireRecord", () => {
	const data = { version: 1, files: { "Quarry/Tasks.md": { contentHash: "h", folds: [], dormant: [] } } };

	it("returns the record stored under the key", () => {
		expect(requireRecord(data, "Quarry/Tasks.md", "/d/data.json")).toBe(data.files["Quarry/Tasks.md"]);
	});

	it("names the key it looked up and the keys the file holds when there is no record (T100)", () => {
		expect(() => requireRecord(data, "Projects/Quarry/Tasks.md", "/d/data.json")).toThrow(
			/"Projects\/Quarry\/Tasks\.md".*\/d\/data\.json.*\["Quarry\/Tasks\.md"\]/,
		);
	});

	it("says so when data.json is missing", () => {
		expect(() => requireRecord(null, "Tasks.md", "/d/data.json")).toThrow(/missing or unreadable/);
	});
});

describe("renameDeletePaths", () => {
	it("derives the rename and the Archive move from the note's own key (T101)", () => {
		expect(renameDeletePaths("Projects/Quarry/Tasks.md")).toEqual({
			renamed: "Projects/Quarry/Tasks Q4.md",
			archiveFolder: "Projects/Archive",
			moved: "Projects/Archive/Tasks Q4.md",
		});
		expect(renameDeletePaths("Quarry/Tasks.md")).toEqual({
			renamed: "Quarry/Tasks Q4.md",
			archiveFolder: "Archive",
			moved: "Archive/Tasks Q4.md",
		});
	});
});

describe("ensureFolderExpression", () => {
	it("creates a missing folder through the vault and leaves an existing one alone (T101)", async () => {
		const vault = new FakeObsidian("/config/test-vault", []);
		vault.install();
		const evaluate = async () => (0, eval)(ensureFolderExpression("Projects/Archive"));
		expect(await evaluate()).toEqual({ ok: true, created: true });
		expect(vault.folders.has("Projects/Archive")).toBe(true);
		expect(await evaluate()).toEqual({ ok: true, created: false });
	});
});

describe("resolveNote / useNote", () => {
	it("resolveNote reports the vault root and the key without opening anything", async () => {
		const vault = new FakeObsidian("/config/test-vault", ["Projects/Quarry/Tasks.md"]);
		vault.install();
		const resolved = await resolveNote(fakeCdp(), "/config/test-vault/Projects/Quarry/Tasks.md");
		expect(resolved).toEqual({ basePath: "/config/test-vault", vaultPath: "Projects/Quarry/Tasks.md" });
		expect(vault.opened).toEqual([]);
	});

	it("makes --note the active editor when another note is active (T99/T102)", async () => {
		const vault = new FakeObsidian("/config/test-vault", ["Quarry/Tasks.md", "Projects/Quarry/Tasks.md"]);
		vault.show("Quarry/Tasks.md", true);
		vault.install();
		expect(vault.activePath).toBe("Quarry/Tasks.md");

		const target = await useNote(fakeCdp(), "/config/test-vault/Projects/Quarry/Tasks.md");

		expect(target.vaultPath).toBe("Projects/Quarry/Tasks.md");
		expect(vault.activePath).toBe("Projects/Quarry/Tasks.md");
	});

	it("does not reopen a note that is already the active editor", async () => {
		const vault = new FakeObsidian("/config/test-vault", ["Tasks.md"]);
		vault.show("Tasks.md", true);
		vault.install();
		await useNote(fakeCdp(), "/config/test-vault/Tasks.md");
		expect(vault.opened).toEqual([]);
	});

	it("switches to a pane that already shows the note instead of opening a second one", async () => {
		const vault = new FakeObsidian("/config/test-vault", ["Quarry/Tasks.md", "Tasks.md"]);
		vault.show("Quarry/Tasks.md", true);
		vault.show("Tasks.md");
		vault.install();
		await useNote(fakeCdp(), "/config/test-vault/Tasks.md");
		expect(vault.activePath).toBe("Tasks.md");
		expect(vault.opened).toEqual([]);
		expect(vault.leaves).toHaveLength(2);
	});

	it("throws naming the key and the note the editor actually shows when the vault has no such file", async () => {
		const vault = new FakeObsidian("/config/test-vault", ["Quarry/Tasks.md"]);
		vault.show("Quarry/Tasks.md", true);
		vault.install();
		await expect(useNote(fakeCdp(), "/config/test-vault/Missing.md", { timeoutMs: 150, pollMs: 20 })).rejects.toThrow(
			/"Missing\.md".*no file at Missing\.md.*"Quarry\/Tasks\.md"/,
		);
		expect(vault.activePath).toBe("Quarry/Tasks.md");
	});

	it("throws when the note is outside the vault root", async () => {
		new FakeObsidian("/config/test-vault", []).install();
		await expect(useNote(fakeCdp(), "/somewhere/else/Tasks.md")).rejects.toThrow(/not inside the vault root/);
	});
});
