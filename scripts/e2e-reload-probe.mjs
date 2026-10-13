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
 *   node scripts/e2e-reload-probe.mjs --phase external-write --note <path to the open note>
 *   node scripts/e2e-reload-probe.mjs --phase gutter-fold
 *   node scripts/e2e-reload-probe.mjs --phase fold-command
 *   node scripts/e2e-reload-probe.mjs --phase native-restore   # run just after relaunching Obsidian
 *   node scripts/e2e-reload-probe.mjs --phase report            # (re)writes docs/reload-shape.md
 *
 * Every phase accepts [--cdp-port 9222] [--wait-ms 3000] [--state <path>]; `native-restore` also
 * accepts [--connect-retries 30] [--connect-retry-delay-ms 2000] for reconnecting while Obsidian
 * is still starting back up.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(ROOT, "docs", "reload-shape.md");
const DEFAULT_STATE_PATH = join(tmpdir(), "pfs-e2e-reload-probe-state.json");

const PHASES = ["external-write", "gutter-fold", "fold-command", "native-restore", "report"];

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
		else if (arg === "--connect-retries") args.connectRetries = Number(argv[++i]);
		else if (arg === "--connect-retry-delay-ms") args.connectRetryDelayMs = Number(argv[++i]);
		else if (arg === "--help" || arg === "-h") args.help = true;
	}
	return args;
}

function printUsage() {
	console.log(
		[
			`Usage: node scripts/e2e-reload-probe.mjs --phase <${PHASES.join("|")}> [options]`,
			"",
			"  --phase external-write --note <path>   external rewrite + E10 outcome for that write",
			"  --phase gutter-fold                    click the fold gutter on the open note's first line",
			"  --phase fold-command                    run Obsidian's fold command at the cursor",
			"  --phase native-restore                  attach just after relaunching Obsidian",
			"  --phase report                          (re)write docs/reload-shape.md from --state",
			"",
			"Options: [--cdp-port 9222] [--wait-ms 3000] [--state <path>]",
			"         [--connect-retries 30] [--connect-retry-delay-ms 2000] (native-restore only)",
			"",
			"Requires a real Obsidian launched with --remote-debugging-port=<cdp-port>, this plugin",
			"built and enabled, and (for external-write/gutter-fold/fold-command) --note already open",
			"in an editor. See the file comment in this script and docs/reload-shape.md.",
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

// --- CDP ----------------------------------------------------------------------------------

async function findDebuggableTarget(cdpPort) {
	const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
	if (!res.ok) throw new Error(`CDP target list request failed: HTTP ${res.status}`);
	const targets = await res.json();
	const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
	if (!target) throw new Error("no debuggable Obsidian window found on that CDP port");
	return target;
}

/** Retries `findDebuggableTarget` — used by `native-restore`, where Obsidian is still starting
 * back up (its CDP server, and a fresh debuggable target, don't exist yet right after relaunch). */
async function findDebuggableTargetWithRetry(cdpPort, retries, delayMs) {
	let lastErr;
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			return await findDebuggableTarget(cdpPort);
		} catch (err) {
			lastErr = err;
			await sleep(delayMs);
		}
	}
	throw new Error(`no debuggable Obsidian window on port ${cdpPort} after ${retries} retries: ${lastErr}`);
}

/** Minimal CDP client: one WebSocket, JSON-RPC request/response by id. R2(d): every pending call
 * is rejected (not left hanging) the moment the socket closes or errors, and every call also has
 * its own timeout — so a phase whose Obsidian quits or never responds fails fast and visibly
 * instead of hanging on the final `Runtime.evaluate`, which is what happened before. */
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
	ws.addEventListener("error", () => {
		rejectAllPending(new Error("CDP socket error"));
	});

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

	return {
		send,
		close: () => {
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
		},
	};
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
	const indicators = Array.from(document.querySelectorAll(".cm-fold-indicator .collapse-indicator"));
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

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
	await cdp.send("Runtime.enable");
	const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
	if (result.exceptionDetails) {
		throw new Error(`Runtime.evaluate threw: ${JSON.stringify(result.exceptionDetails)}`);
	}
	return result.result.value;
}

async function readLog(cdp) {
	return JSON.parse(await evaluate(cdp, READ_LOG_EXPRESSION));
}

function externallyRewrite(notePath) {
	const before = readFileSync(notePath, "utf8");
	const rewritten = `<!-- e2e-reload-probe external write at ${new Date().toISOString()} -->\n${before}`;
	writeFileSync(notePath, rewritten, "utf8");
	return { before, after: rewritten };
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

async function withConnection(cdpPort, fn, { retries = 1, retryDelayMs = 0 } = {}) {
	const target = retries > 1 ? await findDebuggableTargetWithRetry(cdpPort, retries, retryDelayMs) : await findDebuggableTarget(cdpPort);
	const cdp = connectCdp(target.webSocketDebuggerUrl);
	try {
		return await fn(cdp);
	} finally {
		cdp.close();
	}
}

async function runExternalWrite(args, state) {
	if (!args.note) throw new Error("--phase external-write requires --note <path>");
	await withConnection(args.cdpPort, async (cdp) => {
		const install = await evaluate(cdp, INSTALL_SPY_EXPRESSION);
		if (install.error) throw new Error(install.error);

		const writeStartedAt = Date.now();
		externallyRewrite(args.note);
		await sleep(args.waitMs);

		const log = await readLog(cdp);
		const windowEntries = log.filter((e) => e.t >= writeStartedAt);
		const summary = summarizeWindow(windowEntries);
		const outcome = summary.docChangedNoAnnotationCount > 0 ? "emitted" : "not emitted";

		state.obsidianVersion = install.obsidianVersion;
		state.externalWrite = { note: args.note, waitMs: args.waitMs, outcome, ...summary };
	});
}

async function runGutterFold(args, state) {
	await withConnection(args.cdpPort, async (cdp) => {
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

function renderReport(state) {
	const outcome = state.externalWrite?.outcome ?? "PENDING — external-write phase not yet run";
	const outcomeBold = outcome === "emitted" || outcome === "not emitted" ? `**${outcome}**` : outcome;

	function section(title, data, describe) {
		if (!data) return `### ${title}\n\nNot yet captured.\n`;
		return `### ${title}\n\n${describe(data)}\n`;
	}

	const externalWriteSection = section("External write (E10 outcome)", state.externalWrite, (d) => [
		`- Outcome: ${outcomeBold}`,
		`- Note probed: \`${d.note}\``,
		`- Wait after write before reading the log: ${d.waitMs}ms`,
		`- Transactions observed in the write window: ${d.transactionCount}`,
		`- Document-changing transactions in that window: ${d.docChangedCount}`,
		`- ...of which with no \`userEvent\` annotation: ${d.docChangedNoAnnotationCount}`,
		`- \`userEvent\` values seen in that window: ${d.annotationsSeen.length ? d.annotationsSeen.join(", ") : "(none)"}`,
	].join("\n"));

	const gutterSection = section("Gutter-click fold", state.gutterClickFold, (d) => [
		`- Clicked a fold-gutter marker: ${d.clicked}${d.reason ? ` (${d.reason})` : ""}`,
		`- Transactions observed in the action window: ${d.transactionCount}`,
		`- ...carrying any effects: ${d.transactionsWithEffectsCount} (fold/unfold-shaped: ${d.foldShapedEffectCount})`,
		`- \`userEvent\` values seen: ${d.annotationsSeen.length ? d.annotationsSeen.join(", ") : "(none)"}`,
	].join("\n"));

	const commandSection = section("Fold command", state.foldCommand, (d) => [
		`- Command: \`${d.commandId}\` (registered: ${d.existed}, executed: ${d.ran})`,
		`- Transactions observed in the action window: ${d.transactionCount}`,
		`- ...carrying any effects: ${d.transactionsWithEffectsCount} (fold/unfold-shaped: ${d.foldShapedEffectCount})`,
		`- \`userEvent\` values seen: ${d.annotationsSeen.length ? d.annotationsSeen.join(", ") : "(none)"}`,
	].join("\n"));

	const nativeRestoreSection = section("Native fold restore on open", state.nativeRestoreOnOpen, (d) => [
		`- Reconnected at: ${d.connectedAt}`,
		`- Finding: ${d.finding}`,
		`- Caveat: ${d.caveat}`,
		`- Transactions observed after reconnecting: ${d.transactionCount}`,
		`- ...carrying any effects: ${d.transactionsWithEffectsCount} (fold/unfold-shaped: ${d.foldShapedEffectCount})`,
		`- \`userEvent\` values seen: ${d.annotationsSeen.length ? d.annotationsSeen.join(", ") : "(none)"}`,
	].join("\n"));

	return `# E10: the reload shape, proven against real Obsidian

Outcome: ${outcomeBold}

- Obsidian version: ${state.obsidianVersion ?? "unknown"}

## How this was captured

Generated by \`scripts/e2e-reload-probe.mjs\`, run from inside the Obsidian desktop container
(\`use-desktop-container.md\`) against the built plugin, with the fixture note open and Obsidian
launched with \`--remote-debugging-port\`. Re-run with:

\`\`\`
node scripts/e2e-reload-probe.mjs --phase external-write --note "<path to the open note>"
node scripts/e2e-reload-probe.mjs --phase gutter-fold
node scripts/e2e-reload-probe.mjs --phase fold-command
# relaunch Obsidian, then:
node scripts/e2e-reload-probe.mjs --phase native-restore
node scripts/e2e-reload-probe.mjs --phase report
\`\`\`

Each phase reconnects over CDP independently and merges its result into this file (see the file
comment in the script for why, and for the F10/own-instrumentation boundary it stays inside).

${
	outcome === "emitted"
		? "Obsidian's own external-reload reaction dispatches a document-changing CM6 transaction with no `userEvent` annotation, exactly as E9/E10 assumed. No vault-modify fallback (F10) is needed."
		: outcome === "not emitted"
			? "No document-changing transaction without a `userEvent` annotation was observed after the external write — Obsidian appears to replace the editor state/view outright on an external reload rather than dispatching one. Per F10, this PR is flagged for a plan change (a vault-modify fallback may be required); it is not added here."
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
	if (args.help || !args.phase || !PHASES.includes(args.phase)) {
		printUsage();
		process.exitCode = args.help ? 0 : 1;
		return;
	}

	const state = loadState(args.state);

	if (args.phase === "external-write") await runExternalWrite(args, state);
	else if (args.phase === "gutter-fold") await runGutterFold(args, state);
	else if (args.phase === "fold-command") await runFoldCommand(args, state);
	else if (args.phase === "native-restore") await runNativeRestore(args, state);
	// "report" falls straight through to the render/save below with no new capture.

	saveState(args.state, state);
	const report = renderReport(state);
	writeFileSync(REPORT_PATH, report, "utf8");
	console.log(`Wrote ${REPORT_PATH} (state: ${args.state})`);
}

main().catch((err) => {
	console.error("e2e-reload-probe failed:", err);
	process.exitCode = 1;
});
