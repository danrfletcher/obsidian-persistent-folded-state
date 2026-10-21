#!/usr/bin/env node
/**
 * The E5/G15 (first-open baseline) + G6 (dormant folds) proof, run for real against a running
 * Obsidian (container-only — see use-desktop-container.md). Added for R2: this PR shipped
 * `src/baseline.ts`/`src/dormant.ts` and the unit/integration tests for them, but never the
 * real-Obsidian probe the spec asks for (`tests/e2e/dormant-baseline.e2e.ts` in the spec's own
 * naming; this repo's actual convention — see scripts/e2e-reload-probe.mjs and
 * scripts/e2e-restore-probe.mjs — is a `scripts/e2e-*-probe.mjs` plus an `npm run test:e2e:*`
 * script, so this follows that instead of adding a `tests/e2e/*.e2e.ts` file vitest would try
 * (and fail) to pick up).
 *
 * This matters beyond box-ticking (see the review that asked for this): the constructor-time
 * baseline check in src/editor-watcher.ts runs synchronously the moment a `ViewPlugin` instance
 * is built for a pane — before this plugin ever sees a single transaction. Every unit/
 * integration test for it builds a jsdom `EditorView` whose *initial* `EditorState` already has
 * the fold baked in (`state.update()` before the view is constructed — see
 * tests/integration/first-open-baseline.test.ts). Real Obsidian may not work that way: a fold a
 * user made in an *earlier* session could be restored into a freshly-built `EditorView` via a
 * transaction dispatched moments *after* construction (this is exactly what
 * scripts/e2e-reload-probe.mjs's own `native-restore` phase already caught once, logging a
 * fold-shaped effect with no `docChanged` and no `userEvent` arriving on an existing editor
 * after Obsidian relaunched — see docs/reload-shape.md). If baseline adoption and Obsidian's own
 * native fold restore ever race that way, the constructor's synchronous read could see zero
 * folds and store an empty baseline, silently losing the user's pre-existing folds the first
 * time this plugin (or this file) is enabled. Only a real-Obsidian run can show which happens —
 * this script is that run.
 *
 * Fixtures used (see the file comments there for why): tests/fixtures/tasks-before.md (heading +
 * a 3-subtask task + a plain task — matches the container-verification script's own
 * `Quarry/Tasks.md` fixture almost exactly) and tests/fixtures/dormant-task-rewritten.md (the
 * same note with the folded task's own block replaced by unrelated text, simulating an agent/
 * sync rewrite that leaves the task unrecognizable).
 *
 * Phases (reconnect-over-CDP style, same shape as the other two probes — see
 * scripts/e2e-reload-probe.mjs's file comment for the CDP/instrumentation rationale all three
 * reuse verbatim):
 *
 *   --phase seed              Writes the "before" fixture to --note and a folds-free fixture to
 *                             --empty-note, and clears this plugin's stored entry for both paths
 *                             (by deleting --data if present) so the next phase is a genuine
 *                             first open, not a re-open of a path this same test vault has seen
 *                             before.
 *   --phase baseline          G15/E5: clicks the fold-indicator triangle for "Draft proposal"
 *                             (the same mechanism a real user, or an earlier session, would have
 *                             used), then disables and re-enables this plugin over CDP — the
 *                             closest a non-interactive script can get to "the plugin sees an
 *                             already-folded note for the first time" without a full Obsidian
 *                             relaunch — and checks the resulting data.json entry plus the DOM
 *                             (nothing visibly changed; the block is still folded).
 *   --phase dormant-unfold    G6: overwrites --note with dormant-task-rewritten.md (the task
 *                             block replaced by unrelated text) from outside Obsidian, waits for
 *                             the settle + match, and checks that the block is now unfolded (no
 *                             confident match) and the anchor moved to data.json's `dormant`
 *                             list with a `dormantSince` timestamp.
 *   --phase dormant-refold    G6: overwrites --note with the original tasks-before.md again;
 *                             the dormant retry should find it and fold it straight back, with
 *                             the dormant list emptied.
 *   --phase dormant-forgotten G6: repeats the unrelated-text rewrite, disables the plugin,
 *                             rewrites the just-written dormant entry's `dormantSince` to
 *                             600,000ms in the past directly in data.json (the shortcut the
 *                             container-verification script itself names), re-enables the
 *                             plugin, then rewrites --note back to the original text once more —
 *                             this time the anchor must be forgotten outright, never refolded.
 *   --phase empty-baseline    G15: opens --empty-note (never seen before) in a new tab via
 *                             Obsidian's own `app.workspace`/`app.vault` API and checks data.json
 *                             gets an empty (`folds: [], dormant: []`) entry for it rather than
 *                             no entry at all.
 *   --phase report            (re)writes docs/dormant-baseline.md from the gathered state.
 *   --phase all               every phase above, in order, in one Obsidian session (the default).
 *
 * Usage (run inside the Obsidian desktop container, per use-desktop-container.md, with this
 * plugin built and Obsidian launched with --remote-debugging-port):
 *
 *   node scripts/e2e-dormant-baseline-probe.mjs                     # == --phase all
 *   node scripts/e2e-dormant-baseline-probe.mjs --phase seed
 *   node scripts/e2e-dormant-baseline-probe.mjs --phase baseline
 *   node scripts/e2e-dormant-baseline-probe.mjs --phase dormant-unfold
 *   node scripts/e2e-dormant-baseline-probe.mjs --phase dormant-refold
 *   node scripts/e2e-dormant-baseline-probe.mjs --phase dormant-forgotten
 *   node scripts/e2e-dormant-baseline-probe.mjs --phase empty-baseline
 *   node scripts/e2e-dormant-baseline-probe.mjs --phase report
 *
 * Every phase accepts [--cdp-port 9222] [--wait-ms 1500] [--state <path>] [--note <path>]
 * [--empty-note <path>] [--data <path to this plugin's data.json>].
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(ROOT, "docs", "dormant-baseline.md");
const DEFAULT_STATE_PATH = join(tmpdir(), "pfs-e2e-dormant-baseline-probe-state.json");

const PLUGIN_ID = "persistent-folded-state";
const DEFAULT_NOTE_PATH = "/config/test-vault/Quarry/Tasks.md";
const DEFAULT_NOTE_VAULT_PATH = "Quarry/Tasks.md";
const DEFAULT_EMPTY_NOTE_PATH = "/config/test-vault/Quarry/Empty.md";
const DEFAULT_EMPTY_NOTE_VAULT_PATH = "Quarry/Empty.md";
const DEFAULT_DATA_PATH = `/config/test-vault/.obsidian/plugins/${PLUGIN_ID}/data.json`;

const BEFORE_FIXTURE = join(ROOT, "tests", "fixtures", "tasks-before.md");
const REWRITTEN_FIXTURE = join(ROOT, "tests", "fixtures", "dormant-task-rewritten.md");
const EMPTY_FIXTURE = join(ROOT, "tests", "fixtures", "dormant-baseline-empty.md");

const EXPLICIT_PHASES = ["seed", "baseline", "dormant-unfold", "dormant-refold", "dormant-forgotten", "empty-baseline", "report"];
const PHASES = ["all", ...EXPLICIT_PHASES];

const MAX_DORMANT_AGE_MS = 600_000; // src/dormant.ts's own MAX_DORMANT_AGE_MS — kept as a literal
// here (not imported) so this script stays a plain, independently-runnable Node file with no
// dependency on the plugin's own TypeScript build, same as the other two probes.

function parseArgs(argv) {
	const args = { cdpPort: 9222, waitMs: 1500, state: DEFAULT_STATE_PATH };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--phase") args.phase = argv[++i];
		else if (arg === "--note") args.note = argv[++i];
		else if (arg === "--empty-note") args.emptyNote = argv[++i];
		else if (arg === "--data") args.data = argv[++i];
		else if (arg === "--cdp-port") args.cdpPort = Number(argv[++i]);
		else if (arg === "--wait-ms") args.waitMs = Number(argv[++i]);
		else if (arg === "--state") args.state = argv[++i];
		else if (arg === "--help" || arg === "-h") args.help = true;
	}
	return args;
}

function printUsage() {
	console.log(
		[
			`Usage: node scripts/e2e-dormant-baseline-probe.mjs [--phase <${PHASES.join("|")}>] [options]`,
			"",
			"  (no --phase)                       same as --phase all (the default)",
			"  --phase all                         seed + baseline + dormant-unfold + dormant-refold +",
			"                                      dormant-forgotten + empty-baseline + report",
			"  --phase seed                        write fixtures, clear this plugin's stored entries for them",
			"  --phase baseline                    G15/E5: fold the task, toggle the plugin, check the baseline",
			"  --phase dormant-unfold              G6: external rewrite that breaks the match -> dormant",
			"  --phase dormant-refold              G6: external rewrite that restores the text -> refolds",
			"  --phase dormant-forgotten           G6: age the dormant entry past 600,000ms -> forgotten",
			"  --phase empty-baseline              G15: open a never-seen, fold-free note -> empty entry",
			"  --phase report                      (re)write docs/dormant-baseline.md from --state",
			"",
			"Options: [--cdp-port 9222] [--wait-ms 1500] [--state <path>] [--note <path>]",
			"         [--empty-note <path>] [--data <path to this plugin's data.json>]",
			"",
			`--note defaults to ${DEFAULT_NOTE_PATH}, --empty-note to ${DEFAULT_EMPTY_NOTE_PATH},`,
			`--data to ${DEFAULT_DATA_PATH} (the container test vault's own plugin data file).`,
			"Requires a real Obsidian launched with --remote-debugging-port, this plugin built, and",
			"the --note fixture already open in Live Preview (--phase seed does not open it — Obsidian",
			"itself, or an earlier run, must have it open). See use-desktop-container.md.",
		].join("\n")
	);
}

// --- state file (outside the repo; merges phases run as separate process invocations) --------

function loadState(path) {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

function saveState(path, state) {
	writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
}

// --- this plugin's own data.json (read/written directly from the host filesystem) -------------

function readPluginData(dataPath) {
	if (!existsSync(dataPath)) return null;
	try {
		return JSON.parse(readFileSync(dataPath, "utf8"));
	} catch {
		return null;
	}
}

function writePluginData(dataPath, data) {
	writeFileSync(dataPath, JSON.stringify(data), "utf8");
}

function recordFor(data, vaultPath) {
	return data && data.files ? data.files[vaultPath] : undefined;
}

// --- CDP (own copy — see the file comment in e2e-restore-probe.mjs for why each probe keeps
// one rather than sharing) ----------------------------------------------------------------------

async function findDebuggableTarget(cdpPort) {
	const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
	if (!res.ok) throw new Error(`CDP target list request failed: HTTP ${res.status}`);
	const targets = await res.json();
	const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
	if (!target) throw new Error("no debuggable Obsidian window found on that CDP port");
	return target;
}

function connectCdp(webSocketDebuggerUrl) {
	const ws = new WebSocket(webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map();
	let closed = false;

	function rejectAllPending(err) {
		for (const { reject } of pending.values()) reject(err);
		pending.clear();
	}

	ws.addEventListener("message", (event) => {
		const message = JSON.parse(event.data.toString());
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(message.error.message));
			else resolve(message.result);
		}
	});
	ws.addEventListener("close", () => {
		closed = true;
		rejectAllPending(new Error("CDP socket closed"));
	});
	ws.addEventListener("error", () => rejectAllPending(new Error("CDP socket error")));

	const ready = new Promise((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
	});

	async function send(method, params = {}, { timeoutMs = 10000 } = {}) {
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

	return { send, close: () => ws.readyState === WebSocket.OPEN && ws.close() };
}

async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
	await cdp.send("Runtime.enable");
	const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
	if (result.exceptionDetails) throw new Error(`Runtime.evaluate threw: ${JSON.stringify(result.exceptionDetails)}`);
	return result.result.value;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withConnection(cdpPort, fn) {
	const target = await findDebuggableTarget(cdpPort);
	const cdp = connectCdp(target.webSocketDebuggerUrl);
	try {
		return await fn(cdp);
	} finally {
		cdp.close();
	}
}

// --- page-side expressions ----------------------------------------------------------------

/** Same mechanism e2e-restore-probe.mjs's own fold-click helper uses — see that file's comment. */
function clickFoldIndicatorNearExpression(needle) {
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

function visibleLinesInclude(visibleLines, needle) {
	return visibleLines.some((line) => line.includes(needle));
}

/** Disables then re-enables this plugin through Obsidian's own public `app.plugins` API — the
 * closest a non-interactive script can get, without a full relaunch, to "this plugin sees an
 * already-folded note for the first time": every open pane's `ViewPlugin` (including its
 * constructor-time baseline check) is torn down and rebuilt when a plugin re-enables, the same
 * as happens when a user actually installs/enables it for the first time against an already-
 * folded vault. */
function toggleReenablePluginExpression() {
	return `
(async function () {
	const id = ${JSON.stringify(PLUGIN_ID)};
	await app.plugins.disablePlugin(id);
	await app.plugins.enablePlugin(id);
	return { toggled: true };
})()
`;
}

function openFileExpression(vaultPath) {
	return `
(async function () {
	const path = ${JSON.stringify(vaultPath)};
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return { opened: false, reason: "file not found: " + path };
	const leaf = app.workspace.getLeaf("tab");
	await leaf.openFile(file);
	return { opened: true };
})()
`;
}

// --- phases ---------------------------------------------------------------------------------

function runSeed(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	const emptyNote = args.emptyNote ?? DEFAULT_EMPTY_NOTE_PATH;
	const data = args.data ?? DEFAULT_DATA_PATH;

	copyFileSync(BEFORE_FIXTURE, note);
	copyFileSync(EMPTY_FIXTURE, emptyNote);

	// A genuine first open needs no pre-existing store entry for either path — this test vault
	// may have seen them in an earlier run, so clear the whole data.json rather than trying to
	// surgically remove two keys from whatever shape an older PR's version wrote. Dedicated e2e
	// test vault only (never a real one): see the file comment.
	let clearedData = false;
	if (existsSync(data)) {
		unlinkSync(data);
		clearedData = true;
	}

	state.seed = { note, emptyNote, data, clearedData };
}

/** Closes every pane showing `vaultPath` and opens it again in a new tab — the "close and reopen
 * the note" step, the path where real Obsidian may build the EditorView after the plugin's
 * constructor-time check has already read an empty state. */
function closeAndReopenExpression(vaultPath) {
	return `
(async function () {
	const path = ${JSON.stringify(vaultPath)};
	app.workspace.getLeavesOfType("markdown")
		.filter((leaf) => leaf.view && leaf.view.file && leaf.view.file.path === path)
		.forEach((leaf) => leaf.detach());
	const file = app.vault.getAbstractFileByPath(path);
	if (!file) return { reopened: false, reason: "file not found: " + path };
	await app.workspace.getLeaf("tab").openFile(file);
	return { reopened: true };
})()
`;
}

function disablePluginExpression() {
	return `(async function () { await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)}); return { disabled: true }; })()`;
}

function enablePluginExpression() {
	return `(async function () { await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)}); return { enabled: true }; })()`;
}

/** R7/T14 (PR-6): the E5/G15 baseline can only run when the plugin has *no* record for the note
 * and then meets folds that already exist. So: disable the plugin, clear data.json while it is
 * disabled (a plugin holding its store in memory would just write it back), fold the task and
 * then its heading *with the plugin off* (task first — the heading's fold hides the task's
 * line, so the reverse order leaves nothing to click), enable it, reopen the note in a fresh
 * pane, and read what it adopted. The over-an-open-pane case (re-enable without closing) is the
 * second scenario, run straight after. */
/** Copy of `hashText` in src/fold-store.ts (this script is plain Node and cannot import the
 * plugin's TypeScript): the stored `contentHash` for the note's on-disk text. Keep in step. */
function hashOnDisk(path) {
	const normalized = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
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

async function runBaseline(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	const data = args.data ?? DEFAULT_DATA_PATH;
	const beforeHash = hashOnDisk(note);

	async function scenario(cdp, label, reopen) {
		await evaluate(cdp, "app.commands.executeCommandById('editor:unfold-all')"); // same start for both cases
		await sleep(args.waitMs);
		const disabled = await evaluate(cdp, disablePluginExpression(), { awaitPromise: true });
		if (existsSync(data)) unlinkSync(data); // cleared while disabled
		const taskClick = await evaluate(cdp, clickFoldIndicatorNearExpression("Draft proposal"));
		await sleep(args.waitMs);
		const headingClick = await evaluate(cdp, clickFoldIndicatorNearExpression("## Tuesday"));
		await sleep(args.waitMs);
		const enabled = await evaluate(cdp, enablePluginExpression(), { awaitPromise: true });
		await sleep(args.waitMs);
		const reopened = reopen ? await evaluate(cdp, closeAndReopenExpression(DEFAULT_NOTE_VAULT_PATH), { awaitPromise: true }) : null;
		await sleep(Math.max(args.waitMs, 1000));

		const visibleLines = JSON.parse(await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION));
		const record = recordFor(readPluginData(data), DEFAULT_NOTE_VAULT_PATH);
		const anchors = record ? record.folds.filter((fold) => fold.kind !== "frontmatter") : [];
		return {
			label,
			disabled,
			taskClick,
			headingClick,
			enabled,
			reopened,
			recordExists: record !== undefined,
			// Two anchors expected: the heading and the task (Obsidian's own frontmatter fold is not counted).
			anchorCount: record ? anchors.length : null,
			anchorKinds: anchors.map((fold) => fold.kind),
			contentHashMatchesDisk: record ? record.contentHash === beforeHash : null,
			dormantCount: record ? record.dormant.length : null,
			draftProposalStillHidden: !visibleLinesInclude(visibleLines, "Outline"),
			sendInvoicesVisible: visibleLinesInclude(visibleLines, "Send invoices"),
		};
	}

	await withConnection(args.cdpPort, async (cdp) => {
		const closeAndReopen = await scenario(cdp, "close and reopen the note", true);
		const reenableOverOpenPane = await scenario(cdp, "re-enable over an open pane", false);
		state.baseline = { note, closeAndReopen, reenableOverOpenPane };
	});
}

async function runDormantUnfold(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	const data = args.data ?? DEFAULT_DATA_PATH;
	const afterText = readFileSync(REWRITTEN_FIXTURE, "utf8");

	writeFileSync(note, afterText, "utf8");
	await sleep(Math.max(args.waitMs, 1500));

	await withConnection(args.cdpPort, async (cdp) => {
		const visibleLines = JSON.parse(await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION));
		const record = recordFor(readPluginData(data), DEFAULT_NOTE_VAULT_PATH);

		state.dormantUnfold = {
			note,
			// G6: no confident match for the rewritten task -> the block is left unfolded, not
			// silently lost.
			unrelatedTextVisible: visibleLinesInclude(visibleLines, "Completely unrelated paragraph"),
			sendInvoicesVisible: visibleLinesInclude(visibleLines, "Send invoices"),
			foldCount: record ? record.folds.length : null,
			dormantCount: record ? record.dormant.length : null,
			dormantSince: record && record.dormant[0] ? record.dormant[0].dormantSince : null,
		};
	});
}

async function runDormantRefold(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	const data = args.data ?? DEFAULT_DATA_PATH;
	const afterText = readFileSync(BEFORE_FIXTURE, "utf8");

	writeFileSync(note, afterText, "utf8");
	await sleep(Math.max(args.waitMs, 1500));

	await withConnection(args.cdpPort, async (cdp) => {
		const visibleLines = JSON.parse(await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION));
		const record = recordFor(readPluginData(data), DEFAULT_NOTE_VAULT_PATH);

		state.dormantRefold = {
			note,
			// G6: the retry should find the text again and fold it straight back within about a
			// second of the write landing.
			draftProposalRefolded: !visibleLinesInclude(visibleLines, "Outline"),
			foldCount: record ? record.folds.length : null,
			dormantCount: record ? record.dormant.length : null,
		};
	});
}

async function runDormantForgotten(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	const data = args.data ?? DEFAULT_DATA_PATH;
	const rewrittenText = readFileSync(REWRITTEN_FIXTURE, "utf8");
	const beforeText = readFileSync(BEFORE_FIXTURE, "utf8");

	// 1) Break the match again so a fresh dormant entry exists to age out.
	writeFileSync(note, rewrittenText, "utf8");
	await sleep(Math.max(args.waitMs, 1500));

	let agedSince = null;
	await withConnection(args.cdpPort, async (cdp) => {
		await evaluate(cdp, `(async function () { await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)}); return true; })()`, {
			awaitPromise: true,
		});
	});

	// 2) The container-verification script's own documented shortcut: edit `dormantSince` in
	// data.json directly while the plugin is disabled, ageing it past the 600,000ms boundary.
	const before = readPluginData(data);
	const record = recordFor(before, DEFAULT_NOTE_VAULT_PATH);
	if (record && record.dormant[0]) {
		agedSince = Date.now() - (MAX_DORMANT_AGE_MS + 1000);
		record.dormant[0].dormantSince = agedSince;
		writePluginData(data, before);
	}

	await withConnection(args.cdpPort, async (cdp) => {
		await evaluate(cdp, `(async function () { await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)}); return true; })()`, {
			awaitPromise: true,
		});
	});
	await sleep(args.waitMs);

	// 3) One more write that would otherwise refold it — the aged-out anchor must not come back.
	writeFileSync(note, beforeText, "utf8");
	await sleep(Math.max(args.waitMs, 1500));

	await withConnection(args.cdpPort, async (cdp) => {
		const visibleLines = JSON.parse(await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION));
		const after = recordFor(readPluginData(data), DEFAULT_NOTE_VAULT_PATH);

		state.dormantForgotten = {
			note,
			agedDormantSinceWritten: agedSince,
			// G6: forgotten outright — never refolded, even though the text that would have
			// matched it came back.
			draftProposalStillUnfolded: visibleLinesInclude(visibleLines, "Outline"),
			foldCount: after ? after.folds.length : null,
			dormantCount: after ? after.dormant.length : null,
		};
	});
}

async function runEmptyBaseline(args, state) {
	const emptyNote = args.emptyNote ?? DEFAULT_EMPTY_NOTE_PATH;
	const data = args.data ?? DEFAULT_DATA_PATH;

	await withConnection(args.cdpPort, async (cdp) => {
		const open = await evaluate(cdp, openFileExpression(DEFAULT_EMPTY_NOTE_VAULT_PATH), { awaitPromise: true });
		await sleep(args.waitMs);

		const record = recordFor(readPluginData(data), DEFAULT_EMPTY_NOTE_VAULT_PATH);
		state.emptyBaseline = {
			emptyNote,
			open,
			// G15: "a file with no folds on first open is stored as an empty baseline entry" —
			// an entry must exist, with both lists empty, not no entry at all.
			recordExists: record !== undefined,
			foldCount: record ? record.folds.length : null,
			dormantCount: record ? record.dormant.length : null,
		};
	});
}

function renderReport(state) {
	function section(title, data, describe) {
		if (!data) return `### ${title}\n\nNot yet captured.\n`;
		return `### ${title}\n\n${describe(data)}\n`;
	}

	const baselineSection = section("G15/E5: first-open baseline (--phase baseline)", state.baseline, (d) =>
		[d.closeAndReopen, d.reenableOverOpenPane]
			.map((c) =>
				[
					`#### ${c.label}`,
					`- Note: \`${d.note}\``,
					`- Plugin disabled, data.json cleared, task then heading folded, plugin re-enabled${c.reopened ? ", note closed and reopened" : ""}: ${JSON.stringify({ disabled: c.disabled, taskClick: c.taskClick, headingClick: c.headingClick, enabled: c.enabled, reopened: c.reopened })}`,
					`- data.json has an entry for the note: ${c.recordExists}`,
					`- Stored non-frontmatter anchors: ${c.anchorCount} (expect 2: ${JSON.stringify(c.anchorKinds)})`,
					`- Stored contentHash matches the file on disk: ${c.contentHashMatchesDisk}`,
					`- Stored dormant count: ${c.dormantCount} (expect 0)`,
					`- Draft proposal still hidden: ${c.draftProposalStillHidden}`,
					`- Send invoices visible (never folded): ${c.sendInvoicesVisible}`,
				].join("\n"),
			)
			.join("\n\n"));

	const unfoldSection = section("G6: dormant unfold (--phase dormant-unfold)", state.dormantUnfold, (d) => [
		`- Note: \`${d.note}\``,
		`- Unrelated replacement text visible (task no longer folded): ${d.unrelatedTextVisible}`,
		`- Send invoices visible: ${d.sendInvoicesVisible}`,
		`- Stored fold count: ${d.foldCount} (expect 0)`,
		`- Stored dormant count: ${d.dormantCount} (expect 1)`,
		`- dormantSince recorded: ${d.dormantSince}`,
	].join("\n"));

	const refoldSection = section("G6: dormant refold (--phase dormant-refold)", state.dormantRefold, (d) => [
		`- Note: \`${d.note}\``,
		`- Draft proposal refolded: ${d.draftProposalRefolded}`,
		`- Stored fold count: ${d.foldCount} (expect 1)`,
		`- Stored dormant count: ${d.dormantCount} (expect 0)`,
	].join("\n"));

	const forgottenSection = section("G6: dormant forgotten (--phase dormant-forgotten)", state.dormantForgotten, (d) => [
		`- Note: \`${d.note}\``,
		`- Aged dormantSince written (ms since epoch): ${d.agedDormantSinceWritten}`,
		`- Draft proposal still unfolded after the matching write came back: ${d.draftProposalStillUnfolded}`,
		`- Stored fold count: ${d.foldCount} (expect 0)`,
		`- Stored dormant count: ${d.dormantCount} (expect 0)`,
	].join("\n"));

	const emptySection = section("G15: empty baseline (--phase empty-baseline)", state.emptyBaseline, (d) => [
		`- Note: \`${d.emptyNote}\``,
		`- Opened in a new tab: ${JSON.stringify(d.open)}`,
		`- data.json has an entry for the note: ${d.recordExists}`,
		`- Stored fold count: ${d.foldCount} (expect 0)`,
		`- Stored dormant count: ${d.dormantCount} (expect 0)`,
	].join("\n"));

	const overallPass =
		state.baseline?.draftProposalStillHidden &&
		state.baseline?.recordExists &&
		state.baseline?.foldCount === 1 &&
		state.dormantUnfold?.unrelatedTextVisible &&
		state.dormantUnfold?.dormantCount === 1 &&
		state.dormantRefold?.draftProposalRefolded &&
		state.dormantRefold?.dormantCount === 0 &&
		state.dormantForgotten?.draftProposalStillUnfolded &&
		state.dormantForgotten?.dormantCount === 0 &&
		state.emptyBaseline?.recordExists &&
		state.emptyBaseline?.foldCount === 0;

	return `# E5/G15 (first-open baseline) + G6 (dormant folds): proven against real Obsidian

Outcome: ${state.emptyBaseline || state.dormantForgotten ? (overallPass ? "**pass**" : "**fail — see sections below**") : "PENDING — not yet run"}

## How this was captured

Generated by \`scripts/e2e-dormant-baseline-probe.mjs\`, run from inside the Obsidian desktop
container (\`use-desktop-container.md\`) against the built plugin. Re-run with:

\`\`\`
npm run test:e2e:dormant-baseline                 # == --phase all (default)
# or, phase by phase:
node scripts/e2e-dormant-baseline-probe.mjs --phase seed
node scripts/e2e-dormant-baseline-probe.mjs --phase baseline
node scripts/e2e-dormant-baseline-probe.mjs --phase dormant-unfold
node scripts/e2e-dormant-baseline-probe.mjs --phase dormant-refold
node scripts/e2e-dormant-baseline-probe.mjs --phase dormant-forgotten
node scripts/e2e-dormant-baseline-probe.mjs --phase empty-baseline
node scripts/e2e-dormant-baseline-probe.mjs --phase report
\`\`\`

${baselineSection}
${unfoldSection}
${refoldSection}
${forgottenSection}
${emptySection}
`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		process.exitCode = 0;
		return;
	}
	if (!args.phase) args.phase = "all";
	if (!PHASES.includes(args.phase)) {
		printUsage();
		process.exitCode = 1;
		return;
	}

	const state = loadState(args.state);

	if (args.phase === "all") {
		runSeed(args, state);
		await runBaseline(args, state);
		await runDormantUnfold(args, state);
		await runDormantRefold(args, state);
		await runDormantForgotten(args, state);
		await runEmptyBaseline(args, state);
	} else if (args.phase === "seed") runSeed(args, state);
	else if (args.phase === "baseline") await runBaseline(args, state);
	else if (args.phase === "dormant-unfold") await runDormantUnfold(args, state);
	else if (args.phase === "dormant-refold") await runDormantRefold(args, state);
	else if (args.phase === "dormant-forgotten") await runDormantForgotten(args, state);
	else if (args.phase === "empty-baseline") await runEmptyBaseline(args, state);
	// "report" falls straight through to the render/save below with no new capture.

	saveState(args.state, state);
	const report = renderReport(state);
	writeFileSync(REPORT_PATH, report, "utf8");
	console.log(`Wrote ${REPORT_PATH} (state: ${args.state})`);
}

main().catch((err) => {
	console.error("e2e-dormant-baseline-probe failed:", err);
	process.exitCode = 1;
});
