/**
 * Integration (E7/E8): a real `data.json` file in a temp vault, at the exact path Obsidian
 * itself would use — `<vault>/.obsidian/plugins/persistent-folded-state/data.json` — with
 * `loadData`/`saveData` implemented the same way Obsidian's own `Plugin.loadData`/`saveData` do
 * (read/parse, or stringify/write, that file) — not a fake in-memory stand-in.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FoldStore } from "../../src/fold-store";

const tempDirs: string[] = [];

async function makeTempVault(): Promise<{ dataPath: string; loadData: () => Promise<unknown>; saveData: (data: unknown) => Promise<void> }> {
	const vaultDir = await mkdtemp(join(tmpdir(), "persistent-folded-state-vault-"));
	tempDirs.push(vaultDir);
	const pluginDir = join(vaultDir, ".obsidian", "plugins", "persistent-folded-state");
	await mkdir(pluginDir, { recursive: true });
	const dataPath = join(pluginDir, "data.json");
	return {
		dataPath,
		// Mirrors Obsidian's own Plugin.loadData(): null if the file doesn't exist, parsed JSON
		// otherwise (and JSON.parse throws — rejecting the promise — on corrupt content).
		loadData: async () => {
			let raw: string;
			try {
				raw = await readFile(dataPath, "utf8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw err;
			}
			return JSON.parse(raw);
		},
		saveData: async (data: unknown) => {
			await writeFile(dataPath, JSON.stringify(data), "utf8");
		},
	};
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("data.json integration: round trip through real files", () => {
	it("flush writes a file that load() reads back identically", async () => {
		const { dataPath, loadData, saveData } = await makeTempVault();
		const store = new FoldStore({ loadData, saveData });
		await store.load();
		// PR-5: a fold entry must round-trip as a real Anchor (src/anchors.ts) — a bare
		// {kind, text} pair is a PR-2-era shape and is discarded by FoldStore's own load-time
		// validation (see tests/unit/load-sanitise.test.ts for that behaviour directly).
		const anchor = { kind: "heading", indent: 0, text: "tuesday", siblingIndex: 0, parentChain: [] };
		store.set("Projects/Quarry/Tasks.md", { contentHash: "abc", folds: [anchor], dormant: [] });
		await store.flush();

		const onDisk = JSON.parse(await readFile(dataPath, "utf8"));
		expect(onDisk).toEqual({
			version: 1,
			files: { "Projects/Quarry/Tasks.md": { contentHash: "abc", folds: [anchor], dormant: [] } },
		});

		const reloaded = new FoldStore({ loadData, saveData });
		await reloaded.load();
		expect(reloaded.get("Projects/Quarry/Tasks.md")).toEqual(onDisk.files["Projects/Quarry/Tasks.md"]);
	});

	it("is byte-identical across a disable/re-enable cycle that makes no changes", async () => {
		const { dataPath, loadData, saveData } = await makeTempVault();
		const first = new FoldStore({ loadData, saveData });
		await first.load();
		first.set("Tasks.md", { contentHash: "abc", folds: [], dormant: [] });
		await first.flush();
		const bytesAfterFirst = await readFile(dataPath, "utf8");

		const second = new FoldStore({ loadData, saveData }); // "re-enable": a fresh instance over the same file
		await second.load();
		// No changes made; nothing should be written just by loading.
		const bytesAfterSecondLoad = await readFile(dataPath, "utf8");
		expect(bytesAfterSecondLoad).toBe(bytesAfterFirst);
	});

	describe("corrupt files on disk (E8)", () => {
		it("zero-byte data.json starts empty, never throws", async () => {
			const { dataPath, loadData, saveData } = await makeTempVault();
			await writeFile(dataPath, "", "utf8");
			const store = new FoldStore({ loadData, saveData });
			await expect(store.load()).resolves.toBeUndefined();
			expect(store.size).toBe(0);
		});

		it("truncated JSON starts empty, never throws", async () => {
			const { dataPath, loadData, saveData } = await makeTempVault();
			await writeFile(dataPath, '{"version": 1, "files": {"Tasks.md": {"content', "utf8");
			const store = new FoldStore({ loadData, saveData });
			await expect(store.load()).resolves.toBeUndefined();
			expect(store.size).toBe(0);
		});

		it("non-JSON data.json starts empty, never throws", async () => {
			const { dataPath, loadData, saveData } = await makeTempVault();
			await writeFile(dataPath, "<<not json at all>>", "utf8");
			const store = new FoldStore({ loadData, saveData });
			await expect(store.load()).resolves.toBeUndefined();
			expect(store.size).toBe(0);
		});

		it("a missing data.json (never written yet) starts empty, never throws", async () => {
			const { loadData, saveData } = await makeTempVault(); // file never written
			const store = new FoldStore({ loadData, saveData });
			await expect(store.load()).resolves.toBeUndefined();
			expect(store.size).toBe(0);
		});

		it("recovers: the next flush after a corrupt load writes a valid file", async () => {
			const { dataPath, loadData, saveData } = await makeTempVault();
			await writeFile(dataPath, "not json", "utf8");
			const store = new FoldStore({ loadData, saveData });
			await store.load();
			expect(store.size).toBe(0);

			store.set("Tasks.md", { contentHash: "abc", folds: [], dormant: [] });
			await store.flush();

			const onDisk = JSON.parse(await readFile(dataPath, "utf8"));
			expect(onDisk.files["Tasks.md"]).toEqual({ contentHash: "abc", folds: [], dormant: [] });
		});
	});
});
