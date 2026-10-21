#!/usr/bin/env node
/**
 * GP4 (PR-7), end to end against a real, already-running Obsidian — the "Dan quits Obsidian, a
 * git pull rewrites Tasks.md again, he relaunches and opens the note" golden-path sentence.
 * Reuses the exact GP1-GP3 fixture pair `tests/fixtures/tasks-before.md`/`tasks-after.md` (same
 * ones `tests/integration/restore-golden-path.test.ts` and `scripts/e2e-restore-probe.mjs`
 * already use) and the shared real-Obsidian helper scripts/e2e-lib.mjs (CDP client, data.json
 * helpers, and the fold steps that are scoped to the active editor and confirmed from the DOM —
 * PR-1 polish R3). Kept runnable as plain Node + type-stripped TypeScript, no build step.
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
 * Accepts [--cdp-port 9222] [--note <path>] [--data <path>] [--wait-ms 1500]
 * [--connect-retries 30] [--connect-retry-delay-ms 2000] (after-relaunch only) [--help].
 *
 * T99/T100: the plugin stores a note's folds under its vault-relative path, and every fold step
 * acts on the *active* editor. This script no longer takes the key on trust (the old
 * `--vault-path` option, whose default named a note that was not the one open): it asks Obsidian
 * for the vault root, derives the key from --note, makes --note the active editor before it
 * folds or reads anything, and, when no record is stored, fails naming that key together with
 * the keys data.json actually holds.
 *
 * Not run by `npm test` (vitest's own `include` is `tests/**\/*.test.ts`, which this file's
 * `.e2e.ts` extension deliberately does not match) and not run automatically by this coder turn
 * — it requires a real Obsidian instance in the build container, which the tester runs.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	evaluate,
	clickFoldIndicatorExpression,
	foldAndConfirm,
	hashText,
	parkCursorOutsideFolds,
	readPluginData,
	readVisibleLines,
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
const AFTER_FIXTURE = join(ROOT, "tests", "fixtures", "tasks-after.md");

// --- CLI --------------------------------------------------------------------------------------

const PHASES = ["before-quit", "rewrite", "after-relaunch"] as const;
type Phase = (typeof PHASES)[number];

interface Args {
	phase?: Phase;
	cdpPort: number;
	note: string;
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
			"Options: [--cdp-port 9222] [--note <path>] [--data <path>] [--wait-ms 1500]",
			"         [--connect-retries 30] [--connect-retry-delay-ms 2000] (after-relaunch only)",
		].join("\n"),
	);
}

// --- phases --------------------------------------------------------------------------------

async function runBeforeQuit(args: Args): Promise<void> {
	copyFileSync(BEFORE_FIXTURE, args.note);
	if (existsSync(args.data)) rmSync(args.data);

	await withConnection(args.cdpPort, async (cdp) => {
		// T99/T100: fold the note --note names, and look it up under the key the plugin uses.
		const target = await useNote(cdp, args.note);
		await sleep(args.waitMs);
		// R3: start from a note Obsidian did not restore (partly) folded — a fold click on a block
		// that is still folded would *unfold* it. Wait until the lines the folds below hide are
		// back in the DOM (Obsidian's auto-folded frontmatter may stay folded; it is not listed).
		const unfold = await unfoldAll(cdp, ["Outline", "Notes for Tuesday"], { waitMs: args.waitMs });
		if (!unfold.unfolded) throw new Error(`could not unfold the note first; still hidden: ${JSON.stringify(unfold.missing)}`);

		// GP1-GP3's own baseline: fold "## Tuesday" and the task "Draft proposal", leave the
		// sibling task "Send invoices" unfolded — exactly GP4's own starting point. Needle is
		// "Tuesday" (the heading line itself), not "Notes for Tuesday" (its body text).
		//
		// T7: "Draft proposal" is folded *before* "## Tuesday": it is nested directly under the
		// heading, so folding the heading first removes its line from the rendered DOM.
		//
		// T1/R3: park the cursor outside every foldable block (CM6 drops a fold that contains
		// the selection head), and fold each block with e2e-lib's foldAndConfirm: scoped to the
		// active editor, polled, confirmed from the DOM, with the editor:toggle-fold fallback.
		// A step whose block did not fold throws here, with a DOM diagnostic, instead of
		// surfacing later as a missing stored entry.
		const cursor = await parkCursorOutsideFolds(cdp);
		if (!cursor.parked) throw new Error(`could not park the cursor outside the folds: ${cursor.reason ?? "unknown"}`);
		await sleep(args.waitMs);
		for (const [needle, hidden] of [
			["Draft proposal", "Outline"],
			["Tuesday", "Notes for Tuesday"],
		] as const) {
			const step = await foldAndConfirm(cdp, needle, hidden, { waitMs: args.waitMs });
			if (!step.folded) throw new Error(`folding "${needle}" did not take: ${JSON.stringify(step)}`);
		}
		await sleep(args.waitMs);

		const record = requireRecord(readPluginData(args.data), target.vaultPath, args.data);
		const nonFrontmatter = record.folds.filter((f) => f.kind !== "frontmatter");
		if (nonFrontmatter.length < 2) {
			throw new Error(
				`expected at least 2 stored anchors (Tuesday heading + Draft proposal task) under ${JSON.stringify(target.vaultPath)}, ` +
					`got ${nonFrontmatter.length}: ${JSON.stringify(record.folds.map((fold) => fold.kind))}`,
			);
		}

		console.log(`PASS before-quit: folds set and stored under ${JSON.stringify(target.vaultPath)}. Quit Obsidian now, then run --phase rewrite.`);
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
			// The operator opens --note after the relaunch; make sure it really is the active
			// editor (and learn its vault key) before reading folds off the screen.
			const target = await useNote(cdp, args.note);
			await sleep(args.waitMs);

			const data = readPluginData(args.data);
			const record = data?.files[target.vaultPath];
			if (!record) {
				problems.push(
					`no stored entry for ${JSON.stringify(target.vaultPath)} after relaunch ` +
						`(data.json holds: ${JSON.stringify(data ? Object.keys(data.files) : null)})`,
				);
			} else {
				const onDiskText = readFileSync(args.note, "utf8");
				const expectedHash = hashText(onDiskText);
				if (record.contentHash !== expectedHash) {
					problems.push(`contentHash mismatch: stored ${record.contentHash}, expected ${expectedHash} (G8 re-match may not have run)`);
				}
			}

			const visibleLines = await readVisibleLines(cdp);

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
			const expand = (await evaluate(cdp, clickFoldIndicatorExpression("Tuesday"))) as {
				clicked: boolean;
				reason?: string;
			};
			if (!expand.clicked) {
				problems.push(`could not expand "## Tuesday" to check its nested lines: ${expand.reason}`);
			} else {
				await sleep(200);
				const expandedLines = await readVisibleLines(cdp);

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
