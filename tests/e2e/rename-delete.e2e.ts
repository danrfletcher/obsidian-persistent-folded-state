#!/usr/bin/env node
/**
 * G9/G10 end to end against a real, already-running Obsidian: renames, moves and deletes a note
 * through Obsidian's own API (driven over CDP, the same way every other `tests/e2e/*.e2e.ts`/
 * `scripts/e2e-*-probe.mjs` in this repo drives a real action — see the file comment on
 * `--vault-cli` below for why "the Obsidian CLI" the spec names is read this way), then reads
 * `data.json` and reopens the note at each new path. Same CDP/data.json plumbing style as
 * `tests/e2e/dormant-baseline.e2e.ts` and `tests/e2e/relaunch.e2e.ts`: the shared helper
 * scripts/e2e-lib.mjs supplies the CDP client, the data.json helpers and the fold steps (scoped
 * to the active editor and confirmed from the DOM — PR-1 polish R3). Kept runnable as plain
 * Node + type-stripped TypeScript, no build step.
 *
 * Judgement call: Obsidian the desktop app has no separate command-line executable that renames,
 * moves or deletes a vault file on its own — "through the Obsidian CLI" is read here as "through
 * Obsidian's own vault API, the same real vault-event path a user's file-explorer action takes"
 * (`app.fileManager.renameFile`/`app.vault.delete`), driven over CDP the same way this plugin's
 * existing e2e scripts already drive `app.plugins.disablePlugin`/`enablePlugin` and
 * `app.commands.executeCommandById`. This is Obsidian's real, documented API for a rename/move/
 * delete done entirely from script (no mouse drag, no file-explorer context menu) rather than a
 * second, hand-rolled path this plugin's own `rename`/`delete` vault-event listeners wouldn't
 * see — a mouse-driven file-explorer drag is the container-verification checkpoints' job
 * (PR-7-rename.png/PR-7-delete.png), not this script's.
 *
 * Runs one continuous sequence (no Obsidian quit/relaunch needed, unlike GP4 — see
 * tests/e2e/relaunch.e2e.ts for that boundary):
 *
 *  1. Fresh start: copies tests/fixtures/tasks-before.md to --note, clears data.json, folds
 *     "## Tuesday" and "Draft proposal" by hand, confirms both are stored under --vault-path.
 *  2. Same-folder rename: Tasks.md -> Tasks Q4.md. Asserts data.json re-keyed (new path present,
 *     old path gone, contentHash/folds carried over unchanged — G9), then reopens the renamed
 *     file and asserts the same two blocks are still rendered folded ("stored folds follow").
 *  3. Cross-folder move: Tasks Q4.md -> Archive/Tasks Q4.md. Same re-key assertion.
 *  4. Delete: removes the note outright. Asserts data.json has no entry for any of the three
 *     paths this note has held (G10).
 *
 * Usage (inside the Obsidian desktop container, this plugin built and enabled, Obsidian already
 * running with --remote-debugging-port):
 *
 *   node tests/e2e/rename-delete.e2e.ts
 *   node tests/e2e/rename-delete.e2e.ts --cdp-port 9222 --note /config/test-vault/Projects/Quarry/Tasks.md
 *
 * Accepts [--cdp-port 9222] [--note <path>] [--data <path>] [--wait-ms 1500] [--help].
 *
 * T99/T100/T101: the note's vault-relative key (what the plugin stores folds under) is derived
 * from the vault root Obsidian reports, not typed in; --note is made the active editor before
 * any fold step; and the Archive folder the move targets is created through Obsidian first
 * (the move used to stop with ENOENT because nothing created it).
 *
 * Not run by `npm test` (vitest's own `include` is `tests/**\/*.test.ts`, which this file's
 * `.e2e.ts` extension deliberately does not match) and not run automatically by this coder turn
 * — it requires a real Obsidian instance in the build container, which the tester runs.
 */
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ensureFolderExpression,
	evaluate,
	foldAndConfirm,
	parkCursorOutsideFolds,
	readPluginData,
	readVisibleLines,
	renameDeletePaths,
	requireRecord,
	sleep,
	unfoldAll,
	useNote,
	withConnection,
} from "../../scripts/e2e-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_ID = "persistent-folded-state";
const DEFAULT_NOTE_PATH = "/config/test-vault/Projects/Quarry/Tasks.md";
const DEFAULT_DATA_PATH = `/config/test-vault/.obsidian/plugins/${PLUGIN_ID}/data.json`;
const BEFORE_FIXTURE = join(ROOT, "tests", "fixtures", "tasks-before.md");

// --- CLI ----------------------------------------------------------------------------------

interface Args {
	cdpPort: number;
	note: string;
	data: string;
	waitMs: number;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		cdpPort: 9222,
		note: DEFAULT_NOTE_PATH,
		data: DEFAULT_DATA_PATH,
		waitMs: 1500,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--cdp-port") args.cdpPort = Number(argv[++i]);
		else if (arg === "--note") args.note = argv[++i] ?? args.note;
		else if (arg === "--data") args.data = argv[++i] ?? args.data;
		else if (arg === "--wait-ms") args.waitMs = Number(argv[++i]);
		else if (arg === "--help" || arg === "-h") args.help = true;
	}
	return args;
}

function printUsage(): void {
	console.log(
		[
			"Usage: node tests/e2e/rename-delete.e2e.ts [options]",
			"",
			"Renames, moves then deletes a fixture note through Obsidian's own vault API (see the",
			"file comment for the 'Obsidian CLI' judgement call), asserting data.json and the",
			"editor's rendered folds at each step (G9/G10).",
			"",
			"Options: [--cdp-port 9222] [--note <path>] [--data <path>] [--wait-ms 1500]",
		].join("\n"),
	);
}

// --- page-side expressions -----------------------------------------------------------------

/** Obsidian's own rename/move API (see the file comment for why this, not a second hand-rolled
 * path) — `fileManager.renameFile` is what Obsidian's file-explorer rename/drag-to-move both
 * call under the hood, and fires the real `vault.on("rename", ...)` event this plugin's
 * src/main.ts listens for either way. */
function renameFileExpression(fromPath: string, toPath: string): string {
	return `
(async function () {
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(fromPath)});
	if (!file) return { renamed: false, reason: "file not found: " + ${JSON.stringify(fromPath)} };
	await app.fileManager.renameFile(file, ${JSON.stringify(toPath)});
	return { renamed: true };
})()
`;
}

function deleteFileExpression(path: string): string {
	return `
(async function () {
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
	if (!file) return { deleted: false, reason: "file not found: " + ${JSON.stringify(path)} };
	await app.vault.delete(file);
	return { deleted: true };
})()
`;
}

function openFileExpression(vaultPath: string): string {
	return `
(async function () {
	const file = app.vault.getAbstractFileByPath(${JSON.stringify(vaultPath)});
	if (!file) return { opened: false, reason: "file not found: " + ${JSON.stringify(vaultPath)} };
	// getLeaf(false) reuses the most recently active leaf (creating one if the workspace has
	// none at all) rather than detaching every markdown leaf and asking for a brand-new tab:
	// once this script's own detach-then-getLeaf("tab") emptied every tab group, Obsidian threw
	// "No tab group found" on the very first open (T2/T5) — this is the same single-pane reuse
	// a real user's own "open this file" action takes, and never needs a tab group to pre-exist.
	const leaf = app.workspace.getLeaf(false);
	await leaf.openFile(file);
	return { opened: true };
})()
`;
}

// --- main sequence --------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		return;
	}

	const problems: string[] = [];

	copyFileSync(BEFORE_FIXTURE, args.note);
	if (existsSync(args.data)) rmSync(args.data);

	await withConnection(args.cdpPort, async (cdp) => {
		// 1. Fresh start: open the note, fold two blocks by hand, confirm both are stored.
		// T99/T100: the key is derived from the vault root Obsidian reports, and the note is the
		// active editor before anything is folded.
		const target = await useNote(cdp, args.note);
		const vaultPath = target.vaultPath;
		const { renamed: renamedVaultPath, archiveFolder, moved: movedVaultPath } = renameDeletePaths(vaultPath);
		const renamedNotePath = join(target.basePath, renamedVaultPath);
		const movedNotePath = join(target.basePath, movedVaultPath);
		// An earlier run (or an earlier interrupted one) can leave its renamed/moved copy behind,
		// and a rename onto an existing file fails. Clear a leftover only when it is byte-for-byte
		// this run's own fixture; anything else is somebody's note — stop and say so.
		for (const [leftoverVaultPath, leftoverNotePath] of [
			[renamedVaultPath, renamedNotePath],
			[movedVaultPath, movedNotePath],
		] as const) {
			if (!existsSync(leftoverNotePath)) continue;
			if (readFileSync(leftoverNotePath, "utf8") !== readFileSync(BEFORE_FIXTURE, "utf8")) {
				throw new Error(`${JSON.stringify(leftoverVaultPath)} already exists and is not a copy of the fixture; move it away and re-run`);
			}
			const cleared = (await evaluate(cdp, deleteFileExpression(leftoverVaultPath), { awaitPromise: true })) as {
				deleted: boolean;
				reason?: string;
			};
			if (!cleared.deleted) throw new Error(`could not clear the leftover ${JSON.stringify(leftoverVaultPath)}: ${cleared.reason ?? "unknown"}`);
		}
		await sleep(args.waitMs);
		// R3: start from a note Obsidian did not restore (partly) folded — a fold click on a block
		// that is still folded would *unfold* it — then park the cursor outside every foldable
		// block (CM6 drops a fold that contains the selection head, T1) and fold each block with
		// e2e-lib's foldAndConfirm: scoped to the active editor, polled, confirmed from the DOM,
		// with the editor:toggle-fold fallback. A block that did not fold throws here, with a DOM
		// diagnostic, instead of surfacing later as a missing stored entry.
		const unfold = await unfoldAll(cdp, ["Outline", "Notes for Tuesday"], { waitMs: args.waitMs });
		if (!unfold.unfolded) throw new Error(`could not unfold the note first; still hidden: ${JSON.stringify(unfold.missing)}`);
		const cursor = await parkCursorOutsideFolds(cdp);
		if (!cursor.parked) throw new Error(`could not park the cursor outside the folds: ${cursor.reason ?? "unknown"}`);
		await sleep(args.waitMs);
		// T7: "Draft proposal" is folded *before* "## Tuesday" — it is a task nested directly
		// under the heading, so folding the heading first removes its line from the rendered DOM.
		for (const [needle, hidden] of [
			["Draft proposal", "Outline"],
			["Tuesday", "Notes for Tuesday"],
		] as const) {
			const step = await foldAndConfirm(cdp, needle, hidden, { waitMs: args.waitMs });
			if (!step.folded) throw new Error(`folding "${needle}" did not take: ${JSON.stringify(step)}`);
		}
		await sleep(args.waitMs);

		let data = readPluginData(args.data);
		const original = data?.files[vaultPath];
		if (!original) {
			// Name the key looked up and the keys the file holds (requireRecord's message).
			try {
				requireRecord(data, vaultPath, args.data);
			} catch (err) {
				problems.push(`setup: ${(err as Error).message} — cannot proceed`);
			}
			return;
		}

		// 2. Same-folder rename: Tasks.md -> Tasks Q4.md.
		const renamed = (await evaluate(cdp, renameFileExpression(vaultPath, renamedVaultPath), { awaitPromise: true })) as {
			renamed: boolean;
			reason?: string;
		};
		if (!renamed.renamed) problems.push(`rename failed: ${renamed.reason ?? "unknown"}`);
		await sleep(args.waitMs);
		data = readPluginData(args.data);
		if (data?.files[vaultPath]) problems.push("G9: old path still has a stored entry after rename");
		const afterRename = data?.files[renamedVaultPath];
		if (!afterRename) {
			problems.push("G9: no stored entry under the new path after rename");
		} else {
			if (afterRename.contentHash !== original.contentHash) problems.push("G9: contentHash changed across a rename (should be carried over unchanged)");
			if (afterRename.folds.length !== original.folds.length) problems.push("G9: fold count changed across a rename (should be carried over unchanged)");
		}
		// "stored folds follow": reopen the renamed file and confirm both blocks are still folded.
		const reopened = (await evaluate(cdp, openFileExpression(renamedVaultPath), { awaitPromise: true })) as {
			opened: boolean;
			reason?: string;
		};
		if (!reopened.opened) problems.push(`reopening the renamed file failed: ${reopened.reason ?? "unknown"}`);
		await sleep(args.waitMs);
		const visibleAfterRename = await readVisibleLines(cdp);
		if (visibleAfterRename.some((line) => line.includes("Notes for Tuesday"))) {
			problems.push("G9: \"## Tuesday\" is not folded after the rename — its body is visible");
		}
		if (visibleAfterRename.some((line) => line.includes("Outline") || line.includes("Review"))) {
			problems.push("G9: \"Draft proposal\" is not folded after the rename — its sub-tasks are visible");
		}
		if (existsSync(renamedNotePath)) {
			const onDisk = readFileSync(renamedNotePath, "utf8");
			const before = readFileSync(BEFORE_FIXTURE, "utf8");
			if (onDisk !== before) problems.push("F1: the note's bytes on disk changed across the rename — they must be identical");
		}

		// 3. Cross-folder move: Tasks Q4.md -> <Archive folder beside the note's folder>/Tasks Q4.md.
		// T101: the Archive folder does not exist in a fresh vault, and a rename into a missing
		// folder fails with ENOENT. Create it through Obsidian's vault first.
		await evaluate(cdp, ensureFolderExpression(archiveFolder), { awaitPromise: true });
		const moved = (await evaluate(cdp, renameFileExpression(renamedVaultPath, movedVaultPath), { awaitPromise: true })) as {
			renamed: boolean;
			reason?: string;
		};
		if (!moved.renamed) problems.push(`move failed: ${moved.reason ?? "unknown"}`);
		await sleep(args.waitMs);
		data = readPluginData(args.data);
		if (data?.files[renamedVaultPath]) problems.push("G9: pre-move path still has a stored entry after the folder move");
		if (!data?.files[movedVaultPath]) problems.push("G9: no stored entry under the moved-to path after the folder move");
		if (existsSync(movedNotePath)) {
			const onDisk = readFileSync(movedNotePath, "utf8");
			const before = readFileSync(BEFORE_FIXTURE, "utf8");
			if (onDisk !== before) problems.push("F1: the note's bytes on disk changed across the move — they must be identical");
		}

		// 4. Delete.
		const deleted = (await evaluate(cdp, deleteFileExpression(movedVaultPath), { awaitPromise: true })) as {
			deleted: boolean;
			reason?: string;
		};
		if (!deleted.deleted) problems.push(`delete failed: ${deleted.reason ?? "unknown"}`);
		await sleep(args.waitMs);
		data = readPluginData(args.data);
		for (const path of [vaultPath, renamedVaultPath, movedVaultPath]) {
			if (data?.files[path]) problems.push(`G10: a stored entry for "${path}" still exists after the delete`);
		}
	});

	if (problems.length === 0) {
		console.log("PASS rename-delete (G9/G10)");
	} else {
		console.log("FAIL rename-delete (G9/G10)");
		for (const problem of problems) console.log(`  - ${problem}`);
		process.exitCode = 1;
	}
}

main().catch((err: unknown) => {
	console.error(err);
	process.exitCode = 1;
});
