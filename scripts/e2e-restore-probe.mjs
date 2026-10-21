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
 *   --phase verify     GP3: reads the DOM again and checks: "## Tuesday" is still folded; then
 *                      expands it (T2: "Send invoices" and its new child are nested inside
 *                      Tuesday's foldable range, so they are only rendered once it is expanded)
 *                      and checks "Draft proposal v2" still has its own fold while "Send invoices"
 *                      and its new child are both rendered; the file on disk is byte-identical to
 *                      what --phase rewrite wrote (F1 — nothing added).
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
import { copyFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
	clickFoldIndicatorExpression,
	evaluate,
	foldAndConfirm,
	parkCursorOutsideFolds,
	readVisibleLines,
	sleep,
	unfoldAll,
	visibleLinesInclude,
	withConnection,
} from "./e2e-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(ROOT, "docs", "restore-golden-path.md");
const DEFAULT_STATE_PATH = join(tmpdir(), "pfs-e2e-restore-probe-state.json");
const DEFAULT_NOTE_PATH = "/config/test-vault/Tasks.md";
const DEFAULT_AFTER_PATH = join(ROOT, "tests", "fixtures", "tasks-after.md");
const BEFORE_FIXTURE = join(ROOT, "tests", "fixtures", "tasks-before.md");

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
		else if (arg === "--keep-note") args.keepNote = true;
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
			"Options: [--cdp-port 9222] [--wait-ms 1000] [--state <path>] [--keep-note]",
			"         (setup copies tests/fixtures/tasks-before.md over --note first, so every run starts from the same text; --keep-note skips that)",
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

async function runSetup(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	// T61: start every run from the same note. A previous run leaves the note holding the
	// rewritten text and Obsidian (or this plugin) restores the folds it stored, so a fold click
	// on the next run would *unfold* a block that was already folded. Put the "before" fixture
	// back, then unfold anything that is still folded, so GP1 always folds from a known state.
	let reset = { skipped: true };
	if (!args.keepNote) {
		copyFileSync(BEFORE_FIXTURE, note);
		await sleep(Math.max(args.waitMs, 1500)); // the plugin's own settle window + restore
		reset = { copiedFrom: BEFORE_FIXTURE };
	}
	await withConnection(args.cdpPort, async (cdp) => {
		// Only lines inside the two blocks GP1 folds: Obsidian may keep the frontmatter folded.
		const unfold = await unfoldAll(cdp, ["Outline", "Notes for Tuesday"], { waitMs: args.waitMs });
		const cursor = await parkCursorOutsideFolds(cdp);
		await sleep(args.waitMs);
		// T1 (PR-5): Draft proposal first, then Tuesday. Tasks.md has no heading after "## Tuesday",
		// so Tuesday's fold hides every line below it, Draft proposal's included — clicking
		// Tuesday first leaves nothing to click for the task and GP1 never gets its second fold.
		// T61: each step is confirmed from the DOM (scripts/e2e-lib.mjs foldAndConfirm), is
		// scoped to the active editor, skips a block that is already folded, and falls back to
		// the fold command if the indicator click does not take.
		const draftClick = await foldAndConfirm(cdp, "Draft proposal", "Outline", { waitMs: args.waitMs });
		const tuesdayClick = await foldAndConfirm(cdp, "Tuesday", "Notes for Tuesday", { waitMs: args.waitMs });

		const visibleLines = await readVisibleLines(cdp);
		state.setup = {
			note,
			reset,
			unfold,
			cursor,
			tuesdayClick,
			draftClick,
			// GP1's own check: Tuesday's and Draft proposal's interior lines are hidden.
			tuesdayBodyHidden: !visibleLinesInclude(visibleLines, "Notes for Tuesday"),
			draftChildrenHidden: !visibleLinesInclude(visibleLines, "Outline"),
			// T2 (PR-1 test round 1): "Send invoices" sits inside "## Tuesday"'s foldable range (the
			// fixture has no later heading), so it is hidden by Tuesday's own fold and cannot be
			// asserted visible here. It is checked in --phase verify, after Tuesday is expanded.
			sendInvoicesHiddenByTuesday: !visibleLinesInclude(visibleLines, "Send invoices"),
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
		const foldedLines = await readVisibleLines(cdp);
		const onDiskText = readFileSync(note, "utf8");
		const expectedText = state.rewrite?.afterText;

		// T2 (PR-1 test round 1): "Send invoices" and its new child are nested inside "## Tuesday"'s
		// foldable range (no later heading), so while Tuesday is folded they are not rendered at
		// all — that is the fold working, not the restore failing. Expand Tuesday (not Draft
		// proposal v2, whose own fold must stay put) to read the nested lines, the same way a user
		// would see GP3's described state.
		const tuesdayStillFolded = !visibleLinesInclude(foldedLines, "Notes for Tuesday");
		const expand = await evaluate(cdp, clickFoldIndicatorExpression("Tuesday"));
		await sleep(Math.max(args.waitMs, 500));
		const expandedLines = expand.clicked ? await readVisibleLines(cdp) : [];

		state.verify = {
			note,
			expand,
			// GP3: Tuesday stays folded across the rewrite (checked before expanding it)...
			tuesdayStillFolded,
			// ...and "Draft proposal v2" has its own fold (its sub-tasks stay hidden once Tuesday
			// is expanded — while Tuesday is folded they are hidden by it, which proves nothing).
			draftProposalV2StillFolded:
				expand.clicked && !visibleLinesInclude(expandedLines, "Outline") && !visibleLinesInclude(expandedLines, "Review"),
			// Send invoices was never folded and gets no new fold — it and its new child render.
			sendInvoicesVisible: visibleLinesInclude(expandedLines, "Send invoices"),
			followUpCallVisible: visibleLinesInclude(expandedLines, "Follow up call"),
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
		`- Note reset to the before-fixture: ${JSON.stringify(d.reset)}`,
		`- Unfolded anything left folded first: ${JSON.stringify(d.unfold)}`,
		`- Cursor parked outside every fold: ${JSON.stringify(d.cursor)}`,
		`- Folded Draft proposal (first): ${JSON.stringify(d.draftClick)}`,
		`- Folded Tuesday (second): ${JSON.stringify(d.tuesdayClick)}`,
		`- Tuesday's body hidden: ${d.tuesdayBodyHidden}`,
		`- Draft proposal's children hidden: ${d.draftChildrenHidden}`,
		`- Send invoices hidden by Tuesday's fold (it is nested in Tuesday; not a failure): ${d.sendInvoicesHiddenByTuesday}`,
	].join("\n"));

	const rewriteSection = section("GP2 (--phase rewrite)", state.rewrite, (d) => [
		`- Note: \`${d.note}\``,
		`- Source: \`${d.afterPath}\``,
		`- Write started at: ${d.writeStartedAt}`,
	].join("\n"));

	const verifySection = section("GP3 (--phase verify)", state.verify, (d) => [
		`- Tuesday still folded: ${d.tuesdayStillFolded}`,
		`- Expanded Tuesday to read its nested lines: ${JSON.stringify(d.expand)}`,
		`- Draft proposal v2 still folded (checked with Tuesday expanded): ${d.draftProposalV2StillFolded}`,
		`- Send invoices visible (with Tuesday expanded): ${d.sendInvoicesVisible}`,
		`- "Follow up call" (new child) visible: ${d.followUpCallVisible}`,
		`- File on disk byte-identical to what --phase rewrite wrote (F1): ${d.fileByteIdentical}`,
	].join("\n"));

	const overallPass =
		state.setup &&
		state.setup.draftClick.folded &&
		state.setup.tuesdayClick.folded &&
		state.verify &&
		state.verify.tuesdayStillFolded &&
		state.verify.draftProposalV2StillFolded &&
		state.verify.sendInvoicesVisible &&
		state.verify.followUpCallVisible &&
		state.verify.fileByteIdentical === true;

	return `# GP1-GP3: the golden path, proven against real Obsidian

Outcome: ${state.verify ? (overallPass ? "**pass**" : "**fail — see GP1/GP3 below**") : "PENDING — not yet run"}

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
