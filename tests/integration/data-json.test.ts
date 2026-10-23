/**
 * Integration (E7/E8): a real `data.json` file in a temp vault, at the exact path Obsidian
 * itself would use — `<vault>/.obsidian/plugins/persistent-folded-state/data.json` — with
 * `loadData`/`saveData` implemented the same way Obsidian's own `Plugin.loadData`/`saveData` do
 * (read/parse, or stringify/write, that file) — not a fake in-memory stand-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FoldStore } from "../../src/fold-store";
import { legacyLoadThenSave } from "../fixtures/legacy-sanitise-0.1.1";
import { seedData, SEED_EMBEDS, SEED_FILES } from "../fixtures/embed-seed";
import { buildAnchors } from "../../src/anchors";
import { sliceEmbed } from "../../src/embed-slice";
import * as similarityModule from "../../src/similarity";
import type { EmbedFoldRecord, StoredAnchor } from "../../src/types";
import { SOURCE, SOURCE_TEXT, World } from "../fixtures/embed-recording-world";
import { attachRestorer, foldedRows } from "../fixtures/embed-restore-world";

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
	// The seed's dormant entry is stamped at 1,000 ms; PR-7 forgets it after 10 minutes of wall
	// clock, so the clock (Date only) is pinned inside that window.
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(2_000);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

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

describe("data.json integration: a re-matched embed record (ticket warkworth-21, PR-6)", () => {
	const HOST = "Salesforce Tech Test Rocketship Course.md";
	const HOST_TEXT = "![[Competitive Coding Fundamentals#^0169a6]]\n";
	const LESSON_8 = "- [ ] Lesson 8: Collections and frequency counting ^0169a6";
	const RENAMED_TEXT = SOURCE_TEXT.replace(LESSON_8, "- [ ] Lesson 8 (revised): Collections and frequency counting ^0169a6");
	const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
	const worlds: World[] = [];

	afterEach(() => {
		for (const w of worlds.splice(0)) w.recorder.dispose();
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	/** What Dan's fold of Lesson 8 left in data.json, against the source as it was. */
	function storedLesson8(): EmbedFoldRecord {
		const slice = sliceEmbed(SOURCE_TEXT, "^0169a6");
		const anchor = buildAnchors(slice?.text ?? "").find((block) => block.anchor.text.startsWith("lesson 8"))?.anchor;
		return {
			host: HOST,
			target: SOURCE,
			subpath: "^0169a6",
			occurrence: 0,
			contentHash: slice?.hash ?? "",
			folds: [anchor as unknown as StoredAnchor],
			dormant: [],
		};
	}

	/** A restorer over a real file-backed store, a host with the embed, and the source text given.
	 * Real time: the render window, the pass and the re-check all run. */
	async function openHost(store: FoldStore, sourceText: string): Promise<{ w: World; embed: HTMLElement }> {
		const w = new World();
		worlds.push(w);
		w.addNote(SOURCE, sourceText);
		const restorer = attachRestorer(w, { store });
		const host = w.addHost(HOST, "live-preview", HOST_TEXT);
		await sleep(900);
		await restorer.whenIdle();
		restorer.dispose();
		return { w, embed: host.embeds[0] };
	}

	it("the refreshed anchors and content hash survive save and load, and a later render needs no matcher", async () => {
		const { dataPath, loadData, saveData } = await makeTempVault();
		const note = { contentHash: "n1", folds: [], dormant: [] };
		await writeFile(dataPath, JSON.stringify({ version: 1, files: { "Tasks.md": note }, embeds: [storedLesson8()] }), "utf8");
		const store = new FoldStore({ loadData, saveData });
		await store.load();

		// The source was rewritten while Obsidian was closed; the host is opened.
		const first = await openHost(store, RENAMED_TEXT);
		expect(foldedRows(first.embed)).toEqual(["Lesson 8 (revised): Collections and frequency counting"]);
		await store.flush();

		const onDisk = JSON.parse(await readFile(dataPath, "utf8"));
		const newHash = sliceEmbed(RENAMED_TEXT, "^0169a6")?.hash;
		expect(newHash).not.toBe(storedLesson8().contentHash);
		expect(onDisk.embeds).toHaveLength(1);
		expect(onDisk.embeds[0].contentHash).toBe(newHash);
		expect(onDisk.embeds[0].folds.map((f: { text: string }) => f.text)).toEqual(["lesson 8 (revised): collections and frequency counting ^0169a6"]);
		expect(onDisk.embeds[0]).toMatchObject({ host: HOST, target: SOURCE, subpath: "^0169a6", occurrence: 0, dormant: [] });
		expect(onDisk.files).toEqual({ "Tasks.md": note }); // the note-level section is untouched

		// A fresh load reads back exactly the refreshed record...
		const reloaded = new FoldStore({ loadData, saveData });
		await reloaded.load();
		expect(reloaded.embedRecords()).toEqual(onDisk.embeds);

		// ...and rendering the embed again, source unchanged, re-applies it without the matcher or a write.
		const similarity = vi.spyOn(similarityModule, "similarity");
		const bytes = await readFile(dataPath, "utf8");
		const second = await openHost(reloaded, RENAMED_TEXT);
		expect(foldedRows(second.embed)).toEqual(["Lesson 8 (revised): Collections and frequency counting"]);
		expect(similarity).not.toHaveBeenCalled();
		await reloaded.flush();
		expect(await readFile(dataPath, "utf8")).toBe(bytes);
	}, 20_000);

	it("PR-8: a file with no `embeds` section is byte-identical after an embed rename, delete and prune, and none is created", async () => {
		const { dataPath, loadData, saveData } = await makeTempVault();
		const original = JSON.stringify({ version: 1, files: { "Tasks.md": { contentHash: "n1", folds: [], dormant: [] } } });
		await writeFile(dataPath, original, "utf8");
		const store = new FoldStore({ loadData, saveData });
		await store.load();

		store.handleEmbedRename("Tasks.md", "Tasks Renamed.md");
		store.handleEmbedDelete("Tasks Renamed.md");
		store.pruneOrphanEmbeds(() => false);
		await store.flush();

		expect(await readFile(dataPath, "utf8")).toBe(original);
	});

	it("PR-8: an embed rename and a delete are written to the real file at once, and the next load reads them back", async () => {
		const { dataPath, loadData, saveData } = await makeTempVault();
		await writeFile(dataPath, JSON.stringify(seedData()), "utf8");
		const store = new FoldStore({ loadData, saveData });
		await store.load();

		store.handleEmbedRename("Rocketship.md", "Rocketship Q4.md");
		await store.flush();
		const renamed = JSON.parse(await readFile(dataPath, "utf8")) as { embeds: EmbedFoldRecord[] };
		expect(renamed.embeds.map((r) => r.host)).toEqual(["Rocketship Q4.md", "Rocketship Q4.md", "Rocketship Q4.md", "Other Host.md", "Other Host.md"]);

		store.handleEmbedDelete("Competitive Coding Fundamentals.md");
		await store.flush();
		const afterDelete = JSON.parse(await readFile(dataPath, "utf8")) as { embeds: EmbedFoldRecord[] };
		expect(afterDelete.embeds.map((r) => [r.host, r.target])).toEqual([["Other Host.md", "Rocketship Q4.md"]]); // the whole-note embed of the renamed note followed it

		const reloaded = new FoldStore({ loadData, saveData });
		await reloaded.load();
		expect(reloaded.embedRecords()).toEqual(afterDelete.embeds);
	});

	it("a file with no `embeds` section loads unchanged, and rendering an embed adds none", async () => {
		const { dataPath, loadData, saveData } = await makeTempVault();
		const original = JSON.stringify({ version: 1, files: { "Tasks.md": { contentHash: "n1", folds: [], dormant: [] } } });
		await writeFile(dataPath, original, "utf8");
		const store = new FoldStore({ loadData, saveData });
		await store.load();
		expect(store.embedSize).toBe(0);
		expect(store.size).toBe(1);

		const { embed } = await openHost(store, RENAMED_TEXT); // an embed renders with nothing stored for it
		expect(foldedRows(embed)).toEqual([]);
		await store.flush();

		expect(store.embedSize).toBe(0);
		expect(JSON.parse(await readFile(dataPath, "utf8"))).toEqual(JSON.parse(original));
		expect(await readFile(dataPath, "utf8")).not.toContain("embeds");
	}, 20_000);
});
