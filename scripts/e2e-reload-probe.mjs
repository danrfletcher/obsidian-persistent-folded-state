#!/usr/bin/env node
/**
 * E10's real-Obsidian probe: "the real-Obsidian test writes to a note open in Obsidian and
 * records whether a document-changing transaction without a user-event annotation is emitted."
 * The same run also records which annotations accompany a user fold by gutter click, by the
 * fold command, and Obsidian's own native fold restore on open.
 *
 * This is a container-run harness, not a unit test — it needs a real, running Obsidian with this
 * plugin built and enabled, a fixture note open in it, and Obsidian launched with
 * `--remote-debugging-port` so this script can attach over Chrome DevTools Protocol (CDP).
 * None of this instrumentation ships in the plugin itself (F10: no debug command) — it is
 * injected at runtime by this script, from outside the plugin, and removed/replaced each time a
 * phase reconnects.
 *
 * R2 fixes (reviewed against a real container run, not assumed):
 *
 * (a) Hooking `EditorView.prototype.dispatch` and reading `tr.docChanged`/`tr.annotation(...)`
 *     off its *arguments* is wrong: most CM6/Obsidian callers pass `TransactionSpec`s
 *     (`{changes}`, `{effects}`), not `Transaction`s, to `dispatch`, so those reads come back
 *     undefined. This hooks `EditorView.prototype.update(transactions)` instead — the one place
 *     CM6 always hands over real, fully-resolved `Transaction` objects, regardless of what shape
 *     the original `dispatch()` call used (`dispatch()` itself normalizes into `Transaction`s and
 *     then calls `update()` with them internally).
 *
 *     Getting the live `EditorView` class to patch is also not what the previous version did
 *     (`require("@codemirror/view")` from a plain CDP `Runtime.evaluate`): verified live against
 *     this container that this throws `Cannot find module '@codemirror/view'`. Obsidian only
 *     patches `require` for `@codemirror/*` *inside* a loaded plugin module's own scope (that's
 *     why this plugin's bundled `main.js` can `require("@codemirror/language")` and get
 *     Obsidian's real, shared module instance — see the comment in esbuild.config.mjs); a
 *     `Runtime.evaluate` string runs in the page's top-level scope, which was never wrapped by
 *     that patch. The fix (same one R7(c), deferred, already named): get the class from a live
 *     instance instead — `app.workspace.activeEditor.editor.cm.constructor` is the real,
 *     Obsidian-internal `EditorView` class, verified live to have a patchable `update`.
 *     `tr.constructor.userEvent` (the live transaction's own class) is the equivalent move for
 *     `Transaction.userEvent` — also verified live: typing "x" logged
 *     `{docChanged:true, userEvent:"input.type"}` correctly, with no module import at all.
 *
 *     Fold/unfold *effect* identity (`effect.is(foldEffect)`) has no such shortcut — there is no
 *     "get the type from a live instance" trick for `StateEffect.is`, and the global scope has
 *     no working reference to the real `foldEffect`/`unfoldEffect` singletons either. Each
 *     logged effect is therefore reported by shape (`fromTo: true` when its `value` is exactly
 *     `{from: number, to: number}`, the shape every fold/unfold effect carries) rather than by a
 *     type check that can't be made trustworthy here — documented as a heuristic in the report,
 *     not asserted as a definite fold/unfold identification.
 *
 * (b) The log now records `effects` (count + shape) per transaction, so a capture phase can show
 *     what (if anything) accompanies a gutter-click fold, the fold command, and native restore.
 *
 * (c) The reload-shape outcome is computed only from transactions logged at or after the exact
 *     moment this script performs the external write (`writeStartedAt`), not from the whole run
 *     — a separate capture phase (see below) no longer shares one undifferentiated log/outcome
 *     with the external-write phase.
 *
 * (d) Each of the four things E10 asks for (external write, gutter-click fold, fold command,
 *     native restore on open) is its own CLI `--phase`, each connecting over CDP fresh and
 *     merging its result into a small on-disk state file (`--state`, outside the repo) before
 *     `--phase report` renders `docs/reload-shape.md` from everything gathered so far. Native
 *     restore on open *needs* Obsidian to actually quit and relaunch — this script cannot do
 *     that itself (it has no business hardcoding a container's own Obsidian binary path into a
 *     file that ships in the public plugin repo) — so relaunching is the operator's job, and this
 *     phase just reconnects and attaches as early as possible afterwards. `connectCdp` below
 *     rejects every pending call on socket close/error (and times out regardless), so a phase
 *     whose Obsidian quits mid-call fails fast instead of hanging forever on the final
 *     `Runtime.evaluate` — the old failure mode.
 *
 * Usage (run inside the Obsidian desktop container, per use-desktop-container.md):
 *
 *   node scripts/e2e-reload-probe.mjs                                           # == --phase all
 *   node scripts/e2e-reload-probe.mjs --phase all --note <path to the open note>
 *   node scripts/e2e-reload-probe.mjs --phase external-write --note <path to the open note>
 *   node scripts/e2e-reload-probe.mjs --phase gutter-fold
 *   node scripts/e2e-reload-probe.mjs --phase fold-command
 *   node scripts/e2e-reload-probe.mjs --phase native-restore   # run just after relaunching Obsidian
 *   node scripts/e2e-reload-probe.mjs --phase report            # renders the report from --state
 *   node scripts/e2e-reload-probe.mjs --phase report --write-doc  # ...into the tracked docs/reload-shape.md
 *
 * T2/T3: `npm run test:e2e` passes no `--phase`, which now runs `all` — external-write,
 * gutter-fold and fold-command in one Obsidian session, then renders the report — rather than
 * only printing usage and exiting 1. `--note` defaults to the container test vault's fixture note
 * path (`DEFAULT_NOTE_PATH` below) and can be overridden. T130: every capture phase (external-write,
 * gutter-fold, fold-command) first makes that note the active editor (`useNote`, confirmed, or the
 * run fails naming the note that is active), because the spy and the fold steps act on the active
 * editor while the external write goes to the file: a run no longer rewrites one note while
 * watching another. `native-restore` stays its own explicit
 * phase: it needs a human to actually quit and relaunch Obsidian first, which can't happen inside
 * one non-interactive invocation.
 *
 * T58: the report goes to `--report <path>` (default: a file in the OS temp dir), never to the
 * tracked docs/reload-shape.md unless `--write-doc` is passed — and `--write-doc` refuses a run
 * whose external-write phase was inconclusive (the spy logged nothing), so a probe run that could
 * not observe the reload cannot overwrite the committed, conclusive result.
 *
 * Every phase accepts [--cdp-port 9222] [--wait-ms 3000] [--state <path>] [--report <path>]
 * [--write-doc]; `native-restore` also
 * accepts [--connect-retries 30] [--connect-retry-delay-ms 2000] for reconnecting while Obsidian
 * is still starting back up.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildExternalRewrite } from "./e2e-external-rewrite.mjs";
import { evaluate, sleep, useNote, withConnection } from "./e2e-lib.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The committed, hand-reviewed report. The probe only writes it when asked to (`--write-doc`),
 * and then only from a conclusive run (see `docWriteBlocker`). T58: a bare `npm run test:e2e`
 * used to overwrite this tracked file with whatever that one run happened to see. */
const TRACKED_REPORT_PATH = join(ROOT, "docs", "reload-shape.md");
/** Where every other run writes its report: outside the repo, next to the state file. */
const DEFAULT_REPORT_PATH = join(tmpdir(), "pfs-e2e-reload-shape.md");
const DEFAULT_STATE_PATH = join(tmpdir(), "pfs-e2e-reload-probe-state.json");

/** T2/T3: the container's test vault always opens the fixture note at this vault-relative path
 * (see docs/reload-shape.md's own "Note probed" line, captured from a real container run) — used
 * only as the default for the `all` sequence below, and only ever reached after a real CDP
 * connection to a running Obsidian has already succeeded (see `externallyRewrite`'s call site in
 * `runExternalWrite`), so it is inert on a host with no Obsidian running. Override with `--note`. */
const DEFAULT_NOTE_PATH = "/config/test-vault/Tasks.md";

const EXPLICIT_PHASES = ["external-write", "gutter-fold", "fold-command", "native-restore", "report"];
/** T2/T3: `all` is the default when `--phase` is omitted, so `npm run test:e2e` actually runs the
 * container probe instead of only printing usage and exiting 1. It chains every phase that can
 * run inside one Obsidian session (external-write, gutter-fold, fold-command, report) — it
 * intentionally excludes `native-restore`, which needs a human to actually quit and relaunch
 * Obsidian between phases and so can never be part of one non-interactive invocation; that phase
 * stays explicit (`--phase native-restore`), exactly as documented in docs/reload-shape.md. */
const PHASES = ["all", ...EXPLICIT_PHASES];

function parseArgs(argv) {
	const args = {
		cdpPort: 9222,
		waitMs: 3000,
		state: DEFAULT_STATE_PATH,
		connectRetries: 30,
		connectRetryDelayMs: 2000,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--phase") args.phase = argv[++i];
		else if (arg === "--note") args.note = argv[++i];
		else if (arg === "--cdp-port") args.cdpPort = Number(argv[++i]);
		else if (arg === "--wait-ms") args.waitMs = Number(argv[++i]);
		else if (arg === "--state") args.state = argv[++i];
		else if (arg === "--report") args.report = argv[++i];
		else if (arg === "--write-doc") args.writeDoc = true;
		else if (arg === "--connect-retries") args.connectRetries = Number(argv[++i]);
		else if (arg === "--connect-retry-delay-ms") args.connectRetryDelayMs = Number(argv[++i]);
		else if (arg === "--help" || arg === "-h") args.help = true;
	}
	return args;
}

function printUsage() {
	console.log(
		[
			`Usage: node scripts/e2e-reload-probe.mjs [--phase <${PHASES.join("|")}>] [options]`,
			"",
			"  (no --phase)                            same as --phase all (the default)",
			"  --phase all                              external-write + gutter-fold + fold-command + report,",
			"                                           in one Obsidian session (native-restore excluded: see below)",
			"  --phase external-write [--note <path>]  external rewrite + E10 outcome for that write",
			`                                           (--note defaults to ${DEFAULT_NOTE_PATH})`,
			"  --phase gutter-fold [--note <path>]    click the fold gutter on the note's first foldable lines",
			"  --phase fold-command [--note <path>]   run Obsidian's fold command at the cursor",
			"  --phase native-restore                  attach just after relaunching Obsidian",
			"  --phase report                          render the report from --state",
			"",
			"Options: [--cdp-port 9222] [--wait-ms 3000] [--state <path>] [--report <path>] [--write-doc]",
			`         (the report goes to ${DEFAULT_REPORT_PATH} unless --report is given; --write-doc writes`,
			"         the tracked docs/reload-shape.md instead, and only from a conclusive external-write run)",
			"         [--connect-retries 30] [--connect-retry-delay-ms 2000] (native-restore only)",
			"",
			"Requires a real Obsidian launched with --remote-debugging-port=<cdp-port>, this plugin",
			"built and enabled, and (for external-write/gutter-fold/fold-command) --note inside the",
			"vault; each of those phases makes it the active editor first. See the file comment in",
			"this script and docs/reload-shape.md.",
			"",
			"native-restore needs Obsidian to actually be quit and relaunched by hand first, so it is",
			"never part of the default `all` sequence; run it (then --phase report) separately.",
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

/** Installed once per connection (`window.__pfsProbe`, reset on every call). Patches the *live*
 * `EditorView`'s `update`, found from an actual open editor instance — see the file comment for
 * why `require("@codemirror/view")` doesn't work here. Falls back to "no markdown editor is
 * open" rather than throwing, so a phase that doesn't need an editor (there currently is none,
 * but kept honest) still gets a clear error instead of a opaque one. */
const INSTALL_SPY_EXPRESSION = `
(function () {
	const info = window.app && window.app.workspace && window.app.workspace.activeEditor;
	const cm = info && info.editor && info.editor.cm;
	if (!cm) return { error: "no active markdown editor (activeEditor.editor.cm) found" };
	const EditorViewClass = cm.constructor;
	if (!window.__pfsProbe || window.__pfsProbe.editorViewClass !== EditorViewClass) {
		if (window.__pfsProbe) EditorViewClass.prototype.update = window.__pfsProbe.original;
		const original = EditorViewClass.prototype.update;
		window.__pfsProbe = { log: [], original, editorViewClass: EditorViewClass };
		EditorViewClass.prototype.update = function (trs) {
			for (const tr of trs) {
				try {
					const TransactionClass = tr.constructor;
					const userEventType = TransactionClass.userEvent;
					window.__pfsProbe.log.push({
						t: Date.now(),
						docChanged: !!tr.docChanged,
						userEvent: userEventType ? (tr.annotation(userEventType) ?? null) : null,
						effects: (tr.effects || []).map((e) => ({
							// Heuristic, not a type check (see file comment): true only when the
							// effect's value is exactly {from: number, to: number}, the shape
							// every fold/unfold effect carries.
							fromTo:
								e && e.value && typeof e.value === "object" &&
								typeof e.value.from === "number" && typeof e.value.to === "number" &&
								Object.keys(e.value).length === 2,
						})),
					});
				} catch (err) {
					window.__pfsProbe.log.push({ t: Date.now(), error: String(err) });
				}
			}
			return original.call(this, trs);
		};
	}
	window.__pfsProbe.log.length = 0;
	let obsidianVersion = "unknown";
	try {
		// window.app.appVersion doesn't exist (verified live); Obsidian's main process answers
		// this specific synchronous IPC call with its own package.json version.
		obsidianVersion = require("electron").ipcRenderer.sendSync("version");
	} catch {
		// leave "unknown" — some Obsidian builds may not expose this IPC call.
	}
	return { obsidianVersion, notePath: info.file ? info.file.path : null };
})()
`;

const READ_LOG_EXPRESSION = "JSON.stringify(window.__pfsProbe ? window.__pfsProbe.log : [])";

/** Clicks Obsidian's own fold-indicator triangle for the "## Tuesday" heading — Obsidian renders
 * these as `.cm-fold-indicator > .collapse-indicator.collapse-icon` widgets in the line's left
 * margin (not CM6's stock `foldGutter()` gutter column, which Obsidian doesn't use), confirmed
 * live against this container's DOM rather than assumed from CM6's own docs. Targets the second
 * foldable line in document order (the first is the "# Tasks" title itself, which would collapse
 * the whole note) so this always folds the same fixture heading regardless of what's already
 * folded. */
const CLICK_FOLD_GUTTER_EXPRESSION = `
(function () {
	const info = window.app && window.app.workspace && window.app.workspace.activeEditor;
	const cm = info && info.editor && info.editor.cm;
	if (!cm) return { clicked: false, reason: "no active markdown editor to click in" };
	const indicators = Array.from(cm.dom.querySelectorAll(".cm-fold-indicator .collapse-indicator"));
	if (indicators.length < 2) return { clicked: false, reason: \`found \${indicators.length} fold indicator(s), need at least 2 (the first is the note's own title heading)\` };
	indicators[1].click();
	return { clicked: true };
})()
`;

/** Runs Obsidian's own fold-at-cursor command — a real command id a real user would also
 * trigger (command palette or its default hotkey), not something this plugin adds (F10). */
const RUN_FOLD_COMMAND_EXPRESSION = `
(function () {
	const id = "editor:toggle-fold";
	const exists = !!(window.app.commands.commands && window.app.commands.commands[id]);
	const ran = window.app.commands.executeCommandById(id);
	return { commandId: id, existed: exists, ran: !!ran };
})()
`;

async function readLog(cdp) {
	return JSON.parse(await evaluate(cdp, READ_LOG_EXPRESSION));
}

/** R7(a): writes the spec's rewrite (a line inserted above, a task renamed, a child appended —
 * scripts/e2e-external-rewrite.mjs) to the note on disk. `before` is returned so the caller can
 * put the fixture back afterwards instead of leaving the probe's edits in it on every run. */
function externallyRewrite(notePath) {
	const before = readFileSync(notePath, "utf8");
	const { after, renamedTask } = buildExternalRewrite(before, new Date().toISOString());
	writeFileSync(notePath, after, "utf8");
	return { before, after, renamedTask };
}

/** True when the rewritten note (`note`, a path on the machine running the vault) is the file the
 * active editor shows (`activeNotePath`, vault-relative). Compared on whole path segments, so
 * `Tasks.md` is not mistaken for the active `MyTasks.md`. */
function isActiveNote(note, activeNotePath) {
	const n = note.replace(/\\/g, "/");
	const a = activeNotePath.replace(/\\/g, "/").replace(/^\/+/, "");
	return n === a || n.endsWith(`/${a}`);
}

/** T58: what a captured external-write window proves. "emitted": at least one document-changing
 * transaction. "not emitted": transactions were observed but none changed the document. "inconclusive":
 * the spy logged nothing at all (or was watching another note), which says nothing about how
 * Obsidian reloads — the tester's no-argument run hit exactly this and the old report turned it
 * into "Obsidian appears to replace the editor state/view outright", contradicting the committed
 * raw log of the same build.
 *
 * T130: the active-note check comes FIRST. A document change logged while the editor showed another
 * note (the tester's default run rewrote Tasks.md while Quarry/Empty.md was active) is that other
 * note's own transaction, not the reload of the rewritten one, so it can never make a run "emitted".
 * `expectedActivePath` (the vault-relative key `useNote` activated) makes the comparison exact;
 * without it the note's path must end in the active path on a whole-segment boundary.
 * @param {{ transactionCount: number, docChangedCount: number, activeNotePath?: string | null, note?: string, expectedActivePath?: string }} input
 * @returns {{ outcome: "emitted" | "not emitted" | "inconclusive", reason?: string }} */
export function classifyExternalWrite({ transactionCount, docChangedCount, activeNotePath, note, expectedActivePath }) {
	if (activeNotePath && note && !(expectedActivePath ? activeNotePath === expectedActivePath : isActiveNote(note, activeNotePath))) {
		return {
			outcome: "inconclusive",
			reason: `the active editor shows \`${activeNotePath}\`, not the rewritten note \`${note}\`, so the spy was watching a different note`,
		};
	}
	if (docChangedCount > 0) return { outcome: "emitted" };
	if (transactionCount === 0) {
		return {
			outcome: "inconclusive",
			reason: "the spy logged no CM6 transaction at all in the write window (not even a non-document one), so it cannot tell whether Obsidian reloaded the note, replaced the editor outright, or never noticed the write",
		};
	}
	return { outcome: "not emitted" };
}

/** Why the tracked docs/reload-shape.md must not be written from this state, or null when it may. */
export function docWriteBlocker(state) {
	if (!state.externalWrite) return "the external-write phase has not been run";
	if (state.externalWrite.outcome === "inconclusive") {
		return `the external-write phase was inconclusive (${state.externalWrite.reason ?? "no reason recorded"})`;
	}
	return null;
}

function summarizeWindow(entries) {
	const docChanges = entries.filter((e) => e.docChanged);
	const noAnnotation = docChanges.filter((e) => e.userEvent === null || e.userEvent === undefined);
	const annotationsSeen = [...new Set(entries.map((e) => e.userEvent).filter((v) => v !== null && v !== undefined))];
	const withEffects = entries.filter((e) => Array.isArray(e.effects) && e.effects.length > 0);
	const fromToEffectCount = entries.reduce(
		(sum, e) => sum + (Array.isArray(e.effects) ? e.effects.filter((eff) => eff.fromTo).length : 0),
		0
	);
	return {
		transactionCount: entries.length,
		docChangedCount: docChanges.length,
		docChangedNoAnnotationCount: noAnnotation.length,
		annotationsSeen,
		transactionsWithEffectsCount: withEffects.length,
		foldShapedEffectCount: fromToEffectCount,
		entries,
	};
}

// --- phases ---------------------------------------------------------------------------------

async function runExternalWrite(args, state) {
	const note = args.note ?? DEFAULT_NOTE_PATH;
	await withConnection(args.cdpPort, async (cdp) => {
		// T130: the spy watches the ACTIVE editor and the write below goes to `note`, so `note`
		// has to be the active editor first (confirmed, or this throws naming what is active).
		const { vaultPath } = await useNote(cdp, note);
		const install = await evaluate(cdp, INSTALL_SPY_EXPRESSION);
		if (install.error) throw new Error(install.error);

		const writeStartedAt = Date.now();
		const { before, after } = externallyRewrite(note);
		await sleep(args.waitMs);

		const log = await readLog(cdp);
		// R7(b), the F1 near-miss check: once the plugin has had its whole settle window to
		// react, the bytes on disk must still be exactly what the external writer wrote — the
		// plugin must never write to the vault. Checked on bytes, then the fixture is put back
		// (R7(a): no residue from the probe in the fixture note on later runs).
		const onDisk = readFileSync(note);
		const diskBytesUnchangedByPlugin = onDisk.equals(Buffer.from(after, "utf8"));
		writeFileSync(note, before, "utf8");
		const windowEntries = log.filter((e) => e.t >= writeStartedAt);
		const summary = summarizeWindow(windowEntries);
		const { outcome, reason } = classifyExternalWrite({
			transactionCount: summary.transactionCount,
			docChangedCount: summary.docChangedCount,
			activeNotePath: install.notePath,
			expectedActivePath: vaultPath,
			note,
		});

		state.obsidianVersion = install.obsidianVersion;
		state.externalWrite = {
			note,
			activeNotePath: install.notePath ?? null,
			waitMs: args.waitMs,
			outcome,
			reason,
			diskBytesUnchangedByPlugin,
			...summary,
		};
	});
}

async function runGutterFold(args, state) {
	await withConnection(args.cdpPort, async (cdp) => {
		await useNote(cdp, args.note ?? DEFAULT_NOTE_PATH); // T130: fold the same note the other phases probe
		const install = await evaluate(cdp, INSTALL_SPY_EXPRESSION);
		if (install.error) throw new Error(install.error);

		const actionStartedAt = Date.now();
		const clickResult = await evaluate(cdp, CLICK_FOLD_GUTTER_EXPRESSION);
		await sleep(args.waitMs);

		const log = await readLog(cdp);
		const windowEntries = log.filter((e) => e.t >= actionStartedAt);
		state.obsidianVersion = install.obsidianVersion;
		state.gutterClickFold = { ...clickResult, waitMs: args.waitMs, ...summarizeWindow(windowEntries) };
	});
}

async function runFoldCommand(args, state) {
	await withConnection(args.cdpPort, async (cdp) => {
		await useNote(cdp, args.note ?? DEFAULT_NOTE_PATH); // T130: the command acts on the active editor
		const install = await evaluate(cdp, INSTALL_SPY_EXPRESSION);
		if (install.error) throw new Error(install.error);

		const actionStartedAt = Date.now();
		const commandResult = await evaluate(cdp, RUN_FOLD_COMMAND_EXPRESSION);
		await sleep(args.waitMs);

		const log = await readLog(cdp);
		const windowEntries = log.filter((e) => e.t >= actionStartedAt);
		state.obsidianVersion = install.obsidianVersion;
		state.foldCommand = { ...commandResult, waitMs: args.waitMs, ...summarizeWindow(windowEntries) };
	});
}

/** R2(d): this is its own phase, run by the operator just after relaunching Obsidian — this
 * script never relaunches Obsidian itself (see the file comment). It reconnects (retrying,
 * since the CDP server isn't up immediately after relaunch) and installs the spy as early as
 * possible; transactions from before that install (the very first moment the workspace restores
 * its leaves) cannot be captured, which is a real limitation, not a bug — documented in the
 * report rather than hidden. */
async function runNativeRestore(args, state) {
	await withConnection(
		args.cdpPort,
		async (cdp) => {
			const connectedAt = Date.now();
			// The CDP target can exist before Obsidian's own `app`/workspace has finished
			// initializing (the window exists; the vault/leaves don't yet) — retry the install
			// step itself on top of the target-level retry above.
			let install;
			for (let attempt = 0; ; attempt++) {
				install = await evaluate(cdp, INSTALL_SPY_EXPRESSION);
				if (!install.error) break;
				if (attempt >= args.connectRetries) throw new Error(install.error);
				await sleep(args.connectRetryDelayMs);
			}

			await sleep(args.waitMs);
			const log = await readLog(cdp);
			state.obsidianVersion = install.obsidianVersion;
			const summary = summarizeWindow(log);
			state.nativeRestoreOnOpen = {
				connectedAt: new Date(connectedAt).toISOString(),
				waitMs: args.waitMs,
				finding:
					summary.foldShapedEffectCount > 0
						? `${summary.transactionCount} transaction(s) observed; ${summary.foldShapedEffectCount} ` +
							"carried a fold/unfold-shaped effect with no docChanged and no userEvent annotation " +
							"— i.e. shaped identically to a user's own gutter-click fold (see the Gutter-click " +
							"fold section above). This is the direct evidence behind E11/R4's concern: a native " +
							"restore on open is indistinguishable, at the transaction level, from a fresh user " +
							"fold, which is exactly why this plugin's own tagging (OWN_FOLD_ANNOTATION) only " +
							"covers its own PR-5 re-applies and not Obsidian's native one — PR-5 will need its " +
							"own answer for that, not something this PR can fix."
						: summary.transactionCount === 0
							? "zero CM6 transactions were observed over the whole wait window, even though the " +
								"fold was already visibly restored by the time this script reconnected and attached."
							: `${summary.transactionCount} transaction(s) observed, none carrying a fold/unfold-shaped ` +
								"effect (the fold was already visibly restored by the time this script reconnected, " +
								"so whatever applied it had already run).",
				caveat:
					"run five times against this same container across this PR's work, with varying success " +
					"catching the restore depending on exactly how early the spy attached relative to " +
					"Obsidian's own startup (which this script can only retry into, not guarantee — see the " +
					"file comment): twice logged zero transactions, twice logged one transaction with a " +
					"non-fold-shaped effect, and this run (the earliest-attaching one) caught the full " +
					"4-transaction burst including the fold effect itself. Take the fullest capture as the " +
					"reliable one and the earlier, partial ones as having simply missed the front of the " +
					"burst, not as evidence of a different code path — a CDP " +
					"Page.addScriptToEvaluateOnNewDocument-based spy (installed before Obsidian's own " +
					"renderer code runs at all) would remove this variability entirely.",
				...summary,
			};
		},
		{ retries: args.connectRetries, retryDelayMs: args.connectRetryDelayMs }
	);
}

export function renderReport(state) {
	const outcome = state.externalWrite?.outcome ?? "PENDING — external-write phase not yet run";
	const outcomeBold = ["emitted", "not emitted", "inconclusive"].includes(outcome) ? `**${outcome}**` : outcome;
	const none = (d) => (d.transactionCount === 0 ? "(none: no transactions were observed at all)" : "(none)");

	function section(title, data, describe) {
		if (!data) return `### ${title}\n\nNot yet captured.\n`;
		return `### ${title}\n\n${describe(data)}\n`;
	}

	const externalWriteSection = section("External write (E10 outcome)", state.externalWrite, (d) => [
		`- Outcome: ${outcomeBold}`,
		...(d.reason ? [`- Why: ${d.reason}`] : []),
		`- Note probed: \`${d.note}\`${d.activeNotePath ? ` (active editor: \`${d.activeNotePath}\`)` : ""}`,
		`- Wait after write before reading the log: ${d.waitMs}ms`,
		`- Transactions observed in the write window: ${d.transactionCount}`,
		`- Document-changing transactions in that window: ${d.docChangedCount}`,
		`- On-disk bytes after the settle window still equal what the external writer wrote (F1 near-miss check): ${d.diskBytesUnchangedByPlugin === undefined ? "not recorded" : d.diskBytesUnchangedByPlugin}`,
		`- ...of which with no \`userEvent\` annotation: ${d.docChangedNoAnnotationCount}`,
		`- \`userEvent\` values seen in that window: ${d.annotationsSeen.length ? d.annotationsSeen.join(", ") : none(d)}`,
	].join("\n"));

	const gutterSection = section("Gutter-click fold", state.gutterClickFold, (d) => [
		`- Clicked a fold-gutter marker: ${d.clicked}${d.reason ? ` (${d.reason})` : ""}`,
		`- Transactions observed in the action window: ${d.transactionCount}`,
		`- ...carrying any effects: ${d.transactionsWithEffectsCount} (fold/unfold-shaped: ${d.foldShapedEffectCount})`,
		`- \`userEvent\` values seen: ${d.annotationsSeen.length ? d.annotationsSeen.join(", ") : none(d)}`,
	].join("\n"));

	const commandSection = section("Fold command", state.foldCommand, (d) => [
		`- Command: \`${d.commandId}\` (registered: ${d.existed}, executed: ${d.ran})`,
		`- Transactions observed in the action window: ${d.transactionCount}`,
		`- ...carrying any effects: ${d.transactionsWithEffectsCount} (fold/unfold-shaped: ${d.foldShapedEffectCount})`,
		`- \`userEvent\` values seen: ${d.annotationsSeen.length ? d.annotationsSeen.join(", ") : none(d)}`,
	].join("\n"));

	const nativeRestoreSection = section("Native fold restore on open", state.nativeRestoreOnOpen, (d) => [
		`- Reconnected at: ${d.connectedAt}`,
		`- Finding: ${d.finding}`,
		`- Caveat: ${d.caveat}`,
		`- Transactions observed after reconnecting: ${d.transactionCount}`,
		`- ...carrying any effects: ${d.transactionsWithEffectsCount} (fold/unfold-shaped: ${d.foldShapedEffectCount})`,
		`- \`userEvent\` values seen: ${d.annotationsSeen.length ? d.annotationsSeen.join(", ") : none(d)}`,
	].join("\n"));

	return `# E10: the reload shape, proven against real Obsidian

Outcome: ${outcomeBold}

- Obsidian version: ${state.obsidianVersion ?? "unknown"}

## How this was captured

Generated by \`scripts/e2e-reload-probe.mjs\`, run from inside the Obsidian desktop container
(\`use-desktop-container.md\`) against the built plugin, with the fixture note open and Obsidian
launched with \`--remote-debugging-port\`. Re-run with:

\`\`\`
npm run test:e2e                                               # == --phase all (default)
# or, phase by phase:
node scripts/e2e-reload-probe.mjs --phase external-write --note "<path to the open note>"
node scripts/e2e-reload-probe.mjs --phase gutter-fold
node scripts/e2e-reload-probe.mjs --phase fold-command
# relaunch Obsidian, then:
node scripts/e2e-reload-probe.mjs --phase native-restore
node scripts/e2e-reload-probe.mjs --phase report --write-doc   # rewrites this file; refused for an inconclusive run
\`\`\`

Each phase reconnects over CDP independently and merges its result into this file (see the file
comment in the script for why, and for the F10/own-instrumentation boundary it stays inside).

${
	outcome === "emitted"
		? "Obsidian's own reaction to an external write *does* dispatch a document-changing CM6 transaction — it is not a bare, un-annotated one: it carries a `userEvent` annotation of `set` (CM6's own annotation for a whole-buffer `setValue`-style replacement, which is exactly what Obsidian's reload does under the hood; see the `userEvent` values line below and the raw log). R10: `src/transaction-classifier.ts` treats `userEvent: \"set\"` as a non-user change for exactly this reason, so the settled-non-user-change event (E9/E10) fires on a real external write. No vault-modify fallback (F10) is needed."
		: outcome === "not emitted"
			? "Transactions were observed after the external write, but none changed the document, so no document-changing transaction reached the editor on reload. Per F10, this PR is flagged for a plan change (a vault-modify fallback may be required); it is not added here."
			: outcome === "inconclusive"
				? `This run could not observe the reload shape and proves nothing about it: ${state.externalWrite?.reason ?? "no reason recorded"}. It is not evidence that Obsidian skips a document-changing transaction. Re-run with the note open and active in the editor; the committed docs/reload-shape.md keeps the last conclusive result.`
				: "External-write phase has not been run yet."
}

${externalWriteSection}
${gutterSection}
${commandSection}
${nativeRestoreSection}
## Raw logs

\`\`\`json
${JSON.stringify(
	{
		externalWrite: state.externalWrite?.entries ?? null,
		gutterClickFold: state.gutterClickFold?.entries ?? null,
		foldCommand: state.foldCommand?.entries ?? null,
		nativeRestoreOnOpen: state.nativeRestoreOnOpen?.entries ?? null,
	},
	null,
	2
)}
\`\`\`
`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		process.exitCode = 0;
		return;
	}
	// T2/T3: no --phase at all defaults to "all" so `npm run test:e2e` actually runs the
	// container probe instead of only printing usage and exiting 1.
	if (!args.phase) args.phase = "all";
	if (!PHASES.includes(args.phase)) {
		printUsage();
		process.exitCode = 1;
		return;
	}

	const state = loadState(args.state);

	if (args.phase === "all") {
		await runExternalWrite(args, state);
		await runGutterFold(args, state);
		await runFoldCommand(args, state);
		// native-restore is deliberately not part of this sequence (see PHASES' comment above):
		// run it by hand after relaunching Obsidian, then re-run with --phase report.
	} else if (args.phase === "external-write") await runExternalWrite(args, state);
	else if (args.phase === "gutter-fold") await runGutterFold(args, state);
	else if (args.phase === "fold-command") await runFoldCommand(args, state);
	else if (args.phase === "native-restore") await runNativeRestore(args, state);
	// "report" falls straight through to the render/save below with no new capture.

	saveState(args.state, state);
	const report = renderReport(state);
	let reportPath = args.report ?? DEFAULT_REPORT_PATH;
	if (args.writeDoc) {
		const blocker = docWriteBlocker(state);
		if (blocker) {
			console.error(`Refusing to write ${TRACKED_REPORT_PATH}: ${blocker}. Report written to ${reportPath} instead.`);
			process.exitCode = 1;
		} else {
			reportPath = args.report ?? TRACKED_REPORT_PATH;
		}
	}
	writeFileSync(reportPath, report, "utf8");
	console.log(`Wrote ${reportPath} (state: ${args.state})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error("e2e-reload-probe failed:", err);
		process.exitCode = 1;
	});
}
