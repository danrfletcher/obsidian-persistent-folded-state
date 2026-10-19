#!/usr/bin/env node
/**
 * G9/G10 end to end against a real, already-running Obsidian: renames, moves and deletes a note
 * through Obsidian's own API (driven over CDP, the same way every other `tests/e2e/*.e2e.ts`/
 * `scripts/e2e-*-probe.mjs` in this repo drives a real action — see the file comment on
 * `--vault-cli` below for why "the Obsidian CLI" the spec names is read this way), then reads
 * `data.json` and reopens the note at each new path. Same CDP/data.json plumbing style as
 * `tests/e2e/dormant-baseline.e2e.ts` and `tests/e2e/relaunch.e2e.ts` (each script keeps its own
 * copy rather than sharing a module — see those files' own comments for why). Kept runnable as
 * plain Node + type-stripped TypeScript, no build step.
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
 * Accepts [--cdp-port 9222] [--note <path>] [--vault-path <Projects/Quarry/Tasks.md>]
 * [--data <path>] [--wait-ms 1500] [--help].
 *
 * Not run by `npm test` (vitest's own `include` is `tests/**\/*.test.ts`, which this file's
 * `.e2e.ts` extension deliberately does not match) and not run automatically by this coder turn
 * — it requires a real Obsidian instance in the build container, which the tester runs.
 */
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_ID = "persistent-folded-state";
const DEFAULT_NOTE_PATH = "/config/test-vault/Projects/Quarry/Tasks.md";
const DEFAULT_VAULT_PATH = "Projects/Quarry/Tasks.md";
const DEFAULT_DATA_PATH = `/config/test-vault/.obsidian/plugins/${PLUGIN_ID}/data.json`;
const BEFORE_FIXTURE = join(ROOT, "tests", "fixtures", "tasks-before.md");

// --- CDP (own copy — see the file comment above for why) ---------------------------------------

interface CdpTarget {
	type: string;
	webSocketDebuggerUrl?: string;
}

interface CdpConnection {
	send: (method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;
	close: () => void;
}

async function findDebuggableTarget(cdpPort: number): Promise<CdpTarget> {
	const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
	if (!res.ok) throw new Error(`CDP target list request failed: HTTP ${res.status}`);
	const targets = (await res.json()) as CdpTarget[];
	const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
	if (!target) throw new Error("no debuggable Obsidian window found on that CDP port");
	return target;
}

function connectCdp(webSocketDebuggerUrl: string): CdpConnection {
	const ws = new WebSocket(webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
	let closed = false;

	function rejectAllPending(err: Error): void {
		for (const { reject } of pending.values()) reject(err);
		pending.clear();
	}

	ws.addEventListener("message", (event: MessageEvent) => {
		const message = JSON.parse(String(event.data)) as { id?: number; error?: { message: string }; result?: unknown };
		if (message.id && pending.has(message.id)) {
			const entry = pending.get(message.id);
			pending.delete(message.id);
			if (!entry) return;
			if (message.error) entry.reject(new Error(message.error.message));
			else entry.resolve(message.result);
		}
	});
	ws.addEventListener("close", () => {
		closed = true;
		rejectAllPending(new Error("CDP socket closed"));
	});
	ws.addEventListener("error", () => rejectAllPending(new Error("CDP socket error")));

	const ready = new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
	});

	async function send(
		method: string,
		params: Record<string, unknown> = {},
		opts: { timeoutMs?: number } = {},
	): Promise<unknown> {
		const timeoutMs = opts.timeoutMs ?? 10000;
		await ready;
		if (closed) throw new Error(`CDP socket already closed, cannot send ${method}`);
		const id = nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});
			ws.send(JSON.stringify({ id, method, params }));
		});
	}

	return {
		send,
		close: () => {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
		},
	};
}

async function evaluate(
	cdp: CdpConnection,
	expression: string,
	opts: { awaitPromise?: boolean } = {},
): Promise<unknown> {
	await cdp.send("Runtime.enable");
	const result = (await cdp.send("Runtime.evaluate", {
		expression,
		returnByValue: true,
		awaitPromise: opts.awaitPromise ?? false,
	})) as { exceptionDetails?: unknown; result: { value: unknown } };
	if (result.exceptionDetails) throw new Error(`Runtime.evaluate threw: ${JSON.stringify(result.exceptionDetails)}`);
	return result.result.value;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withConnection<T>(cdpPort: number, fn: (cdp: CdpConnection) => Promise<T>): Promise<T> {
	const target = await findDebuggableTarget(cdpPort);
	if (!target.webSocketDebuggerUrl) throw new Error("debuggable target has no webSocketDebuggerUrl");
	const cdp = connectCdp(target.webSocketDebuggerUrl);
	try {
		return await fn(cdp);
	} finally {
		cdp.close();
	}
}

// --- this plugin's own data.json (read directly from the host filesystem) ----------------------

interface StoredFileRecordLike {
	contentHash: string;
	folds: { kind?: string }[];
	dormant: unknown[];
}

interface StoredDataLike {
	version: number;
	files: Record<string, StoredFileRecordLike>;
}

function readPluginData(dataPath: string): StoredDataLike | null {
	if (!existsSync(dataPath)) return null;
	try {
		return JSON.parse(readFileSync(dataPath, "utf8")) as StoredDataLike;
	} catch {
		return null;
	}
}

// --- CLI ----------------------------------------------------------------------------------

interface Args {
	cdpPort: number;
	note: string;
	vaultPath: string;
	data: string;
	waitMs: number;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		cdpPort: 9222,
		note: DEFAULT_NOTE_PATH,
		vaultPath: DEFAULT_VAULT_PATH,
		data: DEFAULT_DATA_PATH,
		waitMs: 1500,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--cdp-port") args.cdpPort = Number(argv[++i]);
		else if (arg === "--note") args.note = argv[++i] ?? args.note;
		else if (arg === "--vault-path") args.vaultPath = argv[++i] ?? args.vaultPath;
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
			"Options: [--cdp-port 9222] [--note <path>] [--vault-path <Projects/Quarry/Tasks.md>]",
			"         [--data <path>] [--wait-ms 1500]",
		].join("\n"),
	);
}

// --- page-side expressions -----------------------------------------------------------------

function clickFoldIndicatorNearExpression(needle: string): string {
	return `
(function () {
	const needle = ${JSON.stringify(needle)};
	const lines = Array.from(document.querySelectorAll(".cm-line"));
	const target = lines.find((el) => el.textContent && el.textContent.includes(needle));
	if (!target) return { clicked: false, reason: \`no rendered .cm-line contains "\${needle}"\` };
	const indicator = target.querySelector(".cm-fold-indicator .collapse-indicator") ||
		target.closest(".cm-line")?.previousElementSibling?.querySelector?.(".cm-fold-indicator .collapse-indicator");
	if (!indicator) return { clicked: false, reason: \`found the line but no fold-indicator on/near it\` };
	indicator.click();
	return { clicked: true };
})()
`;
}

const READ_VISIBLE_LINES_EXPRESSION = `
JSON.stringify(Array.from(document.querySelectorAll(".cm-line")).map((el) => el.textContent))
`;

function unfoldAllExpression(): string {
	return `
(function () {
	app.commands.executeCommandById("editor:unfold-all");
	return { unfolded: true };
})()
`;
}

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
	const leaves = app.workspace.getLeavesOfType("markdown");
	for (const leaf of leaves) leaf.detach();
	const leaf = app.workspace.getLeaf("tab");
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
	const quarryFolder = dirname(args.vaultPath); // "Projects/Quarry"
	const renamedVaultPath = join(quarryFolder, "Tasks Q4.md");
	const movedVaultPath = join("Projects/Archive", "Tasks Q4.md");
	const renamedNotePath = join(dirname(args.note), "Tasks Q4.md");
	const movedNotePath = join(dirname(args.note), "..", "Archive", "Tasks Q4.md");

	copyFileSync(BEFORE_FIXTURE, args.note);
	if (existsSync(args.data)) rmSync(args.data);

	await withConnection(args.cdpPort, async (cdp) => {
		// 1. Fresh start: open the note, fold two blocks by hand, confirm both are stored.
		const opened = (await evaluate(cdp, openFileExpression(args.vaultPath), { awaitPromise: true })) as {
			opened: boolean;
			reason?: string;
		};
		if (!opened.opened) throw new Error(`initial open failed: ${opened.reason ?? "unknown"}`);
		await sleep(args.waitMs);
		await evaluate(cdp, unfoldAllExpression());
		const tuesdayClick = (await evaluate(cdp, clickFoldIndicatorNearExpression("Notes for Tuesday"))) as { clicked: boolean; reason?: string };
		if (!tuesdayClick.clicked) throw new Error(`folding "## Tuesday" failed: ${tuesdayClick.reason ?? "unknown"}`);
		const taskClick = (await evaluate(cdp, clickFoldIndicatorNearExpression("Draft proposal"))) as { clicked: boolean; reason?: string };
		if (!taskClick.clicked) throw new Error(`folding "Draft proposal" failed: ${taskClick.reason ?? "unknown"}`);
		await sleep(args.waitMs);

		let data = readPluginData(args.data);
		const original = data?.files[args.vaultPath];
		if (!original) {
			problems.push("setup: no stored entry for the note after folding — cannot proceed");
			return;
		}

		// 2. Same-folder rename: Tasks.md -> Tasks Q4.md.
		const renamed = (await evaluate(cdp, renameFileExpression(args.vaultPath, renamedVaultPath), { awaitPromise: true })) as {
			renamed: boolean;
			reason?: string;
		};
		if (!renamed.renamed) problems.push(`rename failed: ${renamed.reason ?? "unknown"}`);
		await sleep(args.waitMs);
		data = readPluginData(args.data);
		if (data?.files[args.vaultPath]) problems.push("G9: old path still has a stored entry after rename");
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
		const visibleAfterRenameRaw = (await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION)) as string;
		const visibleAfterRename: string[] = JSON.parse(visibleAfterRenameRaw);
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

		// 3. Cross-folder move: Tasks Q4.md -> Projects/Archive/Tasks Q4.md.
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
		for (const path of [args.vaultPath, renamedVaultPath, movedVaultPath]) {
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
