#!/usr/bin/env node
/**
 * GP4 (PR-7), end to end against a real, already-running Obsidian — the "Dan quits Obsidian, a
 * git pull rewrites Tasks.md again, he relaunches and opens the note" golden-path sentence.
 * Reuses the exact GP1-GP3 fixture pair `tests/fixtures/tasks-before.md`/`tasks-after.md` (same
 * ones `tests/integration/restore-golden-path.test.ts` and `scripts/e2e-restore-probe.mjs`
 * already use) and the same CDP/data.json plumbing style as `tests/e2e/dormant-baseline.e2e.ts`
 * — each `scripts/e2e-*-probe.mjs`/`tests/e2e/*.e2e.ts` keeps its own copy of this rather than
 * sharing one module (see the file comment in `scripts/e2e-restore-probe.mjs` and
 * `tests/e2e/dormant-baseline.e2e.ts` for why: a `.ts`-extension relative import needs either
 * `allowImportingTsExtensions` or a project-wide config change this PR doesn't ask for). Kept
 * runnable as plain Node + type-stripped TypeScript, no build step.
 *
 * Exactly like `scripts/e2e-reload-probe.mjs`'s own `native-restore` phase, this script cannot
 * quit and relaunch Obsidian itself — it has no business hardcoding a container's Obsidian
 * binary path into a file that ships in the public plugin repo, and CDP only ever talks to an
 * already-running instance. Quitting and relaunching is the operator's job (per
 * `use-desktop-container.md`); this script's three phases bracket that:
 *
 *   --phase before-quit     fold "## Tuesday" and "Draft proposal" by hand (not "Send
 *                           invoices" — GP4 explicitly keeps it unfolded), exactly as GP1-GP3
 *                           already establish, and confirm both are stored. Operator then quits
 *                           Obsidian.
 *   --phase rewrite         pure filesystem: overwrite --note with tests/fixtures/tasks-after.md
 *                           (the GP2 rewrite: 4 lines inserted above "## Tuesday", the task
 *                           renamed to "Draft proposal v2", "Outline" ticked, a new child added
 *                           under "Send invoices"). No CDP connection — Obsidian is not running
 *                           at this point in the scenario. Operator then relaunches Obsidian and
 *                           opens --note.
 *   --phase after-relaunch  reconnects (retrying — Obsidian's CDP server isn't up immediately
 *                           after relaunch, same as e2e-reload-probe.mjs's native-restore phase),
 *                           then asserts: the stored content hash matches the rewritten file
 *                           (G8, hash differs -> re-match ran) and "## Tuesday" is folded (its
 *                           body not rendered). T18: the fixture has no heading after "##
 *                           Tuesday", so its own foldable range runs to EOF and everything
 *                           nested under it — "Draft proposal v2", "Send invoices", "Follow up
 *                           call" — is removed from the DOM entirely while it stays folded;
 *                           this phase expands "## Tuesday" via CDP before checking those, the
 *                           same way a user would, and then asserts "Draft proposal v2" is
 *                           folded (its sub-tasks not rendered) while "Send invoices" together
 *                           with its new child "Follow up call" are both visible (G8/E4: the
 *                           hash-changed re-match re-applies the active folds; it does not
 *                           force everything shut).
 *
 * Usage (inside the Obsidian desktop container, this plugin built and enabled, Obsidian already
 * running with --remote-debugging-port, --note already open, before the first phase):
 *
 *   node tests/e2e/relaunch.e2e.ts --phase before-quit
 *   # quit Obsidian by hand
 *   node tests/e2e/relaunch.e2e.ts --phase rewrite
 *   # relaunch Obsidian by hand, open --note
 *   node tests/e2e/relaunch.e2e.ts --phase after-relaunch
 *
 * Accepts [--cdp-port 9222] [--note <path>] [--vault-path <Projects/Quarry/Tasks.md>]
 * [--data <path>] [--wait-ms 1500] [--connect-retries 30] [--connect-retry-delay-ms 2000]
 * (after-relaunch only) [--help].
 *
 * Not run by `npm test` (vitest's own `include` is `tests/**\/*.test.ts`, which this file's
 * `.e2e.ts` extension deliberately does not match) and not run automatically by this coder turn
 * — it requires a real Obsidian instance in the build container, which the tester runs.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_ID = "persistent-folded-state";
const DEFAULT_NOTE_PATH = "/config/test-vault/Projects/Quarry/Tasks.md";
const DEFAULT_VAULT_PATH = "Projects/Quarry/Tasks.md";
const DEFAULT_DATA_PATH = `/config/test-vault/.obsidian/plugins/${PLUGIN_ID}/data.json`;
const BEFORE_FIXTURE = join(ROOT, "tests", "fixtures", "tasks-before.md");
const AFTER_FIXTURE = join(ROOT, "tests", "fixtures", "tasks-after.md");

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

async function findDebuggableTargetWithRetry(cdpPort: number, retries: number, delayMs: number): Promise<CdpTarget> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			return await findDebuggableTarget(cdpPort);
		} catch (err) {
			lastErr = err;
			await sleep(delayMs);
		}
	}
	throw new Error(`no debuggable Obsidian window on port ${cdpPort} after ${retries} retries: ${String(lastErr)}`);
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

async function withConnection<T>(
	cdpPort: number,
	fn: (cdp: CdpConnection) => Promise<T>,
	opts: { retries?: number; retryDelayMs?: number } = {},
): Promise<T> {
	const target =
		opts.retries && opts.retries > 1
			? await findDebuggableTargetWithRetry(cdpPort, opts.retries, opts.retryDelayMs ?? 0)
			: await findDebuggableTarget(cdpPort);
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

/** Duplicate of src/fold-store.ts's own `hashText` (same literal-duplication precedent as
 * tests/e2e/dormant-baseline.e2e.ts's own copy) — kept dependency-free from src/* so this file
 * stays a plain, independently-runnable script with no build step. */
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

// --- CLI --------------------------------------------------------------------------------------

const PHASES = ["before-quit", "rewrite", "after-relaunch"] as const;
type Phase = (typeof PHASES)[number];

interface Args {
	phase?: Phase;
	cdpPort: number;
	note: string;
	vaultPath: string;
	data: string;
	waitMs: number;
	connectRetries: number;
	connectRetryDelayMs: number;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		cdpPort: 9222,
		note: DEFAULT_NOTE_PATH,
		vaultPath: DEFAULT_VAULT_PATH,
		data: DEFAULT_DATA_PATH,
		waitMs: 1500,
		connectRetries: 30,
		connectRetryDelayMs: 2000,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--phase") args.phase = argv[++i] as Phase;
		else if (arg === "--cdp-port") args.cdpPort = Number(argv[++i]);
		else if (arg === "--note") args.note = argv[++i] ?? args.note;
		else if (arg === "--vault-path") args.vaultPath = argv[++i] ?? args.vaultPath;
		else if (arg === "--data") args.data = argv[++i] ?? args.data;
		else if (arg === "--wait-ms") args.waitMs = Number(argv[++i]);
		else if (arg === "--connect-retries") args.connectRetries = Number(argv[++i]);
		else if (arg === "--connect-retry-delay-ms") args.connectRetryDelayMs = Number(argv[++i]);
		else if (arg === "--help" || arg === "-h") args.help = true;
	}
	return args;
}

function printUsage(): void {
	console.log(
		[
			`Usage: node tests/e2e/relaunch.e2e.ts --phase <${PHASES.join("|")}> [options]`,
			"",
			"GP4 end to end: fold two blocks, quit Obsidian (by hand), rewrite the note on disk,",
			"relaunch Obsidian (by hand) and open the note, then assert the folds came back right.",
			"",
			"  --phase before-quit      fold '## Tuesday' and 'Draft proposal' by hand, confirm stored",
			"  --phase rewrite          overwrite --note with tests/fixtures/tasks-after.md (no CDP)",
			"  --phase after-relaunch   reconnect (retrying) and assert the GP4 outcome",
			"",
			"Options: [--cdp-port 9222] [--note <path>] [--vault-path <Projects/Quarry/Tasks.md>]",
			"         [--data <path>] [--wait-ms 1500]",
			"         [--connect-retries 30] [--connect-retry-delay-ms 2000] (after-relaunch only)",
		].join("\n"),
	);
}

// --- page-side expressions ----------------------------------------------------------------

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

/** T1 (PR-1 test round 1): CM6 drops a fold whose range contains the selection head, so a fold
 * click made while the cursor sits inside the block (a cursor left over from an earlier run, or
 * one Obsidian restored when it reopened the note) reports `clicked: true` and then leaves the
 * block unfolded. Park the cursor on the note's "# " title line, which lies outside every
 * foldable block of tests/fixtures/tasks-before.md, before folding anything. */
const PARK_CURSOR_OUTSIDE_FOLDS_EXPRESSION = `
(function () {
	const editor = app.workspace.activeEditor && app.workspace.activeEditor.editor;
	if (!editor) return { parked: false, reason: "no active editor" };
	const lines = editor.getValue().split("\\n");
	const title = lines.findIndex((line) => /^# /.test(line));
	editor.setCursor({ line: title >= 0 ? title : 0, ch: 0 });
	return { parked: true, line: title >= 0 ? title : 0 };
})()
`;

/** Clicks the fold indicator of the first rendered line containing `needle`, then confirms from
 * the DOM that `hiddenNeedle` is no longer rendered. A click that reports `clicked: true` but
 * folded nothing fails loudly with what was (not) hidden, instead of surfacing later as a
 * missing stored anchor (T1). */
async function foldAndConfirm(cdp: CdpConnection, needle: string, hiddenNeedle: string, waitMs: number): Promise<void> {
	const click = (await evaluate(cdp, clickFoldIndicatorNearExpression(needle))) as {
		clicked: boolean;
		reason?: string;
	};
	if (!click.clicked) throw new Error(`folding "${needle}" failed: ${click.reason ?? "unknown"}`);
	await sleep(waitMs);
	const lines = JSON.parse((await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION)) as string) as string[];
	if (lines.some((line) => line.includes(hiddenNeedle))) {
		throw new Error(
			`clicked the fold indicator for "${needle}" but "${hiddenNeedle}" is still rendered — the block did not fold`,
		);
	}
}

function unfoldAllExpression(): string {
	return `
(function () {
	app.commands.executeCommandById("editor:unfold-all");
	return { unfolded: true };
})()
`;
}

// --- phases --------------------------------------------------------------------------------

async function runBeforeQuit(args: Args): Promise<void> {
	copyFileSync(BEFORE_FIXTURE, args.note);
	if (existsSync(args.data)) rmSync(args.data);

	await withConnection(args.cdpPort, async (cdp) => {
		await evaluate(cdp, unfoldAllExpression());
		await sleep(args.waitMs);

		// GP1-GP3's own baseline: fold "## Tuesday" and the task "Draft proposal", leave the
		// sibling task "Send invoices" unfolded — exactly GP4's own starting point. Needle is
		// "Tuesday" (the heading line itself), not "Notes for Tuesday" (its body text): the
		// fixture has a blank line between the two, so a needle that only matches the body
		// forces clickFoldIndicatorNearExpression's previousElementSibling fallback, which lands
		// on that blank line instead of the heading and throws (T2/T4) — scripts/e2e-restore-probe.mjs
		// already uses this same "Tuesday" needle successfully for exactly this reason.
		//
		// T7: "Draft proposal" is folded *before* "## Tuesday", not after. In the real fixture
		// (tests/fixtures/tasks-before.md), "Draft proposal" is a task nested directly under
		// "## Tuesday" with nothing else between them — folding "## Tuesday" first removes
		// "Draft proposal"'s own line from the rendered DOM before the second click ever runs,
		// so that click always fails with "no rendered .cm-line contains ...". Folding the
		// nested task first, then the heading that contains it, works every time (the same
		// order the tester's own manual verification already used).
		// T1: park the cursor outside every foldable block, and let each step settle (and be
		// confirmed from the DOM) before the next, rather than firing unfold-all and both clicks
		// back to back and discovering a missing fold only in data.json.
		const cursor = (await evaluate(cdp, PARK_CURSOR_OUTSIDE_FOLDS_EXPRESSION)) as { parked: boolean; reason?: string };
		if (!cursor.parked) throw new Error(`could not park the cursor outside the folds: ${cursor.reason ?? "unknown"}`);
		await sleep(args.waitMs);
		await foldAndConfirm(cdp, "Draft proposal", "Outline", args.waitMs);
		await foldAndConfirm(cdp, "Tuesday", "Notes for Tuesday", args.waitMs);
		await sleep(args.waitMs);

		const data = readPluginData(args.data);
		const record = data?.files[args.vaultPath];
		if (!record) throw new Error("no stored entry for the note after folding — cannot proceed to quit");
		const nonFrontmatter = record.folds.filter((f) => f.kind !== "frontmatter");
		if (nonFrontmatter.length < 2) {
			throw new Error(
				`expected at least 2 stored anchors (Tuesday heading + Draft proposal task), got ${nonFrontmatter.length}`,
			);
		}

		console.log("PASS before-quit: folds set and stored. Quit Obsidian now, then run --phase rewrite.");
	});
}

function runRewrite(args: Args): void {
	const after = readFileSync(AFTER_FIXTURE, "utf8");
	writeFileSync(args.note, after, "utf8");
	console.log(
		`PASS rewrite: ${args.note} overwritten with tests/fixtures/tasks-after.md. ` +
			"Relaunch Obsidian now, open the note, then run --phase after-relaunch.",
	);
}

async function runAfterRelaunch(args: Args): Promise<void> {
	const problems: string[] = [];

	await withConnection(
		args.cdpPort,
		async (cdp) => {
			await sleep(args.waitMs);

			const data = readPluginData(args.data);
			const record = data?.files[args.vaultPath];
			if (!record) {
				problems.push("no stored entry for the note after relaunch");
			} else {
				const onDiskText = readFileSync(args.note, "utf8");
				const expectedHash = hashText(onDiskText);
				if (record.contentHash !== expectedHash) {
					problems.push(`contentHash mismatch: stored ${record.contentHash}, expected ${expectedHash} (G8 re-match may not have run)`);
				}
			}

			const visibleLinesRaw = (await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION)) as string;
			const visibleLines: string[] = JSON.parse(visibleLinesRaw);

			// "## Tuesday" folded: its body ("Notes for Tuesday.") must not be rendered.
			if (visibleLines.some((line) => line.includes("Notes for Tuesday"))) {
				problems.push('"## Tuesday" is not folded — its body is visible');
			}

			// T18: the fixture has no heading after "## Tuesday", so "## Tuesday"'s own
			// foldable range runs to EOF — "Draft proposal v2", "Send invoices" and "Follow up
			// call" are all nested inside it and are removed from the DOM entirely while
			// Tuesday stays folded, the same way "Notes for Tuesday" is above. Expand "##
			// Tuesday" (not "Draft proposal v2" — its own, separate fold must stay put) before
			// reading the nested lines below, matching how a user would actually see GP4's
			// described state (Draft proposal v2 folded, Send invoices and Follow up call
			// visible underneath it).
			const expand = (await evaluate(cdp, clickFoldIndicatorNearExpression("Tuesday"))) as {
				clicked: boolean;
				reason?: string;
			};
			if (!expand.clicked) {
				problems.push(`could not expand "## Tuesday" to check its nested lines: ${expand.reason}`);
			} else {
				await sleep(200);
				const expandedRaw = (await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION)) as string;
				const expandedLines: string[] = JSON.parse(expandedRaw);

				// "Draft proposal v2" folded: its sub-tasks must not be rendered.
				if (expandedLines.some((line) => line.includes("Outline") || line.includes("Review"))) {
					problems.push('"Draft proposal v2" is not folded — its sub-tasks are visible');
				}
				// "Send invoices" stays unfolded, including its new child "Follow up call" (GP4's
				// own "with its new child visible").
				if (!expandedLines.some((line) => line.includes("Send invoices"))) {
					problems.push('"Send invoices" line itself is not visible at all');
				}
				if (!expandedLines.some((line) => line.includes("Follow up call"))) {
					problems.push('"Send invoices"\' new child "Follow up call" is not visible — it should be, GP4 keeps that block unfolded');
				}
			}
		},
		{ retries: args.connectRetries, retryDelayMs: args.connectRetryDelayMs },
	);

	if (problems.length === 0) {
		console.log("PASS after-relaunch (GP4)");
	} else {
		console.log("FAIL after-relaunch (GP4)");
		for (const problem of problems) console.log(`  - ${problem}`);
		process.exitCode = 1;
	}
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.phase) {
		printUsage();
		process.exitCode = args.help ? 0 : 1;
		return;
	}

	if (args.phase === "before-quit") await runBeforeQuit(args);
	else if (args.phase === "rewrite") runRewrite(args);
	else if (args.phase === "after-relaunch") await runAfterRelaunch(args);
	else {
		printUsage();
		process.exitCode = 1;
	}
}

main().catch((err: unknown) => {
	console.error(err);
	process.exitCode = 1;
});
