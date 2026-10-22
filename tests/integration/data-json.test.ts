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
import { legacyLoadThenSave } from "../fixtures/legacy-sanitise-0.1.1";
import { seedData, SEED_EMBEDS, SEED_FILES } from "../fixtures/embed-seed";

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

describe("data.json integration: embed records (ticket warkworth-21, PR-1)", () => {
	it("round trip: notes and embeds written by flush() load back identically", async () => {
		const { dataPath, loadData, saveData } = await makeTempVault();
		await writeFile(dataPath, JSON.stringify(seedData()), "utf8");
		const store = new FoldStore({ loadData, saveData });
		await store.load();
		expect(store.embedSize).toBe(5);

		store.set("Rocketship.md", { contentHash: "r2", folds: SEED_FILES["Rocketship.md"].folds, dormant: [] });
		await store.flush();

		const onDisk = JSON.parse(await readFile(dataPath, "utf8"));
		expect(onDisk).toEqual({
			version: 1,
			files: { "Rocketship.md": { ...SEED_FILES["Rocketship.md"], contentHash: "r2" }, "Other Host.md": SEED_FILES["Other Host.md"] },
			embeds: SEED_EMBEDS,
		});

		const reloaded = new FoldStore({ loadData, saveData });
		await reloaded.load();
		expect(reloaded.embedRecords()).toEqual(SEED_EMBEDS);
		expect(reloaded.get("Rocketship.md")?.contentHash).toBe("r2");
	});

	it("the snapshot omits `embeds` while there are none, so a notes-only file keeps its old shape", async () => {
		const { dataPath, loadData, saveData } = await makeTempVault();
		const store = new FoldStore({ loadData, saveData });
		await store.load();
		store.set("Tasks.md", { contentHash: "abc", folds: [], dormant: [] });
		await store.flush();
		const raw = await readFile(dataPath, "utf8");
		expect(JSON.parse(raw)).toEqual({ version: 1, files: { "Tasks.md": { contentHash: "abc", folds: [], dormant: [] } } });
		expect(raw).not.toContain("embeds");
	});

	it("forgetAll leaves a file with neither notes nor an embeds key", async () => {
		const { dataPath, loadData, saveData } = await makeTempVault();
		await writeFile(dataPath, JSON.stringify(seedData()), "utf8");
		const store = new FoldStore({ loadData, saveData });
		await store.load();
		store.forgetAll();
		await store.flush();
		expect(JSON.parse(await readFile(dataPath, "utf8"))).toEqual({ version: 1, files: {} });
	});

	it("forgetNote removes the note and its hosted embeds on disk and keeps the other host", async () => {
		const { dataPath, loadData, saveData } = await makeTempVault();
		await writeFile(dataPath, JSON.stringify(seedData()), "utf8");
		const store = new FoldStore({ loadData, saveData });
		await store.load();
		store.forgetNote("Rocketship.md");
		await store.flush();
		const onDisk = JSON.parse(await readFile(dataPath, "utf8"));
		expect(Object.keys(onDisk.files)).toEqual(["Other Host.md"]);
		expect(onDisk.embeds).toEqual(SEED_EMBEDS.filter((r) => r.host === "Other Host.md"));
	});

	it("is byte-identical across a disable/re-enable cycle that makes no changes, embeds included", async () => {
		const { dataPath, loadData, saveData } = await makeTempVault();
		await writeFile(dataPath, JSON.stringify(seedData()), "utf8");
		const before = await readFile(dataPath, "utf8");

		const first = new FoldStore({ loadData, saveData, now: () => 0 });
		await first.load();
		await first.flush();
		const second = new FoldStore({ loadData, saveData, now: () => 0 });
		await second.load();
		await second.flush();

		expect(await readFile(dataPath, "utf8")).toBe(before);
		expect(second.embedRecords()).toEqual(first.embedRecords());
	});

	describe("corrupt files still start empty, embeds included", () => {
		const corrupt: { label: string; content: string }[] = [
			{ label: "zero-byte", content: "" },
			{ label: "truncated mid-embed", content: '{"version": 1, "files": {}, "embeds": [{"host": "A.md", "tar' },
			{ label: "non-JSON", content: "<<not json>>" },
		];
		it.each(corrupt)("$label data.json: both maps empty, no throw, next flush writes a valid file", async ({ content }) => {
			const { dataPath, loadData, saveData } = await makeTempVault();
			await writeFile(dataPath, content, "utf8");
			const store = new FoldStore({ loadData, saveData });
			await expect(store.load()).resolves.toBeUndefined();
			expect(store.size).toBe(0);
			expect(store.embedSize).toBe(0);

			store.setEmbed({ host: "A.md", target: "B.md", subpath: "", occurrence: 0, contentHash: "h", folds: [], dormant: [] });
			await store.flush();
			const onDisk = JSON.parse(await readFile(dataPath, "utf8"));
			expect(onDisk.embeds).toHaveLength(1);
		});

		it("a missing data.json starts empty", async () => {
			const { loadData, saveData } = await makeTempVault();
			const store = new FoldStore({ loadData, saveData });
			await store.load();
			expect(store.embedSize).toBe(0);
		});

		it("an embeds section that is not an array on disk loads as no embeds, notes intact", async () => {
			const { dataPath, loadData, saveData } = await makeTempVault();
			await writeFile(dataPath, JSON.stringify({ ...seedData(), embeds: { host: "A.md" } }), "utf8");
			const store = new FoldStore({ loadData, saveData });
			await store.load();
			expect(store.embedSize).toBe(0);
			expect(store.get("Rocketship.md")).toEqual(SEED_FILES["Rocketship.md"]);
		});
	});

	describe("an older build (0.1.1 loader, saved copy) over a file written by this PR", () => {
		it("keeps every note's folds and drops only embeds when it loads and saves", async () => {
			const { dataPath, loadData, saveData } = await makeTempVault();
			const store = new FoldStore({ loadData, saveData });
			await store.load();
			for (const [path, record] of Object.entries(SEED_FILES)) store.set(path, record);
			for (const record of SEED_EMBEDS) store.setEmbed(record);
			await store.flush();
			const written = JSON.parse(await readFile(dataPath, "utf8"));
			expect(written.embeds).toHaveLength(5); // the PR file really does carry embeds

			// "0.1.1 loads, then saves": its sanitiser, then its {version, files} snapshot.
			const resaved = legacyLoadThenSave(await loadData());
			await saveData(resaved);

			const afterOldBuild = JSON.parse(await readFile(dataPath, "utf8"));
			expect(afterOldBuild).toEqual({ version: 1, files: SEED_FILES });
			expect("embeds" in afterOldBuild).toBe(false);

			// And this build reads the old build's output without trouble: notes kept, no embeds.
			const back = new FoldStore({ loadData, saveData });
			await back.load();
			expect(back.get("Rocketship.md")).toEqual(SEED_FILES["Rocketship.md"]);
			expect(back.get("Other Host.md")).toEqual(SEED_FILES["Other Host.md"]);
			expect(back.embedSize).toBe(0);
		});
	});
});
