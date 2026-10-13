#!/usr/bin/env node
/**
 * E10's real-Obsidian probe: "the real-Obsidian test writes to a note open in Obsidian and
 * records whether a document-changing transaction without a user-event annotation is emitted."
 *
 * This is a container-run harness, not a unit test — it needs a real, running Obsidian with this
 * plugin built and enabled, a fixture note open in it, and Obsidian launched with
 * `--remote-debugging-port` so this script can attach over Chrome DevTools Protocol (CDP) and
 * spy on `EditorView.dispatch` the same way the spec's acceptance checks do ("spy on
 * EditorView.dispatch"). None of this instrumentation ships in the plugin itself (F10: no debug
 * command) — it is injected at runtime by this script, from outside the plugin, and removed when
 * the script exits.
 *
 * Usage (run inside the Obsidian desktop container, per use-desktop-container.md):
 *
 *   npm run test:e2e -- --note "<absolute path to the open fixture note on disk>" \
 *     [--cdp-port 9222] [--settle-wait-ms 3000] [--observe-ms 15000]
 *
 * What it does, in order:
 *   1. Connects to Obsidian's renderer over CDP (`http://127.0.0.1:<cdp-port>/json/list`).
 *   2. Installs a temporary spy on `EditorView.prototype.dispatch` (shared by every open editor)
 *      that records, for every dispatched transaction: whether it changed the document
 *      (`docChanged`) and whether it carried a `Transaction.userEvent` annotation (and if so,
 *      which value) — nothing else, and nothing is written back into Obsidian or the vault.
 *   3. Rewrites the note on disk from this Node process (simulating "an AI agent, another
 *      program, a git pull or a sync tool") and watches what the spy records next.
 *   4. For `--observe-ms` after that, this script also just keeps listening: while it runs, a
 *      human at the container (per the container verification steps) can fold a block by gutter
 *      click, run the fold command, and relaunch Obsidian to see its own native fold-restore —
 *      the same log captures the annotations for all three, in the same run, alongside the
 *      reload-shape result (E10's "same run" requirement).
 *   5. Writes the outcome, Obsidian's version and every annotation observed to docs/reload-shape.md.
 *
 * This script could not be executed for real while building this PR (no Obsidian desktop
 * container available in this environment) — see docs/reload-shape.md, which is a placeholder
 * until someone with container access runs this and commits the real result.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(ROOT, "docs", "reload-shape.md");

function parseArgs(argv) {
	const args = { cdpPort: 9222, settleWaitMs: 3000, observeMs: 15000 };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--note") args.note = argv[++i];
		else if (arg === "--cdp-port") args.cdpPort = Number(argv[++i]);
		else if (arg === "--settle-wait-ms") args.settleWaitMs = Number(argv[++i]);
		else if (arg === "--observe-ms") args.observeMs = Number(argv[++i]);
		else if (arg === "--help" || arg === "-h") args.help = true;
	}
	return args;
}

function printUsage() {
	console.log(
		[
			"Usage: npm run test:e2e -- --note <path to the open fixture note> [--cdp-port 9222]",
			"                            [--settle-wait-ms 3000] [--observe-ms 15000]",
			"",
			"Requires a real Obsidian, launched with --remote-debugging-port=<cdp-port>, with this",
			"plugin built+enabled and --note already open in an editor. See the file comment in",
			"this script and docs/reload-shape.md for what it records and where.",
		].join("\n")
	);
}

async function findDebuggableTarget(cdpPort) {
	const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
	if (!res.ok) throw new Error(`CDP target list request failed: HTTP ${res.status}`);
	const targets = await res.json();
	// Obsidian's main window is a "page" target; pick the first one that has a websocket URL.
	const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
	if (!target) throw new Error("no debuggable Obsidian window found on that CDP port");
	return target;
}

/** Minimal CDP client: one WebSocket, JSON-RPC request/response by id, no dependency beyond the
 * `WebSocket`/`fetch` globals Node already provides. */
function connectCdp(webSocketDebuggerUrl) {
	const ws = new WebSocket(webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map();
	ws.addEventListener("message", (event) => {
		const message = JSON.parse(event.data.toString());
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(message.error.message));
			else resolve(message.result);
		}
	});
	const ready = new Promise((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", (err) => reject(err));
	});
	async function send(method, params = {}) {
		await ready;
		const id = nextId++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	}
	return { send, close: () => ws.close() };
}

/** Runs in the Obsidian renderer via Runtime.evaluate. Installs the spy exactly once (idempotent
 * if this script is run twice against the same window) and resets its log. */
const INSTALL_SPY_EXPRESSION = `
(function () {
	if (!window.__pfsProbe) {
		const { EditorView } = require("@codemirror/view");
		const { Transaction } = require("@codemirror/state");
		const original = EditorView.prototype.dispatch;
		window.__pfsProbe = { log: [], original };
		EditorView.prototype.dispatch = function (...trs) {
			for (const tr of trs) {
				try {
					window.__pfsProbe.log.push({
						t: Date.now(),
						docChanged: !!(tr && tr.docChanged),
						userEvent: tr && tr.annotation ? tr.annotation(Transaction.userEvent) ?? null : null,
					});
				} catch (err) {
					window.__pfsProbe.log.push({ t: Date.now(), error: String(err) });
				}
			}
			return original.apply(this, trs);
		};
	}
	window.__pfsProbe.log.length = 0;
	return { obsidianVersion: (window.app && window.app.appVersion) || "unknown" };
})()
`;

const READ_LOG_EXPRESSION = "JSON.stringify(window.__pfsProbe ? window.__pfsProbe.log : [])";

function externallyRewrite(notePath) {
	const before = readFileSync(notePath, "utf8");
	const rewritten = `<!-- e2e-reload-probe external write at ${new Date().toISOString()} -->\n${before}`;
	writeFileSync(notePath, rewritten, "utf8");
	return { before, after: rewritten };
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderReport({ obsidianVersion, note, log, settleWaitMs }) {
	const docChanges = log.filter((entry) => entry.docChanged);
	const noAnnotation = docChanges.filter((entry) => entry.userEvent === null || entry.userEvent === undefined);
	const outcome = noAnnotation.length > 0 ? "emitted" : "not emitted";
	const annotationsSeen = [...new Set(log.map((entry) => entry.userEvent).filter((v) => v !== null && v !== undefined))];

	return `# E10: the reload shape, proven against real Obsidian

Outcome: **${outcome}**

- Obsidian version: ${obsidianVersion}
- Note probed: \`${note}\`
- Settle wait before reading the log: ${settleWaitMs}ms
- Transactions observed (docChanged only): ${docChanges.length}
- Document-changing transactions with no \`userEvent\` annotation: ${noAnnotation.length}
- \`userEvent\` annotation values seen across the whole run: ${annotationsSeen.length ? annotationsSeen.join(", ") : "(none)"}

${
	outcome === "emitted"
		? "Obsidian's own external-reload reaction dispatches a document-changing CM6 transaction with no `userEvent` annotation, exactly as E9/E10 assumed. No vault-modify fallback (F10) is needed."
		: "No document-changing transaction without a `userEvent` annotation was observed after the external write — Obsidian appears to replace the editor state/view outright on an external reload rather than dispatching one. Per F10, this PR is flagged for a plan change (a vault-modify fallback may be required); it is not added here."
}

## Raw log

\`\`\`json
${JSON.stringify(log, null, 2)}
\`\`\`
`;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.note) {
		printUsage();
		process.exitCode = args.help ? 0 : 1;
		return;
	}

	const target = await findDebuggableTarget(args.cdpPort);
	const cdp = connectCdp(target.webSocketDebuggerUrl);
	try {
		await cdp.send("Runtime.enable");
		const installResult = await cdp.send("Runtime.evaluate", { expression: INSTALL_SPY_EXPRESSION, returnByValue: true, awaitPromise: false });
		const { obsidianVersion } = installResult.result.value;

		externallyRewrite(args.note);
		await sleep(args.settleWaitMs);

		const readResult = await cdp.send("Runtime.evaluate", { expression: READ_LOG_EXPRESSION, returnByValue: true });
		let log = JSON.parse(readResult.result.value);

		if (args.observeMs > 0) {
			console.log(`Observing for ${args.observeMs}ms — fold by gutter click, run the fold command, or relaunch Obsidian now to capture those annotations in the same run.`);
			await sleep(args.observeMs);
			const finalRead = await cdp.send("Runtime.evaluate", { expression: READ_LOG_EXPRESSION, returnByValue: true });
			log = JSON.parse(finalRead.result.value);
		}

		const report = renderReport({ obsidianVersion, note: args.note, log, settleWaitMs: args.settleWaitMs });
		writeFileSync(REPORT_PATH, report, "utf8");
		console.log(`Wrote ${REPORT_PATH}`);
	} finally {
		cdp.close();
	}
}

main().catch((err) => {
	console.error("e2e-reload-probe failed:", err);
	process.exitCode = 1;
});
