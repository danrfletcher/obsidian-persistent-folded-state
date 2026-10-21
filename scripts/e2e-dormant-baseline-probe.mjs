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
 *   --phase baseline          G15/E5: with the plugin disabled and data.json cleared, folds
 *                             "Plain list item" and "Draft proposal" (two sibling blocks — see
 *                             runBaseline for why not the heading), each confirmed from the DOM,
 *                             then re-enables this plugin over CDP — the
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
import {
	evaluate,
	foldAndConfirm,
	hashText,
	parkCursorOutsideFolds,
	readPluginData,
	readVisibleLines,
	recordFor,
	resolveNote,
	sleep,
	unfoldAll,
	useNote,
	visibleLinesInclude,
	withConnection,
	writePluginData,
} from "./e2e-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(ROOT, "docs", "dormant-baseline.md");
const DEFAULT_STATE_PATH = join(tmpdir(), "pfs-e2e-dormant-baseline-probe-state.json");

const PLUGIN_ID = "persistent-folded-state";
const DEFAULT_NOTE_PATH = "/config/test-vault/Quarry/Tasks.md";
const DEFAULT_EMPTY_NOTE_PATH = "/config/test-vault/Quarry/Empty.md";
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
/** The stored `contentHash` the plugin should hold for the note's on-disk text. */
function hashOnDisk(path) {
	return hashText(readFileSync(path, "utf8"));
}

async function runBaseline(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	const data = args.data ?? DEFAULT_DATA_PATH;
	const beforeHash = hashOnDisk(note);

	async function scenario(cdp, label, reopen) {
		// T102: fold --note, not whichever note is active; derive the data.json key from it.
		const { vaultPath } = await useNote(cdp, note);
		// T62: unfold everything first and wait until the lines the folds will hide are back in
		// the DOM, so both scenarios start from the same known state. A fold click on a block that
		// is still folded (Obsidian restores folds natively when a note reopens) would *unfold* it.
		const unfold = await unfoldAll(cdp, ["Outline", "A nested list item"], { waitMs: args.waitMs });
		const disabled = await evaluate(cdp, disablePluginExpression(), { awaitPromise: true });
		if (existsSync(data)) unlinkSync(data); // cleared while disabled
		const cursor = await parkCursorOutsideFolds(cdp);
		await sleep(args.waitMs);
		// Two sibling blocks under the same heading — the plain list item and the task — not the
		// heading and the task. CM6's fold state drops a fold that a newly added, enclosing fold
		// fully covers (reproduced in real Obsidian in PR-6 T14; see tests/e2e/dormant-baseline
		// .e2e.ts), so "task, then heading" can only ever leave the heading stored. Each step is
		// confirmed from the DOM (scripts/e2e-lib.mjs foldAndConfirm).
		const listClick = await foldAndConfirm(cdp, "Plain list item", "A nested list item", { waitMs: args.waitMs });
		const taskClick = await foldAndConfirm(cdp, "Draft proposal", "Outline", { waitMs: args.waitMs });
		const enabled = await evaluate(cdp, enablePluginExpression(), { awaitPromise: true });
		await sleep(args.waitMs);
		const reopened = reopen ? await evaluate(cdp, closeAndReopenExpression(vaultPath), { awaitPromise: true }) : null;
		await sleep(Math.max(args.waitMs, 1000));

		const visibleLines = await readVisibleLines(cdp);
		const record = recordFor(readPluginData(data), vaultPath);
		const anchors = record ? record.folds.filter((fold) => fold.kind !== "frontmatter") : [];
		return {
			label,
			unfold,
			disabled,
			cursor,
			listClick,
			taskClick,
			enabled,
			reopened,
			recordExists: record !== undefined,
			// Two anchors expected: the list item and the task (Obsidian's own frontmatter fold is not counted).
			anchorCount: record ? anchors.length : null,
			anchorKinds: anchors.map((fold) => fold.kind),
			contentHashMatchesDisk: record ? record.contentHash === beforeHash : null,
			dormantCount: record ? record.dormant.length : null,
			nestedListItemStillHidden: !visibleLinesInclude(visibleLines, "A nested list item"),
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

/** The fold records' count ignoring Obsidian's own auto-folded frontmatter, which the baseline
 * and the recorder legitimately store as a "frontmatter" anchor (tests/fixtures/tasks-before.md
 * opens with a `---` block). Null when the note has no record. */
function userFoldCount(record) {
	return record ? record.folds.filter((fold) => fold.kind !== "frontmatter").length : null;
}

async function runDormantUnfold(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	const data = args.data ?? DEFAULT_DATA_PATH;
	const afterText = readFileSync(REWRITTEN_FIXTURE, "utf8");

	// The G6 phases need exactly one user fold stored for the note — the task — whatever the
	// baseline phase left behind (T62). Put the before-fixture back, unfold anything still folded,
	// fold the task (confirmed from the DOM) with the plugin enabled so its recorder stores it.
	copyFileSync(BEFORE_FIXTURE, note);
	await sleep(Math.max(args.waitMs, 1500));
	await withConnection(args.cdpPort, async (cdp) => {
		const { vaultPath } = await useNote(cdp, note);
		const unfold = await unfoldAll(cdp, ["Outline", "A nested list item"], { waitMs: args.waitMs });
		const cursor = await parkCursorOutsideFolds(cdp);
		const taskFold = await foldAndConfirm(cdp, "Draft proposal", "Outline", { waitMs: Math.max(args.waitMs, 1000) });
		const record = recordFor(readPluginData(data), vaultPath);
		state.dormantSetup = {
			note,
			unfold,
			cursor,
			taskFold,
			storedUserFolds: userFoldCount(record),
			storedDormant: record ? record.dormant.length : null,
		};
	});

	writeFileSync(note, afterText, "utf8");
	await sleep(Math.max(args.waitMs, 1500));

	await withConnection(args.cdpPort, async (cdp) => {
		const { vaultPath } = await useNote(cdp, note);
		const visibleLines = await readVisibleLines(cdp);
		const record = recordFor(readPluginData(data), vaultPath);

		state.dormantUnfold = {
			note,
			// G6: no confident match for the rewritten task -> the block is left unfolded, not
			// silently lost.
			unrelatedTextVisible: visibleLinesInclude(visibleLines, "Completely unrelated paragraph"),
			sendInvoicesVisible: visibleLinesInclude(visibleLines, "Send invoices"),
			foldCount: userFoldCount(record),
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
		const { vaultPath } = await useNote(cdp, note);
		const visibleLines = await readVisibleLines(cdp);
		const record = recordFor(readPluginData(data), vaultPath);

		state.dormantRefold = {
			note,
			// G6: the retry should find the text again and fold it straight back within about a
			// second of the write landing.
			draftProposalRefolded: !visibleLinesInclude(visibleLines, "Outline"),
			foldCount: userFoldCount(record),
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
	let vaultPath = null;
	await withConnection(args.cdpPort, async (cdp) => {
		vaultPath = (await useNote(cdp, note)).vaultPath;
		await evaluate(cdp, `(async function () { await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)}); return true; })()`, {
			awaitPromise: true,
		});
	});

	// 2) The container-verification script's own documented shortcut: edit `dormantSince` in
	// data.json directly while the plugin is disabled, ageing it past the 600,000ms boundary.
	const before = readPluginData(data);
	const record = recordFor(before, vaultPath);
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
		await useNote(cdp, note);
		const visibleLines = await readVisibleLines(cdp);
		const after = recordFor(readPluginData(data), vaultPath);

		state.dormantForgotten = {
			note,
			agedDormantSinceWritten: agedSince,
			// G6: forgotten outright — never refolded, even though the text that would have
			// matched it came back.
			draftProposalStillUnfolded: visibleLinesInclude(visibleLines, "Outline"),
			foldCount: userFoldCount(after),
			dormantCount: after ? after.dormant.length : null,
		};
	});
}

async function runEmptyBaseline(args, state) {
	const emptyNote = args.emptyNote ?? DEFAULT_EMPTY_NOTE_PATH;
	const data = args.data ?? DEFAULT_DATA_PATH;

	await withConnection(args.cdpPort, async (cdp) => {
		const { vaultPath: emptyVaultPath } = await resolveNote(cdp, emptyNote);
		const open = await evaluate(cdp, openFileExpression(emptyVaultPath), { awaitPromise: true });
		await sleep(args.waitMs);

		const record = recordFor(readPluginData(data), emptyVaultPath);
		state.emptyBaseline = {
			emptyNote,
			open,
			// G15: "a file with no folds on first open is stored as an empty baseline entry" —
			// an entry must exist, with both lists empty, not no entry at all.
			recordExists: record !== undefined,
			foldCount: userFoldCount(record),
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
					`- Unfolded everything first: ${JSON.stringify(c.unfold)}`,
					`- Plugin disabled, data.json cleared, plain list item then task folded, plugin re-enabled${c.reopened ? ", note closed and reopened" : ""}: ${JSON.stringify({ disabled: c.disabled, cursor: c.cursor, listClick: c.listClick, taskClick: c.taskClick, enabled: c.enabled, reopened: c.reopened })}`,
					`- data.json has an entry for the note: ${c.recordExists}`,
					`- Stored non-frontmatter anchors: ${c.anchorCount} (expect 2: ${JSON.stringify(c.anchorKinds)})`,
					`- Stored contentHash matches the file on disk: ${c.contentHashMatchesDisk}`,
					`- Stored dormant count: ${c.dormantCount} (expect 0)`,
					`- Plain list item's nested line still hidden: ${c.nestedListItemStillHidden}`,
					`- Draft proposal still hidden: ${c.draftProposalStillHidden}`,
					`- Send invoices visible (never folded): ${c.sendInvoicesVisible}`,
				].join("\n"),
			)
			.join("\n\n"));

	const unfoldSection = section("G6: dormant unfold (--phase dormant-unfold)", state.dormantUnfold, (d) => [
		`- Note: \`${d.note}\``,
		`- Precondition (task folded with the plugin enabled and stored): ${JSON.stringify(state.dormantSetup)}`,
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

	// Both baseline scenarios: each fold step confirmed from the DOM, two non-frontmatter anchors
	// stored with the on-disk content hash and nothing dormant, both blocks still hidden, and the
	// never-folded sibling task still visible.
	const baselinePasses = (c) =>
		c.listClick.folded &&
		c.taskClick.folded &&
		c.recordExists &&
		c.anchorCount === 2 &&
		c.contentHashMatchesDisk === true &&
		c.dormantCount === 0 &&
		c.nestedListItemStillHidden &&
		c.draftProposalStillHidden &&
		c.sendInvoicesVisible;
	const overallPass =
		state.baseline &&
		baselinePasses(state.baseline.closeAndReopen) &&
		baselinePasses(state.baseline.reenableOverOpenPane) &&
		state.dormantSetup?.taskFold?.folded &&
		state.dormantSetup?.storedUserFolds === 1 &&
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
