#!/usr/bin/env node
/**
 * The GP1-GP3 golden-path proof, run for real against a running Obsidian (container-only — see
 * use-desktop-container.md). The CM6-level pipeline itself is already proven by
 * tests/integration/restore-golden-path.test.ts (real EditorState/EditorView, real matcher, the
 * exact tests/fixtures/tasks-before.md / tasks-after.md pair); this script is the container
 * sibling that proves the same scenario through a real Obsidian window end to end — real
 * rendering, real native fold restore racing this plugin's own restore, real file I/O.
 *
 * Phases (reconnect-over-CDP style, same shape as scripts/e2e-reload-probe.mjs — see that file's
 * comment for the CDP/instrumentation rationale this one reuses verbatim):
 *
 *   --phase setup     GP1: folds "## Tuesday" and "- [ ] Draft proposal" on the already-open
 *                      fixture note (clicking Obsidian's own fold-indicator triangles for each —
 *                      the same mechanism a real user would use), leaving "- [ ] Send invoices"
 *                      untouched. Verifies via the DOM that exactly those two blocks' interior
 *                      lines are no longer rendered.
 *   --phase rewrite    GP2: performs the exact external rewrite the ticket plan describes (4
 *                      lines inserted above "## Tuesday", the task renamed to "v2", one sub-task
 *                      ticked, a new child appended under "Send invoices") by writing the file
 *                      from outside Obsidian, then waits for the plugin's settle window plus
 *                      match time.
 *   --phase verify     GP3: reads the DOM again and checks: "## Tuesday" and "Draft proposal v2"
 *                      still have their interior lines hidden; "Send invoices" and its new child
 *                      are both rendered (visible); the file on disk is byte-identical to what
 *                      --phase rewrite wrote (F1 — nothing added).
 *   --phase report      (re)writes docs/restore-golden-path.md from the gathered state.
 *   --phase all          setup + rewrite + verify + report in one Obsidian session (the default).
 *
 * This is a container-run harness, not a unit test — see the file comment in
 * scripts/e2e-reload-probe.mjs for why DOM text, not an internal CM6/Obsidian API, is what this
 * reads: the running plugin's own bundled main.js can `require("@codemirror/language")` (Obsidian
 * patches `require` inside a loaded plugin module's scope), but a bare CDP `Runtime.evaluate`
 * string runs in the page's top-level scope, which isn't wrapped by that patch. Reading
 * "`.cm-line` elements present in the DOM" instead of a fold API is deliberately
 * version-agnostic: CM6 never renders a folded range's interior lines as `.cm-line` elements at
 * all (they're replaced by a placeholder decoration), regardless of which Obsidian build is
 * running, so "is this exact line's text present as a rendered `.cm-line`" is a reliable signal
 * without needing any internal fold-state API.
 *
 * Usage (run inside the Obsidian desktop container, with the fixture note — a copy of
 * tests/fixtures/tasks-before.md — already open in Live Preview):
 *
 *   node scripts/e2e-restore-probe.mjs                                    # == --phase all
 *   node scripts/e2e-restore-probe.mjs --phase setup   --note <path>
 *   node scripts/e2e-restore-probe.mjs --phase rewrite --note <path> --after <path to tasks-after.md>
 *   node scripts/e2e-restore-probe.mjs --phase verify  --note <path>
 *   node scripts/e2e-restore-probe.mjs --phase report
 *
 * Every phase accepts [--cdp-port 9222] [--wait-ms 1000] [--state <path>].
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(ROOT, "docs", "restore-golden-path.md");
const DEFAULT_STATE_PATH = join(tmpdir(), "pfs-e2e-restore-probe-state.json");
const DEFAULT_NOTE_PATH = "/config/test-vault/Tasks.md";
const DEFAULT_AFTER_PATH = join(ROOT, "tests", "fixtures", "tasks-after.md");

const EXPLICIT_PHASES = ["setup", "rewrite", "verify", "report"];
const PHASES = ["all", ...EXPLICIT_PHASES];

function parseArgs(argv) {
	const args = { cdpPort: 9222, waitMs: 1000, state: DEFAULT_STATE_PATH };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--phase") args.phase = argv[++i];
		else if (arg === "--note") args.note = argv[++i];
		else if (arg === "--after") args.after = argv[++i];
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
			`Usage: node scripts/e2e-restore-probe.mjs [--phase <${PHASES.join("|")}>] [options]`,
			"",
			"  (no --phase)                      same as --phase all (the default)",
			"  --phase all                        setup + rewrite + verify + report, one Obsidian session",
			"  --phase setup   [--note <path>]    GP1: fold Tuesday + Draft proposal; leave Send invoices open",
			"  --phase rewrite [--note <path>] [--after <path>]  GP2: external rewrite (default --after: tests/fixtures/tasks-after.md)",
			"  --phase verify  [--note <path>]    GP3: check folded/visible lines + byte-identical file",
			"  --phase report                     (re)write docs/restore-golden-path.md from --state",
			"",
			"Options: [--cdp-port 9222] [--wait-ms 1000] [--state <path>]",
			"",
			`--note defaults to ${DEFAULT_NOTE_PATH} (the container test vault's copy of tests/fixtures/tasks-before.md).`,
			"Requires a real Obsidian launched with --remote-debugging-port, this plugin built and",
			"enabled, and the fixture note already open in Live Preview. See use-desktop-container.md.",
		].join("\n")
	);
}

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

async function findDebuggableTarget(cdpPort) {
	const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
	if (!res.ok) throw new Error(`CDP target list request failed: HTTP ${res.status}`);
	const targets = await res.json();
	const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
	if (!target) throw new Error("no debuggable Obsidian window found on that CDP port");
	return target;
}

/** Minimal CDP client — identical shape to scripts/e2e-reload-probe.mjs's `connectCdp` (kept as
 * its own copy here rather than shared, so each probe stays independently runnable/removable). */
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

/** Clicks the fold-indicator triangle for the first rendered `.cm-line` whose text matches
 * `needle` (a plain substring, not a regex — kept simple and visible rather than clever). Each
 * foldable line gets its own `.cm-fold-indicator` widget in the left margin (see the file
 * comment in e2e-reload-probe.mjs). Returns `{clicked: boolean, reason?: string}` rather than
 * throwing, so a phase that can't find the line reports why instead of a bare stack trace. */
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

/** The exact rendered-text signal GP3 checks: for each needle, whether a `.cm-line` containing
 * that text is currently present in the DOM at all (CM6 never renders a folded range's interior
 * lines as `.cm-line` elements — see the file comment above). */
const READ_VISIBLE_LINES_EXPRESSION = `
JSON.stringify(Array.from(document.querySelectorAll(".cm-line")).map((el) => el.textContent))
`;

function visibleLinesInclude(visibleLines, needle) {
	return visibleLines.some((line) => line.includes(needle));
}

async function runSetup(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	await withConnection(args.cdpPort, async (cdp) => {
		// T1 (PR-5): Draft proposal first, then Tuesday. Tasks.md has no heading after "## Tuesday",
		// so Tuesday's fold hides every line below it, Draft proposal's included — clicking
		// Tuesday first leaves nothing to click for the task and GP1 never gets its second fold.
		const draftClick = await evaluate(cdp, clickFoldIndicatorNearExpression("Draft proposal"));
		await sleep(args.waitMs);
		const tuesdayClick = await evaluate(cdp, clickFoldIndicatorNearExpression("Tuesday"));
		await sleep(args.waitMs);

		const visibleLines = JSON.parse(await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION));
		state.setup = {
			note,
			tuesdayClick,
			draftClick,
			// GP1's own check: Tuesday's and Draft proposal's interior lines are hidden; Send
			// invoices (never folded) is still rendered.
			tuesdayBodyHidden: !visibleLinesInclude(visibleLines, "Notes for Tuesday"),
			draftChildrenHidden: !visibleLinesInclude(visibleLines, "Outline"),
			sendInvoicesVisible: visibleLinesInclude(visibleLines, "Send invoices"),
		};
	});
}

async function runRewrite(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	const afterPath = args.after ?? DEFAULT_AFTER_PATH;
	const afterText = readFileSync(afterPath, "utf8");

	const writeStartedAt = Date.now();
	writeFileSync(note, afterText, "utf8");
	// 150ms settle + however long the (chunked, yielded) match takes for this small fixture —
	// generous but still well under a human-perceptible delay.
	await sleep(Math.max(args.waitMs, 1500));

	state.rewrite = { note, afterPath, writeStartedAt: new Date(writeStartedAt).toISOString(), afterText };
}

async function runVerify(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	await withConnection(args.cdpPort, async (cdp) => {
		const visibleLines = JSON.parse(await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION));
		const onDiskText = readFileSync(note, "utf8");
		const expectedText = state.rewrite?.afterText;

		state.verify = {
			note,
			// GP3: Tuesday and "Draft proposal v2" stay folded (interior lines still hidden).
			tuesdayStillFolded: !visibleLinesInclude(visibleLines, "Notes for Tuesday"),
			draftProposalV2StillFolded: !visibleLinesInclude(visibleLines, "Outline") && !visibleLinesInclude(visibleLines, "Review"),
			// Send invoices was never folded and gets no new fold — its new child is visible.
			sendInvoicesVisible: visibleLinesInclude(visibleLines, "Send invoices"),
			followUpCallVisible: visibleLinesInclude(visibleLines, "Follow up call"),
			// F1: the file on disk is exactly what --phase rewrite wrote — nothing added.
			fileByteIdentical: expectedText !== undefined ? onDiskText === expectedText : null,
		};
	});
}

function renderReport(state) {
	function section(title, data, describe) {
		if (!data) return `### ${title}\n\nNot yet captured.\n`;
		return `### ${title}\n\n${describe(data)}\n`;
	}

	const setupSection = section("GP1 (--phase setup)", state.setup, (d) => [
		`- Note: \`${d.note}\``,
		`- Clicked Tuesday's fold indicator: ${JSON.stringify(d.tuesdayClick)}`,
		`- Clicked Draft proposal's fold indicator: ${JSON.stringify(d.draftClick)}`,
		`- Tuesday's body hidden: ${d.tuesdayBodyHidden}`,
		`- Draft proposal's children hidden: ${d.draftChildrenHidden}`,
		`- Send invoices visible (never folded): ${d.sendInvoicesVisible}`,
	].join("\n"));

	const rewriteSection = section("GP2 (--phase rewrite)", state.rewrite, (d) => [
		`- Note: \`${d.note}\``,
		`- Source: \`${d.afterPath}\``,
		`- Write started at: ${d.writeStartedAt}`,
	].join("\n"));

	const verifySection = section("GP3 (--phase verify)", state.verify, (d) => [
		`- Tuesday still folded: ${d.tuesdayStillFolded}`,
		`- Draft proposal v2 still folded: ${d.draftProposalV2StillFolded}`,
		`- Send invoices visible: ${d.sendInvoicesVisible}`,
		`- "Follow up call" (new child) visible: ${d.followUpCallVisible}`,
		`- File on disk byte-identical to what --phase rewrite wrote (F1): ${d.fileByteIdentical}`,
	].join("\n"));

	const overallPass =
		state.verify &&
		state.verify.tuesdayStillFolded &&
		state.verify.draftProposalV2StillFolded &&
		state.verify.sendInvoicesVisible &&
		state.verify.followUpCallVisible &&
		state.verify.fileByteIdentical === true;

	return `# GP1-GP3: the golden path, proven against real Obsidian

Outcome: ${state.verify ? (overallPass ? "**pass**" : "**fail — see GP3 below**") : "PENDING — not yet run"}

## How this was captured

Generated by \`scripts/e2e-restore-probe.mjs\`, run from inside the Obsidian desktop container
(\`use-desktop-container.md\`) against the built plugin, with a copy of
\`tests/fixtures/tasks-before.md\` open in Live Preview. Re-run with:

\`\`\`
node scripts/e2e-restore-probe.mjs                                    # == --phase all
node scripts/e2e-restore-probe.mjs --phase setup   --note "<path>"
node scripts/e2e-restore-probe.mjs --phase rewrite --note "<path>" --after "<path to tasks-after.md>"
node scripts/e2e-restore-probe.mjs --phase verify  --note "<path>"
node scripts/e2e-restore-probe.mjs --phase report
\`\`\`

${setupSection}
${rewriteSection}
${verifySection}
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
		await runSetup(args, state);
		await runRewrite(args, state);
		await runVerify(args, state);
	} else if (args.phase === "setup") await runSetup(args, state);
	else if (args.phase === "rewrite") await runRewrite(args, state);
	else if (args.phase === "verify") await runVerify(args, state);
	// "report" falls straight through to the render/save below with no new capture.

	saveState(args.state, state);
	const report = renderReport(state);
	writeFileSync(REPORT_PATH, report, "utf8");
	console.log(`Wrote ${REPORT_PATH} (state: ${args.state})`);
}

main().catch((err) => {
	console.error("e2e-restore-probe failed:", err);
	process.exitCode = 1;
});
