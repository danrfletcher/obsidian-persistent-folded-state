#!/usr/bin/env node
/**
 * T4 (=R2/R7/T10): the real-Obsidian E5/G15 (first-open baseline) + G6 (dormant anchors kept
 * across disable/re-enable) proof the spec names at this literal path, reusing PR-2's own CDP
 * pattern (scripts/e2e-reload-probe.mjs established it first). Deliberately self-contained, not
 * importing a shared helper module: every scripts/e2e-*-probe.mjs already keeps its own copy of
 * this same CDP/data.json plumbing rather than sharing one (see the file comment in
 * e2e-restore-probe.mjs for why), and a `.ts`-extension relative import here would need either
 * `allowImportingTsExtensions` in tsconfig.json (this repo's `moduleResolution: "node"` already
 * resolves an extension-less specifier at compile time, but Node's own ESM loader refuses to
 * resolve one at runtime) or a project-wide config change outside what T4 asks for. Kept
 * runnable as plain Node + type-stripped TypeScript, no build step, same as every other e2e
 * probe in this repo.
 *
 * Runs two cases, both from R7's corrected phase list:
 *
 *  - closeAndReopen: disable the plugin, clear its data.json entry for --note while disabled,
 *    fold the task and its sibling list item by hand (native CM6 fold, same as a user would —
 *    see T14 below for why these two, not a heading and its own nested child), enable the
 *    plugin, then close and reopen --note in a fresh pane. The constructor-time baseline check
 *    in src/editor-watcher.ts only runs once, synchronously, when a `ViewPlugin` is built for a
 *    pane — this is the ordinary "a never-before-seen pane opens a file Obsidian already shows
 *    some folds for" path.
 *
 *  - reenableOverOpenPane: the same disable/clear/fold/enable sequence again, but *without*
 *    closing the pane this time — the second case R7 asked for. This is the path R2 originally
 *    flagged: every unit/integration test for the constructor-time baseline builds a jsdom
 *    `EditorView` whose *initial* state already has the fold baked in; real Obsidian may
 *    reconfigure an *already-open* pane's CM6 extensions (on re-enable) before or after its
 *    document text and native folds are fully loaded, which only a real Obsidian run can show.
 *    T2's own fix (src/main.ts calling `Workspace.updateOptions()`) is what makes an
 *    already-open pane pick up the freshly re-enabled extension at all — this case is also the
 *    only thing in this repo that exercises that fix against a real, already-open editor.
 *
 * Both cases assert: two anchors in data.json (the task candidate plus the sibling list
 * candidate — T1/T5/T11's own regression, since a heading's live fold ending at EOF would have
 * had the same issue, is still covered independently by tests/unit/baseline.test.ts and the
 * container-verification script's own heading fold), the stored `contentHash` matches the
 * note's on-disk text, and the content both folds hide stays hidden (not leaked into the
 * rendered editor) after the plugin adopts them as a baseline.
 *
 * T14: the checklist's own literal scenario — folding the heading `## Tuesday` and the nested
 * task `Draft proposal` that sits entirely inside that heading's section, then expecting both to
 * still be independently folded — cannot occur in real Obsidian for any nested heading/child
 * pair: CM6's own fold StateField removes a fold fully overlapped by a newly-added one,
 * regardless of fold order or whether the fold indicator or `editor:toggle-fold` made it. This
 * was reproduced repeatedly against the real container (see the T14 finding on record) and is
 * not something `src/baseline.ts`/`src/live-folds.ts` control. This file instead folds two
 * *non-overlapping sibling* blocks under the same heading — the task `- [ ] Draft proposal` and
 * the plain list `- Plain list item` right above it, neither nested in the other — which is
 * exactly the scenario the checklist's own adapted substitute (tester2's independent repro)
 * verified passes for real: both anchors stored, both blocks still hidden. This also sidesteps
 * R9's click-selector bug (the heading's own fold indicator sits on a different rendered line
 * than the needle text the old version of this file searched for) by never needing to click a
 * heading's fold indicator at all.
 *
 * Fixture: tests/fixtures/tasks-before.md (heading "## Tuesday" + a plain "- Plain list item"
 * with one nested child + "- [ ] Draft proposal" with three sub-tasks + a plain
 * "- [ ] Send invoices" sibling task) — the same fixture
 * scripts/e2e-dormant-baseline-probe.mjs already uses, and the checklist's own C29 scenario
 * (adapted per T14 to use two sibling blocks instead of a heading and its own nested child).
 *
 * Usage (inside the Obsidian desktop container, per use-desktop-container.md, with this plugin
 * built, Obsidian launched with --remote-debugging-port, and --note already open):
 *
 *   node tests/e2e/dormant-baseline.e2e.ts
 *   node tests/e2e/dormant-baseline.e2e.ts --cdp-port 9222 --note /config/test-vault/Quarry/Tasks.md
 *
 * Accepts [--cdp-port 9222] [--note <path>] [--vault-path <Quarry/Tasks.md>]
 * [--data <path to this plugin's data.json>] [--wait-ms 1500] [--help].
 *
 * Not run by `npm test` (vitest's own `include` is `tests/**\/*.test.ts`, which this file's
 * `.e2e.ts` extension deliberately does not match) and not run automatically by this coder
 * turn — it requires a real Obsidian instance in the build container, which the tester runs.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_ID = "persistent-folded-state";
const DEFAULT_NOTE_PATH = "/config/test-vault/Quarry/Tasks.md";
const DEFAULT_VAULT_PATH = "Quarry/Tasks.md";
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
		const message = JSON.parse(String(event.data)) as {
			id?: number;
			error?: { message: string };
			result?: unknown;
		};
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

// --- this plugin's own data.json (read/written directly from the host filesystem) -------------

interface StoredFileRecordLike {
	contentHash: string;
	folds: unknown[];
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

function writePluginData(dataPath: string, data: StoredDataLike): void {
	writeFileSync(dataPath, JSON.stringify(data), "utf8");
}

function recordFor(data: StoredDataLike | null, vaultPath: string): StoredFileRecordLike | undefined {
	return data?.files[vaultPath];
}

/** Duplicate of src/fold-store.ts's own `hashText` (same literal-duplication precedent as
 * scripts/e2e-dormant-baseline-probe.mjs's own `MAX_DORMANT_AGE_MS`) — kept dependency-free from
 * src/* so this file stays a plain, independently-runnable script with no build step. */
function hashText(text: string): string {
	const normalized = text.replace(/\r\n?/g, "\n");
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

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
			"Usage: node tests/e2e/dormant-baseline.e2e.ts [options]",
			"",
			"Runs both the close+reopen and re-enable-over-an-open-pane first-open-baseline cases",
			"(T4/R2/R7) against a real, already-running Obsidian.",
			"",
			"Options: [--cdp-port 9222] [--note <path>] [--vault-path <Quarry/Tasks.md>]",
			`         [--data <path>] [--wait-ms 1500]`,
			"",
			`--note defaults to ${DEFAULT_NOTE_PATH}, --data to ${DEFAULT_DATA_PATH}.`,
			"Requires a real Obsidian launched with --remote-debugging-port, this plugin built and",
			"enabled, and --note already open. See use-desktop-container.md.",
		].join("\n"),
	);
}

// --- page-side expressions ------------------------------------------------------------------

/** Same mechanism scripts/e2e-dormant-baseline-probe.mjs's own fold-click helper uses. */
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

function disablePluginExpression(): string {
	return `
(async function () {
	await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)});
	return { disabled: true };
})()
`;
}

function enablePluginExpression(): string {
	return `
(async function () {
	await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
	return { enabled: true };
})()
`;
}

/** R9(c): `reenableOverOpenPane` reuses the same open pane `closeAndReopen` already ran on, so
 * by the time its own step 3 runs, both target blocks are already folded from the previous
 * case's own baseline adoption — clicking their fold indicators again would *unfold* them
 * instead of setting up a clean "two folds made while disabled" state. Called unconditionally
 * at the start of every case (harmless no-op on a pane with nothing folded yet) so each case's
 * own fold clicks always start from the same unfolded baseline, regardless of what an earlier
 * case left live. */
function unfoldAllExpression(): string {
	return `
(function () {
	app.commands.executeCommandById("editor:unfold-all");
	return { unfolded: true };
})()
`;
}

/** T4/R7: closes every pane currently showing `vaultPath`, then opens it fresh in a new tab —
 * the "close and reopen the note" step R7 asks for, distinct from `reenableOverOpenPane`'s case
 * (which deliberately never does this). */
function closeAndReopenExpression(vaultPath: string): string {
	return `
(async function () {
	const path = ${JSON.stringify(vaultPath)};
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return { reopened: false, reason: "file not found: " + path };
	const leaves = app.workspace.getLeavesOfType("markdown")
		.filter((leaf) => leaf.view && leaf.view.file && leaf.view.file.path === path);
	for (const leaf of leaves) leaf.detach();
	const leaf = app.workspace.getLeaf("tab");
	await leaf.openFile(file);
	return { reopened: true, closedCount: leaves.length };
})()
`;
}

// --- shared case body -------------------------------------------------------------------------

interface CaseResult {
	name: string;
	ok: boolean;
	problems: string[];
}

async function runCase(
	cdp: CdpConnection,
	args: Args,
	name: string,
	{ reopen }: { reopen: boolean },
): Promise<CaseResult> {
	const problems: string[] = [];

	// 1. Disable the plugin.
	await evaluate(cdp, disablePluginExpression(), { awaitPromise: true });

	// 2. Clear this plugin's stored entry for --note while disabled — a genuine first open, not
	// a re-open of a path this test vault has already seen (R7).
	if (existsSync(args.data)) rmSync(args.data);

	// 2.5. R9(c): guarantee a clean, fully-unfolded starting point for the clicks below,
	// regardless of whatever an earlier case in this same run left folded live.
	await evaluate(cdp, unfoldAllExpression());

	// 3. Fold the task and its sibling list item by hand (native CM6 fold, same as a user
	// would) — the plugin is disabled, so neither fold is recorded yet; both should still be
	// adopted as the baseline once it's enabled. T14: these two are siblings under the same
	// heading, neither nested in the other, so CM6 never collapses one fold into the other the
	// way it does for a heading and its own nested child (see the file comment).
	const listClick = (await evaluate(cdp, clickFoldIndicatorNearExpression("Plain list item"))) as {
		clicked: boolean;
		reason?: string;
	};
	if (!listClick.clicked) problems.push(`list fold click failed: ${listClick.reason ?? "unknown"}`);
	const taskClick = (await evaluate(cdp, clickFoldIndicatorNearExpression("Draft proposal"))) as {
		clicked: boolean;
		reason?: string;
	};
	if (!taskClick.clicked) problems.push(`task fold click failed: ${taskClick.reason ?? "unknown"}`);

	// 4. Enable the plugin.
	await evaluate(cdp, enablePluginExpression(), { awaitPromise: true });

	// 5. Either close+reopen the note (first case) or leave the already-open pane alone (second
	// case — R7's "re-enable over an open pane").
	if (reopen) {
		const reopened = (await evaluate(cdp, closeAndReopenExpression(args.vaultPath), { awaitPromise: true })) as {
			reopened: boolean;
			reason?: string;
		};
		if (!reopened.reopened) problems.push(`close+reopen failed: ${reopened.reason ?? "unknown"}`);
	}

	await sleep(args.waitMs);

	// 6. Assert: two anchors, the content hash, and both blocks still hidden.
	const data = readPluginData(args.data);
	const record = recordFor(data, args.vaultPath);
	if (!record) {
		problems.push("no stored entry for the note at all after enabling the plugin");
		return { name, ok: problems.length === 0, problems };
	}

	const onDiskText = readFileSync(args.note, "utf8");
	const expectedHash = hashText(onDiskText);
	if (record.contentHash !== expectedHash) {
		problems.push(`contentHash mismatch: stored ${record.contentHash}, expected ${expectedHash}`);
	}
	if (record.folds.length !== 2) {
		problems.push(`expected 2 stored anchors (task + sibling list), got ${record.folds.length}`);
	}

	const visibleLinesRaw = (await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION)) as string;
	const visibleLines: string[] = JSON.parse(visibleLinesRaw);
	for (const needle of ["A nested list item", "Outline"]) {
		if (visibleLines.some((line) => line.includes(needle))) {
			problems.push(`"${needle}" is visible in the editor — a folded block leaked into view`);
		}
	}

	return { name, ok: problems.length === 0, problems };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		return;
	}

	copyFileSync(BEFORE_FIXTURE, args.note);

	const results = await withConnection(args.cdpPort, async (cdp) => {
		const closeAndReopen = await runCase(cdp, args, "closeAndReopen", { reopen: true });
		const reenableOverOpenPane = await runCase(cdp, args, "reenableOverOpenPane", { reopen: false });
		return [closeAndReopen, reenableOverOpenPane];
	});

	for (const result of results) {
		if (result.ok) {
			console.log(`PASS ${result.name}`);
		} else {
			console.log(`FAIL ${result.name}`);
			for (const problem of result.problems) console.log(`  - ${problem}`);
		}
	}

	// A completely clean, independently-persisted copy of this plugin's own data.json, for the
	// tester's own inspection after the run (mirrors scripts/e2e-*-probe.mjs's --state convention
	// without needing a separate flag for a single-run script).
	const finalData = readPluginData(args.data);
	if (finalData) writePluginData(args.data, finalData);

	process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}

main().catch((err: unknown) => {
	console.error(err);
	process.exitCode = 1;
});
