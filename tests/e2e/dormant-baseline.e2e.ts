#!/usr/bin/env node
/**
 * T4 (=R2/R7/T10): the real-Obsidian E5/G15 (first-open baseline) + G6 (dormant anchors kept
 * across disable/re-enable) proof the spec names at this literal path. T63 (PR-1 polish round 4):
 * it now reuses the shared e2e helper scripts/e2e-lib.mjs (the CDP client PR-2's
 * scripts/e2e-reload-probe.mjs established, the data.json helpers, and the page-side fold
 * helpers) instead of carrying its own copy. An earlier version of this comment said a shared
 * import was impossible; that was about importing a `.ts` file from Node's ESM loader. The helper
 * is a plain `.mjs` module, which type-stripped `.ts` scripts import fine at runtime, and tsc
 * (`allowJs`) resolves it for `npm run build`'s type-check.
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
 * Both cases assert: two non-frontmatter anchors in data.json (the task candidate plus the
 * sibling list candidate — T1/T5/T11's own regression, since a heading's live fold ending at EOF
 * would have had the same issue, is still covered independently by tests/unit/baseline.test.ts
 * and the container-verification script's own heading fold), the stored `contentHash` matches
 * the note's on-disk text, and the content both folds hide stays hidden (not leaked into the
 * rendered editor) after the plugin adopts them as a baseline. T25/R13: the fixture opens with a
 * `---` frontmatter block that Obsidian auto-folds on its own; a correct baseline legitimately
 * stores that as a third, "frontmatter"-kind anchor too, so the assertion counts only the
 * task/list anchors and separately flags any kind it doesn't expect, instead of asserting the
 * total is exactly 2.
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
 * Accepts [--cdp-port 9222] [--note <path>] [--data <path to this plugin's data.json>]
 * [--wait-ms 1500] [--help].
 *
 * T102: every fold step acts on the *active* editor, and a run used to fold whichever note
 * happened to be active (not --note), so the reopened --note showed nothing folded and held
 * only Obsidian's auto-folded frontmatter. The vault key is now derived from the vault root
 * Obsidian reports (the old --vault-path option is gone), and --note is made the active editor,
 * and confirmed, before the folds in each case.
 *
 * Not run by `npm test` (vitest's own `include` is `tests/**\/*.test.ts`, which this file's
 * `.e2e.ts` extension deliberately does not match) and not run automatically by this coder
 * turn — it requires a real Obsidian instance in the build container, which the tester runs.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	evaluate,
	foldAndConfirm,
	hashText,
	parkCursorOutsideFolds,
	readPluginData,
	readVisibleLines,
	recordFor,
	sleep,
	unfoldAll,
	useNote,
	visibleLinesInclude,
	withConnection,
	writePluginData,
} from "../../scripts/e2e-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN_ID = "persistent-folded-state";
const DEFAULT_NOTE_PATH = "/config/test-vault/Quarry/Tasks.md";
const DEFAULT_DATA_PATH = `/config/test-vault/.obsidian/plugins/${PLUGIN_ID}/data.json`;
const BEFORE_FIXTURE = join(ROOT, "tests", "fixtures", "tasks-before.md");

type Cdp = Parameters<typeof foldAndConfirm>[0];

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
			"Usage: node tests/e2e/dormant-baseline.e2e.ts [options]",
			"",
			"Runs both the close+reopen and re-enable-over-an-open-pane first-open-baseline cases",
			"(T4/R2/R7) against a real, already-running Obsidian.",
			"",
			"Options: [--cdp-port 9222] [--note <path>] [--data <path>] [--wait-ms 1500]",
			"",
			`--note defaults to ${DEFAULT_NOTE_PATH}, --data to ${DEFAULT_DATA_PATH}.`,
			"Requires a real Obsidian launched with --remote-debugging-port, this plugin built and",
			"enabled, and --note already open. See use-desktop-container.md.",
		].join("\n"),
	);
}

// --- page-side expressions ------------------------------------------------------------------

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
	cdp: Cdp,
	args: Args,
	name: string,
	{ reopen }: { reopen: boolean },
): Promise<CaseResult> {
	const problems: string[] = [];

	// 0. T102: make --note the active editor and learn the key the plugin stores it under. Done
	// before anything else so the unfold/park/fold steps below act on this note, not on
	// whichever one an earlier case (or the operator) left active.
	const { vaultPath } = await useNote(cdp, args.note);

	// 1. Disable the plugin.
	await evaluate(cdp, disablePluginExpression(), { awaitPromise: true });

	// 2. Clear this plugin's stored entry for --note while disabled — a genuine first open, not
	// a re-open of a path this test vault has already seen (R7).
	if (existsSync(args.data)) rmSync(args.data);

	// 2.5. R9(c) / T62: guarantee a clean, fully-unfolded starting point for the folds below,
	// regardless of whatever an earlier case in this same run left folded live. A fold click on a
	// block that is still folded would *unfold* it, so wait until the lines the folds will hide
	// are back in the DOM. (Obsidian's auto-folded frontmatter may stay folded; it is not listed.)
	const unfold = await unfoldAll(cdp, ["A nested list item", "Outline"], { waitMs: args.waitMs });
	if (!unfold.unfolded) problems.push(`could not unfold the note first; still hidden: ${JSON.stringify(unfold.missing)}`);
	const cursor = await parkCursorOutsideFolds(cdp);
	if (!cursor.parked) problems.push(`could not park the cursor outside the folds: ${cursor.reason ?? "unknown"}`);
	await sleep(args.waitMs);

	// 3. Fold the task and its sibling list item by hand (native CM6 fold, same as a user
	// would) — the plugin is disabled, so neither fold is recorded yet; both should still be
	// adopted as the baseline once it's enabled. T14: these two are siblings under the same
	// heading, neither nested in the other, so CM6 never collapses one fold into the other the
	// way it does for a heading and its own nested child (see the file comment). T62: each step
	// is confirmed from the DOM (foldAndConfirm), scoped to the active editor, and falls back to
	// the fold command, so a click that does nothing is reported here as the cause instead of
	// surfacing later as "0 stored anchors".
	const listClick = await foldAndConfirm(cdp, "Plain list item", "A nested list item", { waitMs: args.waitMs });
	if (!listClick.folded) problems.push(`list fold did not take: ${JSON.stringify(listClick)}`);
	const taskClick = await foldAndConfirm(cdp, "Draft proposal", "Outline", { waitMs: args.waitMs });
	if (!taskClick.folded) problems.push(`task fold did not take: ${JSON.stringify(taskClick)}`);

	// 4. Enable the plugin.
	await evaluate(cdp, enablePluginExpression(), { awaitPromise: true });

	// 5. Either close+reopen the note (first case) or leave the already-open pane alone (second
	// case — R7's "re-enable over an open pane").
	if (reopen) {
		const reopened = (await evaluate(cdp, closeAndReopenExpression(vaultPath), { awaitPromise: true })) as {
			reopened: boolean;
			reason?: string;
		};
		if (!reopened.reopened) problems.push(`close+reopen failed: ${reopened.reason ?? "unknown"}`);
	}

	await sleep(args.waitMs);

	// 6. Assert: two anchors, the content hash, and both blocks still hidden.
	const data = readPluginData(args.data);
	const record = recordFor(data, vaultPath);
	if (!record) {
		problems.push(
			`no stored entry for ${JSON.stringify(vaultPath)} at all after enabling the plugin ` +
				`(data.json holds: ${JSON.stringify(data ? Object.keys(data.files) : null)})`,
		);
		return { name, ok: problems.length === 0, problems };
	}

	const onDiskText = readFileSync(args.note, "utf8");
	const expectedHash = hashText(onDiskText);
	if (record.contentHash !== expectedHash) {
		problems.push(`contentHash mismatch: stored ${record.contentHash}, expected ${expectedHash}`);
	}
	// T25/R13: Obsidian auto-folds frontmatter on its own, independently of this plugin, so a
	// genuinely correct baseline on tests/fixtures/tasks-before.md (which opens with a `---`
	// frontmatter block) legitimately stores that fold too, as a third, "frontmatter"-kind
	// anchor (E13 explicitly lists frontmatter as a fold kind the baseline builder must handle).
	// `editor:unfold-all` (unfoldAllExpression, step 2.5) does not reliably clear a frontmatter
	// fold in real Obsidian, so asserting the *total* count is 2 fails on a correct run. Assert
	// instead on the two anchors this case's own clicks actually made (task + sibling list),
	// ignoring any frontmatter anchor, and flag anything else as a genuine regression.
	const nonFrontmatterFolds = record.folds.filter((fold) => fold.kind !== "frontmatter");
	if (nonFrontmatterFolds.length !== 2) {
		problems.push(
			`expected 2 non-frontmatter stored anchors (task + sibling list), got ${nonFrontmatterFolds.length} ` +
				`(${record.folds.length} total, kinds: ${JSON.stringify(record.folds.map((fold) => fold.kind))})`,
		);
	}
	const unexpectedKinds = record.folds.filter((fold) => fold.kind !== "frontmatter" && fold.kind !== "task" && fold.kind !== "list");
	if (unexpectedKinds.length > 0) {
		problems.push(`unexpected anchor kinds stored: ${JSON.stringify(unexpectedKinds.map((fold) => fold.kind))}`);
	}

	const visibleLines = await readVisibleLines(cdp);
	for (const needle of ["A nested list item", "Outline"]) {
		if (visibleLinesInclude(visibleLines, needle)) {
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
