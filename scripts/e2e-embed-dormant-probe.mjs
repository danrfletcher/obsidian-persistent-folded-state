#!/usr/bin/env node
/**
 * PR-7 (ticket warkworth-21) end to end against a real, already-running Obsidian: an embed's stored
 * folds go dormant for 10 minutes when its link is retargeted (G6) or its target block disappears
 * (E6), come back when the link or block comes back inside the window, and are forgotten after it.
 * Container-only: it needs the obsidian-development-template container of `use-desktop-container.md`,
 * this plugin built and enabled, and Obsidian started with --remote-debugging-port. The tester runs
 * it; it is not part of `npm test` (the pure decisions below are, in
 * tests/unit/embed-dormant-probe-logic.test.ts).
 *
 * Same CDP and data.json plumbing as scripts/e2e-dormant-baseline-probe.mjs: the page is driven over
 * CDP (scripts/lib/cdp-client.mjs), the host and source notes are rewritten on disk the way an agent
 * or `git pull` would, the plugin is turned off and on through `app.plugins`, and to avoid a real
 * 10-minute wait `dormantSince` is backdated in data.json while the plugin is disabled (the
 * container-verification script's own documented shortcut). A "relaunch" is therefore a disable and
 * re-enable of the plugin, which runs the same load-time expiry; no hand-quit is needed.
 *
 * It drives the REAL arrow: a trusted mouse press and release at the arrow's position
 * (`Input.dispatchMouseEvent`), never a store write and never a scripted `el.click()` (which the
 * plugin's click-only classification correctly ignores).
 *
 * Fixture vault (built by --phase seed; paths relative to --vault-root, override with flags):
 *   Salesforce Tech Test Rocketship Course.md   tests/fixtures/embed-dormant/host.md
 *                                               embeds ![[Competitive Coding Fundamentals#^0169a6]]
 *   Competitive Coding Fundamentals.md          tests/fixtures/embed-rematch/...-before.md
 *                                               (Lesson 7 ^aaa111, Lesson 8 ^0169a6, Lesson 9 ^bbb222)
 * Retargeting writes tests/fixtures/embed-dormant/host-retargeted.md (the link now names ^bbb222);
 * breaking writes tests/fixtures/embed-dormant/source-broken.md (Lesson 8 without its ^0169a6).
 *
 * Phases (each one prints PASS or FAIL with every problem, and takes a screenshot):
 *
 *   --phase seed         Writes the host and source fixtures, drops this host's `embeds` entries from
 *                        data.json (plugin disabled for the edit) and re-enables the plugin.
 *   --phase s1-fold      S1: opens the host, folds Lesson 8 inside the embed with a real click, waits
 *                        out the flush; data.json holds one embed record with Lesson 8 only and no
 *                        dormantSince. Notes the `files` section as the baseline for every later step.
 *   --phase s2-retarget  S2: rewrites the host so the link names another block. The new embed is fully
 *                        expanded and gets no record (E12); the old record is kept, dormant, folds
 *                        untouched.
 *   --phase s3-revert    S3: rewrites the host back inside the window. Lesson 8 is folded again and the
 *                        record is live (no dormantSince).
 *   --phase s4-expire    S4: retargets again, backdates dormantSince by 11 minutes while the plugin is
 *                        disabled, re-enables it, reverts the link: the embed is expanded and data.json
 *                        holds no entry for the old key.
 *   --phase s5-break     S5: folds Lesson 8 again, removes the block id from the source on disk (its
 *                        pane closed first): nothing is applied, the record is dormant, the embed
 *                        shows what Obsidian shows for a missing block (printed, and in the
 *                        screenshot). Restores the id inside the window and opens the host again
 *                        (Obsidian leaves the "Unable to find" embed as it is until it renders
 *                        again, and E6 restores "when the embed next renders"): folded again.
 *   --phase all          seed, S1 to S5 in Live Preview, then seed and S1 to S3 again in Reading view
 *                        (S6: the same results, one state shared by both modes, G9). The default.
 *
 * After every step data.json keeps version 1 and the `files` section it had at S1, and the host and
 * source on disk are byte-for-byte what this script last wrote (F7).
 *
 * Usage:
 *   node scripts/e2e-embed-dormant-probe.mjs [--phase <name>] [--view live-preview|reading]
 * or `npm run test:e2e:embed-dormant -- --phase s2-retarget`.
 *
 * Options: [--cdp-port 9222] [--docker <container>] [--vault-root /config/test-vault]
 *   [--host <vault path>] [--source <vault path>] [--data <path>] [--state <path>]
 *   [--screenshots screenshots] [--wait-ms 1500] [--help]
 *
 * --docker bridges the container's loopback CDP port over `docker exec` (the container has no
 * Node); then --vault-root is the vault directory as this process sees it. Individual phases keep
 * their notes in --state, so they can be run one at a time, in order.
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
const BLOCK = "^0169a6";
const RETARGET_BLOCK = "^bbb222";
const SOURCE_NAME = "Competitive Coding Fundamentals";
const HOST_SRC = `${SOURCE_NAME}#${BLOCK}`;
const RETARGET_SRC = `${SOURCE_NAME}#${RETARGET_BLOCK}`;
const LESSON_8 = "Lesson 8";
const SIBLING_ROW = "Count word frequency";
const LESSON_9 = "Lesson 9";
const MAX_DORMANT_AGE_MS = 600_000; // src/dormant.ts's own value, a literal so this stays a plain Node file
const BACKDATE_MS = 11 * 60 * 1000;
const EMBED = ".internal-embed.markdown-embed";
const STEPS = ["s1-fold", "s2-retarget", "s3-revert", "s4-expire", "s5-break"];
const PHASES = ["all", "seed", ...STEPS];
const VIEWS = ["live-preview", "reading"];

const FIXTURES = join(ROOT, "tests", "fixtures");
const HOST_FIXTURE = join(FIXTURES, "embed-dormant", "host.md");
const RETARGETED_FIXTURE = join(FIXTURES, "embed-dormant", "host-retargeted.md");
const SOURCE_FIXTURE = join(FIXTURES, "embed-rematch", "competitive-coding-fundamentals-before.md");
const BROKEN_FIXTURE = join(FIXTURES, "embed-dormant", "source-broken.md");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (value) => JSON.stringify(value);

// --- pure decisions (unit-tested) ---------------------------------------------------------------

export function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * The embed shows exactly `folded` (row-text prefixes) folded and `unfolded` unfolded, nothing more.
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
	if (stray.length > 0) problems.push(`${where}: folds beyond the expected set: ${stray.map((a) => a.row).join(", ")}`);
	return problems;
}

/** The embed records data.json holds for the host's embed of `block` in the source note. */
export function embedRecords(data, { host, source }, block = BLOCK) {
	return (data?.embeds ?? []).filter((e) => e.host === host && e.target === source && e.subpath === block);
}

/** The stored fold texts of a record (stored text is normalized: lower case). */
const foldTexts = (record) => (record.folds ?? []).map((f) => f.text ?? "");

/**
 * One record, holding only Lesson 8 as a fold, with no whole-embed dormant stamp.
 * @param {string} where
 * @param {any[]} records
 * @param {any} [want] the record as it was, when it must be unchanged
 * @returns {string[]}
 */
export function liveRecordProblems(where, records, want = undefined) {
	if (records.length !== 1) return [`${where}: expected exactly one embeds entry for the block, found ${records.length}`];
	const [record] = records;
	const problems = [];
	const texts = foldTexts(record);
	if (texts.length !== 1 || !texts[0].startsWith("lesson 8")) problems.push(`${where}: the stored folds are ${json(texts)}, expected only "lesson 8..."`);
	if (record.dormantSince !== undefined) problems.push(`${where}: the record is dormant (dormantSince ${record.dormantSince}) but its embed is live`);
	if (want && json(record.folds) !== json(want.folds)) problems.push(`${where}: the stored folds changed: ${json(record.folds)}, was ${json(want.folds)}`);
	if (want && record.contentHash !== want.contentHash) problems.push(`${where}: the stored content hash changed`);
	return problems;
}

/**
 * One record that is dormant: stamped inside [since, now], and otherwise exactly as it was
 * (folds, per-anchor dormant list and content hash untouched while dormant).
 */
export function dormantRecordProblems(where, records, want, { since, now }) {
	if (records.length !== 1) return [`${where}: expected the old embed's record to be kept, found ${records.length} entries`];
	const [record] = records;
	const problems = [];
	if (typeof record.dormantSince !== "number" || !Number.isFinite(record.dormantSince)) {
		problems.push(`${where}: the record has no numeric dormantSince, so it is not dormant`);
	} else if (record.dormantSince < since || record.dormantSince > now) {
		problems.push(`${where}: dormantSince ${record.dormantSince} is outside the time of the step (${since} to ${now})`);
	}
	if (json(record.folds) !== json(want.folds)) problems.push(`${where}: the dormant record's folds changed: ${json(record.folds)}, was ${json(want.folds)}`);
	if (json(record.dormant) !== json(want.dormant)) problems.push(`${where}: the dormant record's per-anchor dormant list changed`);
	if (record.contentHash !== want.contentHash) problems.push(`${where}: the dormant record's content hash changed`);
	return problems;
}

/** No record at all: forgotten, or never made (E12). */
export function noRecordProblems(where, records) {
	return records.length === 0 ? [] : [`${where}: expected no embeds entry, found ${records.length} (dormantSince ${json(records.map((r) => r.dormantSince ?? null))})`];
}

/** data.json keeps version 1 and the `files` section it had at the baseline (S1). */
export function dataShapeProblems(where, data, filesBaseline) {
	const problems = [];
	if (data?.version !== 1) problems.push(`${where}: data.json version is ${json(data?.version)}, expected 1`);
	if (filesBaseline === undefined) problems.push(`${where}: no files baseline: run --phase s1-fold first (same --state file)`);
	else if (json(data?.files ?? null) !== filesBaseline) problems.push(`${where}: the files section of data.json changed`);
	return problems;
}

/**
 * `data` with the dormantSince of the host's embed record for `block` moved to `ageMs` before
 * `now`. Returns the new data and the value written; throws when there is no such record.
 */
export function backdateDormantSince(data, ids, now, ageMs, block = BLOCK) {
	const records = embedRecords(data, ids, block);
	if (records.length !== 1) throw new Error(`cannot backdate: expected one embeds entry, found ${records.length}`);
	const since = now - ageMs;
	const embeds = data.embeds.map((e) => (e === records[0] ? { ...e, dormantSince: since } : e));
	return { data: { ...data, embeds }, since };
}

/** `data` without any embed record owned by `host` (the seed step). */
export function withoutHostEmbeds(data, host) {
	if (!data || typeof data !== "object") return data;
	if (!Array.isArray(data.embeds)) return data;
	const embeds = data.embeds.filter((e) => e.host !== host);
	const { embeds: _old, ...rest } = data;
	return embeds.length > 0 ? { ...rest, embeds } : rest;
}

/** The steps a phase runs, with the view each runs in. */
export function plan(phase, view) {
	if (phase === "all") {
		return [
			...["seed", ...STEPS].map((step) => ({ step, view: "live-preview" })),
			...["seed", "s1-fold", "s2-retarget", "s3-revert"].map((step) => ({ step, view: "reading" })),
		];
	}
	return [{ step: phase, view }];
}

/** Screenshot file name: Live Preview steps are S1 to S5, Reading view repeats S1 to S3 as S6. */
export function screenshotName(step, view, label) {
	const n = STEPS.indexOf(step) + 1;
	return view === "reading" ? `PR-7-S6-reading-S${n}-${label}.png` : `PR-7-S${n}-${label}.png`;
}

export function parseArgs(argv) {
	let vaultRoot = "/config/test-vault";
	const args = {
		cdpPort: 9222,
		docker: null,
		phase: "all",
		view: "live-preview",
		host: "Salesforce Tech Test Rocketship Course.md",
		source: `${SOURCE_NAME}.md`,
		data: "",
		state: join(tmpdir(), "pfs-e2e-embed-dormant-state.json"),
		screenshots: "screenshots",
		waitMs: 1500,
		help: false,
	};
	let dataGiven = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => argv[++i] ?? "";
		if (arg === "--phase") args.phase = next();
		else if (arg === "--view") args.view = next();
		else if (arg === "--cdp-port") args.cdpPort = Number(next());
		else if (arg === "--docker") args.docker = next() || null;
		else if (arg === "--vault-root") vaultRoot = next() || vaultRoot;
		else if (arg === "--host") args.host = next() || args.host;
		else if (arg === "--source") args.source = next() || args.source;
		else if (arg === "--data") {
			args.data = next();
			dataGiven = true;
		} else if (arg === "--state") args.state = next() || args.state;
		else if (arg === "--screenshots") args.screenshots = next() || args.screenshots;
		else if (arg === "--wait-ms") args.waitMs = Number(next());
		else if (arg === "--help" || arg === "-h") args.help = true;
	}
	args.vaultRoot = vaultRoot;
	if (!dataGiven) args.data = join(vaultRoot, ".obsidian", "plugins", PLUGIN_ID, "data.json");
	return args;
}

// --- files --------------------------------------------------------------------------------------

function readJson(path) {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

const writeData = (path, data) => writeFileSync(path, JSON.stringify(data, null, "\t"), "utf8");
const vaultFile = (args, name) => join(args.vaultRoot, name);
const readVault = (args, name) => readFileSync(vaultFile(args, name), "utf8");

/** Writes a note on disk and remembers its hash: the plugin must never change it afterwards (F7). */
function writeNote(args, state, name, text) {
	writeFileSync(vaultFile(args, name), text, "utf8");
	state.written = { ...(state.written ?? {}), [name]: sha256(text) };
}

function untouchedProblems(where, args, state) {
	const problems = [];
	for (const [name, sha] of Object.entries(state.written ?? {})) {
		if (!existsSync(vaultFile(args, name))) problems.push(`${where}: ${name} is gone from disk (F7)`);
		else if (sha256(readVault(args, name)) !== sha) problems.push(`${where}: ${name} on disk is not what the probe wrote (F7)`);
	}
	return problems;
}

// --- page-side expressions ----------------------------------------------------------------------

/** Text nodes directly under a row: the row's own text, not its children's. */
const ROW_TEXT = `(a) => Array.from(a.parentElement.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()`;

const leavesOf = (path) => `app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file && l.view.file.path === ${JSON.stringify(path)})`;

/** A MarkdownView keeps both surfaces in the DOM and hides the inactive one: only the shown one counts. */
const SURFACE = `(leaf) => leaf.view.containerEl.querySelector(leaf.view.getMode() === "preview" ? ".markdown-reading-view" : ".markdown-source-view") || leaf.view.containerEl`;

export const openExpression = (path, view) => `(async () => {
	const file = app.vault.getFileByPath(${JSON.stringify(path)});
	if (!file) return { ok: false, reason: "no such note: " + ${JSON.stringify(path)} };
	const leaf = app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: ${JSON.stringify(view === "reading" ? "preview" : "source")}, source: false }, active: true });
	return { ok: true, mode: leaf.view.getMode() };
})()`;

export const closeExpression = (path) => `(() => { let n = 0; for (const leaf of ${leavesOf(path)}) { leaf.detach(); n++; } return n; })()`;

export const readEmbedsExpression = (path) => `(() => {
	const rowText = ${ROW_TEXT};
	const surface = ${SURFACE};
	const leaf = ${leavesOf(path)}[0];
	if (!leaf) return JSON.stringify({ error: "no pane of " + ${JSON.stringify(path)} });
	const EMBED = ${JSON.stringify(EMBED)};
	const embeds = Array.from(surface(leaf).querySelectorAll(EMBED)).filter((e) => !e.parentElement.closest(EMBED));
	return JSON.stringify(embeds.map((embed) => ({
		src: embed.getAttribute("src"),
		text: (embed.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200),
		arrows: Array.from(embed.querySelectorAll(".list-collapse-indicator, .heading-collapse-indicator"))
			.filter((a) => a.closest(EMBED) === embed)
			.map((a) => ({ row: rowText(a), collapsed: a.classList.contains("is-collapsed") })),
	})));
})()`;

export const arrowPointExpression = (path, src, row) => `(() => {
	const rowText = ${ROW_TEXT};
	const surface = ${SURFACE};
	const leaf = ${leavesOf(path)}[0];
	if (!leaf) return null;
	const EMBED = ${JSON.stringify(EMBED)};
	const embed = Array.from(surface(leaf).querySelectorAll(EMBED)).find((e) => e.getAttribute("src") === ${JSON.stringify(src)});
	if (!embed) return null;
	const arrow = Array.from(embed.querySelectorAll(".list-collapse-indicator, .heading-collapse-indicator")).find((a) => rowText(a).startsWith(${JSON.stringify(row)}));
	if (!arrow) return null;
	arrow.scrollIntoView({ block: "center" });
	const r = arrow.getBoundingClientRect();
	const cx = r.left + r.width / 2;
	const cy = r.top + r.height / 2;
	// On a task row the arrow's box (42 px wide in Obsidian 1.14) is partly covered by the task's
	// checkbox, and the centre of that box is the checkbox: a click there toggles the task in the
	// source note and never reaches the arrow. A person clicks the visible triangle, so the point
	// is the one nearest the centre where the topmost element is the arrow itself (or its icon).
	if (typeof document.elementFromPoint !== "function") return { x: cx, y: cy };
	const hitsArrow = (x, y) => { const top = document.elementFromPoint(x, y); return !!top && top.closest(".list-collapse-indicator, .heading-collapse-indicator") === arrow; };
	for (let dx = 0; dx <= r.width / 2; dx += 2) {
		for (const dy of [0, -6, 6]) {
			for (const x of dx === 0 ? [cx] : [cx - dx, cx + dx]) {
				if (hitsArrow(x, cy + dy)) return { x, y: cy + dy };
			}
		}
	}
	const top = document.elementFromPoint(cx, cy);
	return { blockedBy: top ? top.tagName.toLowerCase() + "." + String(top.getAttribute("class") || "") : "nothing" };
})()`;

const setPluginExpression = (enable) => `(async () => { await app.plugins.${enable ? "enablePlugin" : "disablePlugin"}(${JSON.stringify(PLUGIN_ID)}); return true; })()`;

// --- CDP helpers --------------------------------------------------------------------------------

async function withConnection(args, fn) {
	const cdp = await connectCdp({ cdpPort: args.cdpPort, docker: args.docker });
	try {
		return await fn(cdp);
	} finally {
		cdp.close();
	}
}

const settleMs = (args) => Math.max(args.waitMs, 1500); // past the 150 ms render window, the pass and the flush

async function openHost(cdp, args, view) {
	await cdp.evaluate(closeExpression(args.host));
	await sleep(300);
	const opened = await cdp.evaluate(openExpression(args.host, view));
	if (!opened.ok) throw new Error(opened.reason);
}

async function readEmbeds(cdp, path) {
	const parsed = JSON.parse(await cdp.evaluate(readEmbedsExpression(path)));
	if (!Array.isArray(parsed)) throw new Error(parsed.error);
	return parsed;
}

/** Waits for the embed with `src` to render with arrows, then for the restore window, pass and re-check. */
async function waitForEmbed(cdp, args, src) {
	const deadline = Date.now() + 20000;
	for (;;) {
		try {
			const hit = (await readEmbeds(cdp, args.host)).find((e) => e.src === src && e.arrows.length > 0);
			if (hit) {
				await sleep(settleMs(args));
				return (await readEmbeds(cdp, args.host)).find((e) => e.src === src) ?? hit;
			}
		} catch {
			// the pane is not there yet
		}
		if (Date.now() > deadline) throw new Error(`embed ${src} never rendered with arrows in ${args.host}`);
		await sleep(250);
	}
}

/** For a broken embed, which has no arrows to wait for: waits out the window, then reads. */
async function settledEmbed(cdp, args, src) {
	await sleep(settleMs(args));
	return (await readEmbeds(cdp, args.host)).find((e) => e.src === src);
}

/** A real mouse press and release at the arrow, as a person makes it: trusted events. */
async function realClickArrow(cdp, args, src, row) {
	const first = await cdp.evaluate(arrowPointExpression(args.host, src, row));
	if (!first) throw new Error(`no arrow "${row}" in embed ${src} of ${args.host}`);
	await sleep(300); // after scrollIntoView
	const point = (await cdp.evaluate(arrowPointExpression(args.host, src, row))) ?? first;
	if (point.blockedBy) throw new Error(`no point of the arrow "${row}" in embed ${src} is clickable: ${point.blockedBy} covers it`);
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

async function setPlugin(cdp, enable) {
	await cdp.evaluate(setPluginExpression(enable));
}

function report(label, problems, extra = []) {
	for (const line of extra) console.log(`  ${line}`);
	if (problems.length === 0) console.log(`PASS ${label}`);
	else {
		console.log(`FAIL ${label}`);
		for (const problem of problems) console.log(`  - ${problem}`);
		process.exitCode = 1;
	}
}

const ids = (args) => ({ host: args.host, source: args.source });
const recordsOf = (args, block = BLOCK) => embedRecords(readJson(args.data), ids(args), block);

/** After every step: version 1, the same `files` section, and the notes on disk untouched. */
function everyStepProblems(where, args, state) {
	return [...dataShapeProblems(where, readJson(args.data), state.filesBaseline), ...untouchedProblems(where, args, state)];
}

// --- phases -------------------------------------------------------------------------------------

async function stepSeed(cdp, args, state, view) {
	writeNote(args, state, args.source, readFileSync(SOURCE_FIXTURE, "utf8"));
	writeNote(args, state, args.host, readFileSync(HOST_FIXTURE, "utf8"));
	await cdp.evaluate(closeExpression(args.host));
	await setPlugin(cdp, false);
	await sleep(500);
	if (existsSync(args.data)) writeData(args.data, withoutHostEmbeds(readJson(args.data), args.host));
	await setPlugin(cdp, true);
	await sleep(args.waitMs);
	delete state.filesBaseline;
	delete state.record;
	const left = recordsOf(args).length;
	report(`seed (${view}: fixtures written, no embeds entry for the host)`, left === 0 ? [] : [`data.json still holds ${left} embeds entries for the block`]);
}

async function stepFold(cdp, args, state, view) {
	const problems = [];
	const extra = [];
	await openHost(cdp, args, view);
	const before = await waitForEmbed(cdp, args, HOST_SRC);
	if (before.arrows.some((a) => a.collapsed)) problems.push(`the embed already shows folds before the click (${before.arrows.filter((a) => a.collapsed).map((a) => a.row).join(", ")}): run --phase seed, and clear Obsidian's own fold memory`);
	state.filesBaseline = json(readJson(args.data).files ?? null);
	await realClickArrow(cdp, args, HOST_SRC, LESSON_8);
	await sleep(args.waitMs);
	const after = (await readEmbeds(cdp, args.host)).find((e) => e.src === HOST_SRC);
	problems.push(...foldProblems("after the click", after, { folded: [LESSON_8], unfolded: [SIBLING_ROW] }));
	extra.push(`screenshot: ${await screenshot(cdp, args, screenshotName("s1-fold", view, "folded"))}`);
	await sleep(settleMs(args)); // the store flushes on its own 150 ms timer
	const records = recordsOf(args);
	problems.push(...liveRecordProblems("data.json after the click", records));
	state.record = records[0] ?? null;
	problems.push(...everyStepProblems("after S1", args, state));
	report(`s1-fold (${view}, S1: Lesson 8 folded in the embed by a real click, and stored)`, problems, extra);
}

async function stepRetarget(cdp, args, state, view) {
	const problems = [];
	const extra = [];
	if (!state.record) problems.push("no saved record from --phase s1-fold: run it first (same --state file)");
	const since = Date.now();
	writeNote(args, state, args.host, readFileSync(RETARGETED_FIXTURE, "utf8"));
	const embed = await waitForEmbed(cdp, args, RETARGET_SRC);
	problems.push(...foldProblems("the retargeted embed", embed, { folded: [], unfolded: [LESSON_9] }));
	extra.push(`screenshot: ${await screenshot(cdp, args, screenshotName("s2-retarget", view, "expanded"))}`);
	await sleep(settleMs(args));
	const now = Date.now();
	if (state.record) problems.push(...dormantRecordProblems("the old key after the retarget", recordsOf(args), state.record, { since, now }));
	problems.push(...noRecordProblems("the new key after the retarget (E12: nothing is copied or created)", recordsOf(args, RETARGET_BLOCK)));
	problems.push(...everyStepProblems("after S2", args, state));
	report(`s2-retarget (${view}, S2: the new embed is expanded, the old state is dormant, nothing copied)`, problems, extra);
}

async function stepRevert(cdp, args, state, view) {
	const problems = [];
	const extra = [];
	if (!state.record) problems.push("no saved record from --phase s1-fold: run it first (same --state file)");
	writeNote(args, state, args.host, readFileSync(HOST_FIXTURE, "utf8"));
	const embed = await waitForEmbed(cdp, args, HOST_SRC);
	problems.push(...foldProblems("after the revert", embed, { folded: [LESSON_8], unfolded: [SIBLING_ROW] }));
	extra.push(`screenshot: ${await screenshot(cdp, args, screenshotName("s3-revert", view, "refolded"))}`);
	await sleep(settleMs(args));
	problems.push(...liveRecordProblems("the old key after the revert", recordsOf(args), state.record));
	problems.push(...everyStepProblems("after S3", args, state));
	report(`s3-revert (${view}, S3: reverted inside the window, Lesson 8 folded again, record live)`, problems, extra);
}

async function stepExpire(cdp, args, state, view) {
	const problems = [];
	const extra = [];
	if (!state.record) problems.push("no saved record from --phase s1-fold: run it first (same --state file)");
	// Retarget again: the old record goes dormant.
	const since = Date.now();
	writeNote(args, state, args.host, readFileSync(RETARGETED_FIXTURE, "utf8"));
	await waitForEmbed(cdp, args, RETARGET_SRC);
	await sleep(settleMs(args));
	if (state.record) problems.push(...dormantRecordProblems("the old key after the retarget", recordsOf(args), state.record, { since, now: Date.now() }));

	// "Relaunch": the plugin off, dormantSince moved 11 minutes back, the plugin on (load-time expiry).
	await setPlugin(cdp, false);
	await sleep(500);
	let aged = null;
	try {
		const backdated = backdateDormantSince(readJson(args.data), ids(args), Date.now(), BACKDATE_MS);
		writeData(args.data, backdated.data);
		aged = backdated.since;
	} catch (err) {
		problems.push(String(err.message ?? err));
	}
	await setPlugin(cdp, true);
	await sleep(settleMs(args));
	extra.push(`dormantSince backdated to ${aged} (${BACKDATE_MS} ms before the plugin was disabled, window ${MAX_DORMANT_AGE_MS} ms)`);

	// Revert after the window: the embed starts expanded, the old state is gone.
	writeNote(args, state, args.host, readFileSync(HOST_FIXTURE, "utf8"));
	const embed = await waitForEmbed(cdp, args, HOST_SRC);
	problems.push(...foldProblems("after the late revert", embed, { folded: [], unfolded: [LESSON_8, SIBLING_ROW] }));
	extra.push(`screenshot: ${await screenshot(cdp, args, screenshotName("s4-expire", view, "expanded"))}`);
	await sleep(settleMs(args));
	problems.push(...noRecordProblems("data.json for the old key after the late revert", recordsOf(args)));
	problems.push(...everyStepProblems("after S4", args, state));
	state.record = null;
	report(`s4-expire (${view}, S4: retargeted, backdated 11 minutes, relaunched, reverted: expanded, no entry for the old key)`, problems, extra);
}

async function stepBreak(cdp, args, state, view) {
	const problems = [];
	const extra = [];
	// Start from a stored fold (S4 left none): a real click. The source note is not open in a pane
	// while it is edited on disk: an open source is edited as a note, and its own `files` record
	// would then change by design (the files section is meant to stay as it was at S1).
	await cdp.evaluate(closeExpression(args.source));
	await openHost(cdp, args, view);
	const start = await waitForEmbed(cdp, args, HOST_SRC);
	if (!start.arrows.some((a) => a.row.startsWith(LESSON_8) && a.collapsed)) await realClickArrow(cdp, args, HOST_SRC, LESSON_8);
	await sleep(settleMs(args));
	const folded = recordsOf(args);
	problems.push(...liveRecordProblems("data.json before the break", folded));
	const kept = folded[0] ?? null;
	if (!state.filesBaseline) state.filesBaseline = json(readJson(args.data).files ?? null);

	// Break it: the source loses the block id on disk.
	const since = Date.now();
	writeNote(args, state, args.source, readFileSync(BROKEN_FIXTURE, "utf8"));
	const broken = await settledEmbed(cdp, args, HOST_SRC);
	if (!broken) problems.push("the broken embed is not on the page at all");
	else {
		problems.push(...foldProblems("the broken embed", { arrows: broken.arrows }, { folded: [] }));
		extra.push(`what the host shows for the broken embed: ${json(broken.text)}`);
	}
	extra.push(`screenshot: ${await screenshot(cdp, args, screenshotName("s5-break", view, "broken"))}`);
	await sleep(settleMs(args));
	if (kept) problems.push(...dormantRecordProblems("the record while the embed is broken", recordsOf(args), kept, { since, now: Date.now() }));
	problems.push(...everyStepProblems("while broken", args, state));

	// Repair it inside the window: the block id comes back. Obsidian does not re-render an embed
	// that says "Unable to find" when its target gets the block back (the metadata cache has it
	// and the embed still shows the message), and E6 restores the folds "when the embed next
	// renders": so the host is opened again, which is what Dan does, and that is the next render.
	writeNote(args, state, args.source, readFileSync(SOURCE_FIXTURE, "utf8"));
	await sleep(settleMs(args));
	await openHost(cdp, args, view);
	const repaired = await waitForEmbed(cdp, args, HOST_SRC);
	problems.push(...foldProblems("after the repair", repaired, { folded: [LESSON_8], unfolded: [SIBLING_ROW] }));
	extra.push(`screenshot: ${await screenshot(cdp, args, screenshotName("s5-break", view, "repaired"))}`);
	await sleep(settleMs(args));
	if (kept) problems.push(...liveRecordProblems("the record after the repair", recordsOf(args), kept));
	problems.push(...everyStepProblems("after S5", args, state));
	report(`s5-break (${view}, S5: block id removed: nothing applied, record dormant; restored inside the window: folded again)`, problems, extra);
}

const RUNNERS = { seed: stepSeed, "s1-fold": stepFold, "s2-retarget": stepRetarget, "s3-revert": stepRevert, "s4-expire": stepExpire, "s5-break": stepBreak };

function printUsage() {
	console.log(
		[
			`Usage: node scripts/e2e-embed-dormant-probe.mjs [--phase <${PHASES.join("|")}>] [--view <${VIEWS.join("|")}>] [options]`,
			"",
			"PR-7 end to end: retarget or break an embed's link or block and check its folds go dormant for",
			"10 minutes, come back inside the window and are forgotten after it (dormantSince is backdated in",
			"data.json while the plugin is disabled, so there is no real wait).",
			"",
			"  --phase seed          write the fixtures, drop the host's embeds entries",
			"  --phase s1-fold       S1: fold Lesson 8 in the embed with a real click",
			"  --phase s2-retarget   S2: retarget the link: new embed expanded, old state dormant",
			"  --phase s3-revert     S3: revert inside the window: folded again",
			"  --phase s4-expire     S4: retarget, backdate 11 minutes, relaunch, revert: expanded, no entry",
			"  --phase s5-break      S5: remove the block id, check nothing applies; restore it: folded again",
			"  --phase all           seed and S1 to S5 in Live Preview, then S1 to S3 in Reading view (S6); the default",
			"",
			"Options: [--cdp-port 9222] [--docker <container>] [--vault-root /config/test-vault] [--host <path>]",
			"         [--source <path>] [--data <path>] [--state <path>] [--screenshots screenshots] [--wait-ms 1500]",
		].join("\n"),
	);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !PHASES.includes(args.phase) || !VIEWS.includes(args.view)) {
		printUsage();
		process.exitCode = args.help ? 0 : 1;
		return;
	}
	const state = args.phase === "all" || args.phase === "seed" ? {} : readJson(args.state);
	if (args.phase === "seed") state.written = readJson(args.state).written;
	await withConnection(args, async (cdp) => {
		for (const { step, view } of plan(args.phase, args.view)) {
			await RUNNERS[step](cdp, args, state, view);
			writeFileSync(args.state, JSON.stringify(state, null, 2), "utf8");
		}
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error("e2e-embed-dormant-probe failed:", err);
		process.exitCode = 1;
	});
}
