#!/usr/bin/env node
/**
 * PR-6 (ticket warkworth-21) end to end against a real, already-running Obsidian: when the source
 * note behind an embed changes, the embed's stored folds are re-matched and re-applied (G3, G4),
 * including after a quit and a `git pull` (GP4, GP6). Container-only: it needs the
 * obsidian-development-template container of `use-desktop-container.md`, this plugin built and
 * enabled, and Obsidian started with --remote-debugging-port. The tester runs it; it is not part
 * of `npm test` (the pure decisions below are, in tests/unit/embed-rematch-probe-logic.test.ts).
 *
 * Same shape as tests/e2e/relaunch.e2e.ts: Obsidian cannot be quit or relaunched from here (CDP
 * only talks to a running instance, and the binary path has no place in a public repo), so the
 * phases bracket the operator's quit and relaunch.
 *
 * It drives the REAL arrow: a trusted mouse press and release at the arrow's position
 * (`Input.dispatchMouseEvent`), never a store write and never a scripted `el.click()` (which the
 * plugin's click-only classification correctly ignores).
 *
 * Fixture vault (built by the tester; paths relative to --vault-root, override with flags):
 *   Salesforce Tech Test Rocketship Course.md   embeds ![[Competitive Coding Fundamentals#^0169a6]]
 *   Competitive Coding Fundamentals.md          the source note; "Lesson 8" carries ^0169a6
 * The source is a copy of tests/fixtures/embed-rematch/competitive-coding-fundamentals-before.md
 * (`--write-before` puts it there); --phase rewrite writes ...-after.md over it, which renames the
 * line to "Lesson 8 (revised): Collections and frequency counting".
 *
 * Phases, in order:
 *
 *   --phase before-quit     Checkpoint 1 (GP2 set-up). Open the host in Live Preview, fold Lesson 8
 *                           inside the embed with a real click, wait out the flush, assert data.json
 *                           holds exactly one embeds entry for it with Lesson 8 and nothing else, and
 *                           note the source note's own fold state (opened on its own) and the bytes
 *                           of both files. Screenshot PR-6-folded.png. Then quit Obsidian by hand if
 *                           the next step is GP6; otherwise leave it running.
 *   --phase rewrite         Writes the "after" fixture over the source on disk, byte for byte, as an
 *                           agent or `git pull` would. Pure filesystem, no CDP, so it works with
 *                           Obsidian quit (GP6, then relaunch it and open the host). With --live
 *                           (Obsidian running, host open: GP4, Checkpoint 2) it also waits out the
 *                           settle window and asserts the embed shows Lesson 8 (revised) still folded
 *                           with its sibling unfolded and the stored record refreshed.
 *                           Screenshot PR-6-gp4-after-rewrite.png.
 *   --phase after-relaunch  Checkpoints 4 and 5 (GP6, F2, F7). Reconnect with retries, open the host:
 *                           assert Lesson 8 (revised) is folded, an unfolded sibling is still
 *                           unfolded, nothing else is folded, and the embed's stored anchors and
 *                           content hash were refreshed (the re-match ran). Then assert both files
 *                           on disk are byte-identical to what the rewrite wrote, that the source
 *                           note's entry in data.json is unchanged, and that the source note opened
 *                           on its own shows the fold state it had. Screenshots PR-6-gp6-relaunch.png
 *                           and PR-6-source-own-state.png.
 *
 * Usage:
 *   node scripts/e2e-embed-rematch-probe.mjs --phase before-quit [--write-before]
 *   node scripts/e2e-embed-rematch-probe.mjs --phase rewrite [--live]
 *   node scripts/e2e-embed-rematch-probe.mjs --phase after-relaunch
 * or `npm run test:e2e:embed-rematch -- --phase before-quit`.
 *
 * Options: [--cdp-port 9222] [--docker <container>] [--vault-root /config/test-vault]
 *   [--host <vault path>] [--source <vault path>] [--before <file>] [--after <file>]
 *   [--data <path>] [--state <path>] [--screenshots screenshots] [--wait-ms 1500]
 *   [--connect-retries 30] [--connect-retry-delay-ms 2000] [--help]
 *
 * --docker bridges the container's loopback CDP port over `docker exec` (the container has no
 * Node); then --vault-root is the vault directory as this process sees it.
 *
 * Not run by the coder turn: there is no Obsidian in the coder's environment.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectCdp } from "./lib/cdp-client.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "persistent-folded-state";
const BLOCK_SUBPATH = "^0169a6";
const LESSON_8 = "Lesson 8";
const LESSON_8_RENAMED = "Lesson 8 (revised): Collections and frequency counting";
const SIBLING_ROW = "Count word frequency";
const HOST_SRC = `Competitive Coding Fundamentals#${BLOCK_SUBPATH}`;
const PHASES = ["before-quit", "rewrite", "after-relaunch"];
const EMBED = ".internal-embed.markdown-embed";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value) => JSON.stringify(value);

// --- pure decisions (unit-tested) ---------------------------------------------------------------

export function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

/** The embed shows exactly `folded` (row-text prefixes) folded and `unfolded` unfolded, nothing more. */
/**
 * @param {string} where
 * @param {{ arrows: { row: string, collapsed: boolean }[] } | undefined} embed
 * @param {{ folded: string[], unfolded?: string[] }} want
 * @returns {string[]}
 */
export function foldProblems(where, embed, { folded, unfolded }) {
	const problems = [];
	if (!embed) return [`${where}: the embed is not on the page`];
	const find = (prefix) => embed.arrows.find((a) => a.row.startsWith(prefix));
	for (const prefix of folded) {
		const arrow = find(prefix);
		if (!arrow) problems.push(`${where}: no "${prefix}" arrow in the embed`);
		else if (!arrow.collapsed) problems.push(`${where}: "${prefix}" is not folded`);
	}
	for (const prefix of unfolded ?? []) {
		const arrow = find(prefix);
		if (!arrow) problems.push(`${where}: no "${prefix}" arrow in the embed`);
		else if (arrow.collapsed) problems.push(`${where}: "${prefix}" is folded but was never folded`);
	}
	const stray = embed.arrows.filter((a) => a.collapsed && !folded.some((prefix) => a.row.startsWith(prefix)));
	if (stray.length > 0) problems.push(`${where}: folds beyond the stored set: ${stray.map((a) => a.row).join(", ")}`);
	return problems;
}

/** The embed records data.json holds for the host's embed of the source block. */
export function embedRecords(data, { host, source }) {
	return (data?.embeds ?? []).filter((e) => e.host === host && e.target === source && e.subpath === BLOCK_SUBPATH);
}

/** Lesson 8 is the only stored fold, by its text prefix (stored text is normalized: lower case). */
export function storedFoldProblems(where, records, textPrefix) {
	if (records.length !== 1) return [`${where}: expected exactly one embeds entry for the block, found ${records.length}`];
	const texts = (records[0].folds ?? []).map((f) => f.text ?? "");
	if (texts.length !== 1 || !texts[0].startsWith(textPrefix)) return [`${where}: the stored folds are ${json(texts)}, expected only "${textPrefix}..."`];
	return [];
}

/** After the re-match the record describes the new slice: new content hash, renamed anchor. */
export function refreshedRecordProblems(where, before, after) {
	const problems = storedFoldProblems(where, after, "lesson 8 (revised)");
	if (after.length === 1 && before) {
		if (after[0].contentHash === before.contentHash) problems.push(`${where}: the stored content hash did not change, so the re-match did not run (or did not refresh the record)`);
		if (json(after[0].folds) === json(before.folds)) problems.push(`${where}: the stored anchors are still the old ones`);
	}
	return problems;
}

/** The source note opened on its own shows the fold state it had (F2). The rewrite renamed the
 * line, so the rows are compared with the rename undone. */
export function sourceFoldProblems(where, before, after) {
	const undo = (row) => row.replace("Lesson 8 (revised):", "Lesson 8:");
	const was = [...before].sort();
	const now = after.map(undo).sort();
	return json(was) === json(now) ? [] : [`${where}: the source note's own folds were ${json(was)}, now ${json(now)}`];
}

/** Writes `afterText` over `sourcePath` byte for byte. Returns what to check later. */
export function rewriteSource(sourcePath, afterText) {
	writeFileSync(sourcePath, afterText, "utf8");
	return { sourcePath, sourceSha: sha256(afterText), bytes: Buffer.byteLength(afterText, "utf8") };
}

export function parseArgs(argv) {
	let vaultRoot = "/config/test-vault";
	const args = {
		cdpPort: 9222,
		docker: null,
		host: "Salesforce Tech Test Rocketship Course.md",
		source: "Competitive Coding Fundamentals.md",
		before: join(ROOT, "tests", "fixtures", "embed-rematch", "competitive-coding-fundamentals-before.md"),
		after: join(ROOT, "tests", "fixtures", "embed-rematch", "competitive-coding-fundamentals-after.md"),
		data: "",
		state: join(tmpdir(), "pfs-e2e-embed-rematch-state.json"),
		screenshots: "screenshots",
		waitMs: 1500,
		connectRetries: 30,
		connectRetryDelayMs: 2000,
		writeBefore: false,
		live: false,
		help: false,
	};
	let dataGiven = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i] ?? "";
		if (arg === "--phase") args.phase = next();
		else if (arg === "--cdp-port") args.cdpPort = Number(next());
		else if (arg === "--docker") args.docker = next() || null;
		else if (arg === "--vault-root") vaultRoot = next() || vaultRoot;
		else if (arg === "--host") args.host = next() || args.host;
		else if (arg === "--source") args.source = next() || args.source;
		else if (arg === "--before") args.before = next() || args.before;
		else if (arg === "--after") args.after = next() || args.after;
		else if (arg === "--data") {
			args.data = next();
			dataGiven = true;
		} else if (arg === "--state") args.state = next() || args.state;
		else if (arg === "--screenshots") args.screenshots = next() || args.screenshots;
		else if (arg === "--wait-ms") args.waitMs = Number(next());
		else if (arg === "--connect-retries") args.connectRetries = Number(next());
		else if (arg === "--connect-retry-delay-ms") args.connectRetryDelayMs = Number(next());
		else if (arg === "--write-before") args.writeBefore = true;
		else if (arg === "--live") args.live = true;
		else if (arg === "--help" || arg === "-h") args.help = true;
	}
	args.vaultRoot = vaultRoot;
	if (!dataGiven) args.data = join(vaultRoot, ".obsidian", "plugins", PLUGIN_ID, "data.json");
	return args;
}

// --- files --------------------------------------------------------------------------------------

function readData(path) {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

const vaultFile = (args, name) => join(args.vaultRoot, name);

function loadState(path) {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

const saveState = (path, state) => writeFileSync(path, JSON.stringify(state, null, 2), "utf8");

// --- page-side expressions ----------------------------------------------------------------------

/** Text nodes directly under a row: the row's own text, not its children's. */
const ROW_TEXT = `(a) => Array.from(a.parentElement.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()`;

const leavesOf = (path) => `app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file && l.view.file.path === ${JSON.stringify(path)})`;

const openExpression = (path) => `(async () => {
	const file = app.vault.getFileByPath(${JSON.stringify(path)});
	if (!file) return { ok: false, reason: "no such note: " + ${JSON.stringify(path)} };
	const existing = ${leavesOf(path)}[0];
	if (existing) { app.workspace.setActiveLeaf(existing, { focus: true }); return { ok: true, reused: true }; }
	const leaf = app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "source", source: false }, active: true });
	return { ok: true };
})()`;

const closeExpression = (path) => `(() => { let n = 0; for (const leaf of ${leavesOf(path)}) { leaf.detach(); n++; } return n; })()`;

export const readEmbedsExpression = (path) => `(() => {
	const rowText = ${ROW_TEXT};
	const leaf = ${leavesOf(path)}[0];
	if (!leaf) return JSON.stringify({ error: "no pane of " + ${JSON.stringify(path)} });
	const EMBED = ${JSON.stringify(EMBED)};
	const embeds = Array.from(leaf.view.containerEl.querySelectorAll(EMBED)).filter((e) => !e.parentElement.closest(EMBED));
	return JSON.stringify(embeds.map((embed) => ({
		src: embed.getAttribute("src"),
		arrows: Array.from(embed.querySelectorAll(".list-collapse-indicator, .heading-collapse-indicator"))
			.filter((a) => a.closest(EMBED) === embed)
			.map((a) => ({ row: rowText(a), collapsed: a.classList.contains("is-collapsed") })),
	})));
})()`;

export const arrowPointExpression = (path, src, row) => `(() => {
	const rowText = ${ROW_TEXT};
	const leaf = ${leavesOf(path)}[0];
	if (!leaf) return null;
	const EMBED = ${JSON.stringify(EMBED)};
	const embed = Array.from(leaf.view.containerEl.querySelectorAll(EMBED)).find((e) => e.getAttribute("src") === ${JSON.stringify(src)});
	if (!embed) return null;
	const arrow = Array.from(embed.querySelectorAll(".list-collapse-indicator, .heading-collapse-indicator")).find((a) => rowText(a).startsWith(${JSON.stringify(row)}));
	if (!arrow) return null;
	arrow.scrollIntoView({ block: "center" });
	const r = arrow.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

/** The source note opened on its own: the lines whose fold indicator is collapsed. */
const sourceFoldsExpression = (path) => `(() => {
	const leaf = ${leavesOf(path)}[0];
	if (!leaf) return JSON.stringify({ error: "no pane of " + ${JSON.stringify(path)} });
	const lines = Array.from(leaf.view.containerEl.querySelectorAll(".cm-line")).filter((el) => el.querySelector(".cm-fold-indicator .collapse-indicator.is-collapsed"));
	return JSON.stringify(lines.map((el) => (el.textContent || "").replace(/\\u2026$/, "").replace(/\\s*\\^[A-Za-z0-9-]+$/, "").trim()));
})()`;

// --- CDP helpers --------------------------------------------------------------------------------

async function connect(args, retries = 1) {
	let last;
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			return await connectCdp({ cdpPort: args.cdpPort, docker: args.docker });
		} catch (err) {
			last = err;
			if (attempt < retries - 1) await sleep(args.connectRetryDelayMs);
		}
	}
	throw new Error(`no debuggable Obsidian window on port ${args.cdpPort} after ${retries} attempt(s): ${String(last)}`);
}

async function withConnection(args, fn, retries = 1) {
	const cdp = await connect(args, retries);
	try {
		return await fn(cdp);
	} finally {
		cdp.close();
	}
}

async function openNote(cdp, path) {
	const opened = await cdp.evaluate(openExpression(path));
	if (!opened.ok) throw new Error(opened.reason);
}

async function readEmbeds(cdp, path) {
	const parsed = JSON.parse(await cdp.evaluate(readEmbedsExpression(path)));
	if (!Array.isArray(parsed)) throw new Error(parsed.error);
	return parsed;
}

/** Waits for the embed to render with arrows, then for the restore window, pass and re-check. */
async function waitForEmbed(cdp, path, src, waitMs) {
	const deadline = Date.now() + 20000;
	for (;;) {
		try {
			const hit = (await readEmbeds(cdp, path)).find((e) => e.src === src && e.arrows.length > 0);
			if (hit) {
				await sleep(waitMs);
				return (await readEmbeds(cdp, path)).find((e) => e.src === src) ?? hit;
			}
		} catch {
			// the pane is not there yet
		}
		if (Date.now() > deadline) throw new Error(`embed ${src} never rendered with arrows in ${path}`);
		await sleep(250);
	}
}

/** A real mouse press and release at the arrow, as a person makes it: trusted events. */
async function realClickArrow(cdp, path, src, row) {
	const first = await cdp.evaluate(arrowPointExpression(path, src, row));
	if (!first) throw new Error(`no arrow "${row}" in embed ${src} of ${path}`);
	await sleep(300); // after scrollIntoView
	const point = (await cdp.evaluate(arrowPointExpression(path, src, row))) ?? first;
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
	await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function screenshot(cdp, args, name) {
	if (!existsSync(args.screenshots)) mkdirSync(args.screenshots, { recursive: true });
	const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
	const file = join(args.screenshots, name);
	writeFileSync(file, Buffer.from(shot.data, "base64"));
	return file;
}

/** The source note opened on its own: which lines it shows folded. Closes the tab again. */
async function readSourceOwnFolds(cdp, args, shotName) {
	await openNote(cdp, args.source);
	await sleep(args.waitMs);
	const parsed = JSON.parse(await cdp.evaluate(sourceFoldsExpression(args.source)));
	if (!Array.isArray(parsed)) throw new Error(parsed.error);
	const shot = shotName ? await screenshot(cdp, args, shotName) : "";
	await cdp.evaluate(closeExpression(args.source));
	await sleep(300);
	return { rows: parsed, shot };
}

function report(phase, problems, extra = []) {
	for (const line of extra) console.log(`  ${line}`);
	if (problems.length === 0) console.log(`PASS ${phase}`);
	else {
		console.log(`FAIL ${phase}`);
		for (const problem of problems) console.log(`  - ${problem}`);
		process.exitCode = 1;
	}
}

// --- phases -------------------------------------------------------------------------------------

async function phaseBeforeQuit(args, state) {
	const problems = [];
	const extra = [];
	if (args.writeBefore) writeFileSync(vaultFile(args, args.source), readFileSync(args.before, "utf8"), "utf8");
	await withConnection(args, async (cdp) => {
		// The source note on its own first: opening it may give it its own entry, which is then the
		// baseline the embed's fold must leave alone (F2).
		const own = await readSourceOwnFolds(cdp, args, null);
		await sleep(args.waitMs);
		const sourceEntryBefore = json(readData(args.data).files?.[args.source] ?? null);

		await openNote(cdp, args.host);
		const before = await waitForEmbed(cdp, args.host, HOST_SRC, args.waitMs);
		if (before.arrows.some((a) => a.collapsed)) problems.push(`the embed already shows folds before the click (${before.arrows.filter((a) => a.collapsed).map((a) => a.row).join(", ")}): clear data.json's embeds and Obsidian's own fold memory first`);

		await realClickArrow(cdp, args.host, HOST_SRC, LESSON_8);
		await sleep(args.waitMs);
		const after = (await readEmbeds(cdp, args.host)).find((e) => e.src === HOST_SRC);
		problems.push(...foldProblems("after the click", after, { folded: [LESSON_8], unfolded: [SIBLING_ROW] }));
		extra.push(`screenshot: ${await screenshot(cdp, args, "PR-6-folded.png")}`);

		const data = readData(args.data);
		const records = embedRecords(data, args);
		problems.push(...storedFoldProblems("data.json after the click", records, "lesson 8"));
		if (json(data.files?.[args.source] ?? null) !== sourceEntryBefore) problems.push("the source note's own stored entry changed when folding in the embed (F2)");

		state.beforeQuit = {
			record: records[0] ?? null,
			sourceEntry: sourceEntryBefore,
			sourceOwnFolds: own.rows,
			hostSha: sha256(readFileSync(vaultFile(args, args.host), "utf8")),
			sourceSha: sha256(readFileSync(vaultFile(args, args.source), "utf8")),
		};
	});
	report("before-quit (Checkpoint 1: Lesson 8 folded in the embed by a real click, and stored)", problems, extra);
	if (problems.length === 0) console.log("  next: --phase rewrite --live (GP4), or quit Obsidian, then --phase rewrite (GP6)");
}

async function phaseRewrite(args, state) {
	const problems = [];
	const extra = [];
	const afterText = readFileSync(args.after, "utf8");
	const written = rewriteSource(vaultFile(args, args.source), afterText);
	state.rewrite = { ...written, hostSha: sha256(readFileSync(vaultFile(args, args.host), "utf8")), live: args.live, at: new Date().toISOString() };
	extra.push(`wrote ${written.bytes} bytes to ${written.sourcePath}`);
	if (args.live) {
		await withConnection(args, async (cdp) => {
			// Past the plugin's 150 ms render window, the pass and the 400 ms re-check.
			await sleep(Math.max(args.waitMs, 1500));
			const embed = await waitForEmbed(cdp, args.host, HOST_SRC, args.waitMs);
			problems.push(...foldProblems("after the rewrite", embed, { folded: [LESSON_8_RENAMED], unfolded: [SIBLING_ROW] }));
			extra.push(`screenshot: ${await screenshot(cdp, args, "PR-6-gp4-after-rewrite.png")}`);
			await sleep(args.waitMs); // the store flushes on its own 150 ms timer
			problems.push(...refreshedRecordProblems("data.json after the rewrite", state.beforeQuit?.record ?? null, embedRecords(readData(args.data), args)));
			if (sha256(readFileSync(vaultFile(args, args.source), "utf8")) !== written.sourceSha) problems.push("the source file on disk is no longer what the rewrite wrote (F7)");
			if (sha256(readFileSync(vaultFile(args, args.host), "utf8")) !== state.rewrite.hostSha) problems.push("the host file on disk changed (F7)");
		});
	} else {
		extra.push("filesystem only: relaunch Obsidian, open the host, then --phase after-relaunch");
	}
	report(args.live ? "rewrite --live (Checkpoint 2, GP4: Lesson 8 still folded after the source was rewritten)" : "rewrite (GP6: source rewritten while Obsidian is quit)", problems, extra);
}

async function phaseAfterRelaunch(args, state) {
	const problems = [];
	const extra = [];
	if (!state.beforeQuit || !state.rewrite) problems.push("no saved state from --phase before-quit and --phase rewrite: run them first (same --state file)");
	await withConnection(
		args,
		async (cdp) => {
			await sleep(args.waitMs);
			await openNote(cdp, args.host);
			const embed = await waitForEmbed(cdp, args.host, HOST_SRC, args.waitMs);
			problems.push(...foldProblems("after the relaunch", embed, { folded: [LESSON_8_RENAMED], unfolded: [SIBLING_ROW] }));
			extra.push(`screenshot: ${await screenshot(cdp, args, "PR-6-gp6-relaunch.png")}`);
			await sleep(args.waitMs); // the refreshed record is flushed by the store's own timer

			problems.push(...refreshedRecordProblems("data.json after the relaunch", state.beforeQuit?.record ?? null, embedRecords(readData(args.data), args)));

			// Checkpoint 5: F7, both files are exactly what was written; F2, the source's own state is
			// unchanged (read before the source note is opened, which may legitimately refresh it).
			const hostSha = sha256(readFileSync(vaultFile(args, args.host), "utf8"));
			const sourceSha = sha256(readFileSync(vaultFile(args, args.source), "utf8"));
			if (sourceSha !== state.rewrite?.sourceSha) problems.push("the source file on disk is not byte-identical to what the rewrite wrote (F7)");
			if (hostSha !== state.rewrite?.hostSha) problems.push("the host file on disk is not byte-identical to what it was at the rewrite (F7)");
			if (json(readData(args.data).files?.[args.source] ?? null) !== state.beforeQuit?.sourceEntry) problems.push("the source note's own entry in data.json changed (F2)");
			const own = await readSourceOwnFolds(cdp, args, "PR-6-source-own-state.png");
			problems.push(...sourceFoldProblems("the source note opened on its own", state.beforeQuit?.sourceOwnFolds ?? [], own.rows));
			extra.push(`source note's own folds: ${json(own.rows)}; screenshot: ${own.shot}`);
		},
		args.connectRetries,
	);
	report("after-relaunch (Checkpoints 4 and 5, GP6, F2, F7)", problems, extra);
}

function printUsage() {
	console.log(
		[
			`Usage: node scripts/e2e-embed-rematch-probe.mjs --phase <${PHASES.join("|")}> [options]`,
			"",
			"PR-6 end to end: fold Lesson 8 inside the Rocketship embed with a real click, rewrite the source",
			"on disk (live, GP4, or while Obsidian is quit, GP6), and check the fold is still on Lesson 8.",
			"",
			"  --phase before-quit [--write-before]   fold Lesson 8 in the embed; note data.json and file bytes",
			"  --phase rewrite [--live]               write the 'after' fixture over the source (--live: check GP4)",
			"  --phase after-relaunch                 after quit + relaunch: check GP6, F2 and F7",
			"",
			"Options: [--cdp-port 9222] [--docker <container>] [--vault-root /config/test-vault] [--host <path>]",
			"         [--source <path>] [--before <file>] [--after <file>] [--data <path>] [--state <path>]",
			"         [--screenshots screenshots] [--wait-ms 1500] [--connect-retries 30] [--connect-retry-delay-ms 2000]",
		].join("\n"),
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !PHASES.includes(args.phase)) {
		printUsage();
		process.exitCode = args.help ? 0 : 1;
		return;
	}
	const state = loadState(args.state);
	if (args.phase === "before-quit") await phaseBeforeQuit(args, state);
	else if (args.phase === "rewrite") await phaseRewrite(args, state);
	else await phaseAfterRelaunch(args, state);
	saveState(args.state, state);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error("e2e-embed-rematch-probe failed:", err);
		process.exitCode = 1;
	});
}
