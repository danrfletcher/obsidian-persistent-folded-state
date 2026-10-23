#!/usr/bin/env node
/**
 * E10/G18: how Obsidian exposes fold toggles inside embeds, proven against a real Obsidian.
 *
 * It answers, for an embed in a Live Preview host and in a Reading view host, for block, heading
 * and whole-note embeds (six combinations): which element and events expose the fold toggles,
 * when an embed renders and re-renders, what Obsidian itself keeps across closing and reopening
 * the host and across an external edit of the source, and whether Obsidian's own fold memory is
 * keyed to the source note. It also measures a 51-embed host for lazy rendering and a hover
 * preview for the container rule (E13). It writes:
 *
 *   docs/embed-probe.json        one verdict per host mode and embed kind, plus the evidence
 *   docs/embed-probe.md          the readable report
 *   docs/embed-release-gaps.md   every non-supported combination, in release-note wording
 *
 * src/embed-capabilities.ts holds the same verdicts as a typed constant; it is edited by hand from
 * the JSON, and tests/unit/embed-capabilities.test.ts fails if the two drift.
 *
 * This is a script, not plugin code: nothing here ships in main.js, nothing folds, records or
 * writes anything inside the plugin. It only clicks fold toggles in Obsidian's own UI, writes its
 * own fixture folder (`embed-probe/`) into the vault and removes it again. It refuses to run if a
 * folder of that name already exists in the vault that it did not create (it marks its own with a
 * `.pfs-embed-probe` file), so pointing it at a real vault cannot delete real notes.
 *
 * Phases (each reconnects over CDP, like scripts/e2e-reload-probe.mjs and e2e-restore-probe.mjs;
 * progress between phases lives in --state):
 *
 *   --phase setup     reset the fixture, open the host in the mode, record the cold render,
 *                      fold one item in each of the block / heading / whole-note embeds with a
 *                      real mouse click, and run the fold-memory experiment once per embed kind
 *                      (fold only that kind, then look in the source note opened alone, in the same
 *                      embed in a second host, and for the whole-note kind in the `![](x.md)`
 *                      embed of the same note after reopening the host).
 *   --phase reopen    for each kind: fold it (asserted), close the host, reopen it and record what
 *                      Obsidian kept ("unobservable" if nothing was folded); then drive the
 *                      toggles with a synthetic click.
 *   --phase edit      fold each kind (asserted), rewrite the source notes from outside Obsidian
 *                      (as a git pull would) and record re-render timing, what survives, and
 *                      whether the embed shows the edited text (unfolding a folded item to read it).
 *   --phase lazy      open a 51-embed host and count rendered embeds at 0, 1 and 5 seconds.
 *   --phase hover     hover a link to the host and report whether its embeds are ignored.
 *   --phase report    write docs/embed-probe.{json,md} and docs/embed-release-gaps.md.
 *   --phase cleanup   remove the fixture folder, close its tabs, verify the vault is unchanged.
 *   --phase all       setup + reopen + edit + lazy per mode, then hover, report, cleanup (default).
 *
 * Usage (needs a real Obsidian launched with --remote-debugging-port and a vault with the
 * plugin enabled; see use-desktop-container.md):
 *
 *   npm run test:e2e:embed-probe                                  # inside the container
 *   npm run test:e2e:embed-probe -- --docker desktop-warkworth-21 # from the host
 *
 * Options: [--mode lp|rv|both] [--cdp-port 9222] [--docker <container>] [--vault <dir>]
 *          [--state <path>] [--repeat <n>] [--no-write-docs]
 *
 * --docker bridges the container's loopback CDP port over `docker exec` (the container has no
 * Node); --vault is the vault directory as this process sees it (default: /config/test-vault, or
 * the container's bind-mounted equivalent under --docker). --repeat n runs the whole probe n
 * times and exits 1 unless every run produces identical verdicts (idempotence).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, basename, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { connectCdp } from "./lib/cdp-client.mjs";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const FIXTURES = join(ROOT, "tests", "fixtures", "embed-probe");
const PAGE_LIB = readFileSync(join(ROOT, "scripts", "lib", "embed-probe-page.js"), "utf8");
const DEFAULT_STATE_PATH = join(tmpdir(), "pfs-e2e-embed-probe-state.json");

const UNOBSERVABLE = "unobservable";
const FOLDER = "embed-probe";
const HOST = `${FOLDER}/Probe Host.md`;
const SECOND_HOST = `${FOLDER}/Probe Second Host.md`;
const HOST_51 = `${FOLDER}/Probe Host 51.md`;
const HOVER_HOST = `${FOLDER}/Probe Hover Link.md`;
const SOURCE = `${FOLDER}/Probe Fundamentals.md`;
const WHOLE = `${FOLDER}/Probe Whole Note.md`;

const MODES = {
	lp: { id: "live-preview", label: "Live Preview" },
	rv: { id: "reading-view", label: "Reading view" },
};
const KINDS = {
	block: { label: "block embed", key: "Probe Fundamentals#^0169a6|0", item: "Lesson 8", source: SOURCE, sourceSpec: { type: "list", label: "Lesson 8:", childText: "Count word frequency" } },
	heading: { label: "heading embed", key: "Probe Fundamentals#Lesson 8|0", item: "Lesson 8", source: SOURCE, sourceSpec: { type: "heading", label: "Lesson 8", childText: "Count word frequency" } },
	"whole-note": { label: "whole-note embed", key: "Probe Whole Note|0", item: "Item A1", source: WHOLE, sourceSpec: { type: "list", label: "Item A1", childText: "Child A1a" } },
};
const KIND_IDS = Object.keys(KINDS);
/** The `![](Probe%20Whole%20Note.md)` embed in the host: a second embed of the whole-note kind's source. */
const MD_LINK_KEY = "Probe Whole Note.md|0";
const NOT_APPLICABLE = "not-applicable";
/** Dropped into the fixture folder so the probe can tell its own leftovers from someone's real folder. */
const MARKER = ".pfs-embed-probe";
/** Top-level embeds of the host fixture, in document order (the DOM snapshot is checked against it). */
const HOST_EMBED_ORDER = [
	{ name: "block", src: "Probe Fundamentals#^0169a6" },
	{ name: "heading", src: "Probe Fundamentals#Lesson 8" },
	{ name: "whole-note", src: "Probe Whole Note" },
	{ name: "md-link", src: "Probe Whole Note.md" },
	{ name: "image", src: "probe-image.svg" },
	{ name: "nested", src: "Probe Nested Outer" },
];
const PHASES = ["all", "setup", "reopen", "edit", "lazy", "hover", "report", "cleanup"];

// ---- arguments / state ------------------------------------------------------------------------
function parseArgs(argv) {
	const args = { cdpPort: 9222, docker: process.env.PFS_PROBE_DOCKER || null, mode: "both", state: DEFAULT_STATE_PATH, repeat: 1, writeDocs: true };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--phase") args.phase = argv[++i];
		else if (arg === "--mode") args.mode = argv[++i];
		else if (arg === "--cdp-port") args.cdpPort = Number(argv[++i]);
		else if (arg === "--docker") args.docker = argv[++i];
		else if (arg === "--vault") args.vault = argv[++i];
		else if (arg === "--state") args.state = argv[++i];
		else if (arg === "--repeat") args.repeat = Number(argv[++i]);
		else if (arg === "--no-write-docs") args.writeDocs = false;
		else if (arg === "--help" || arg === "-h") args.help = true;
	}
	return args;
}

function printUsage() {
	console.log(
		[
			`Usage: node scripts/e2e-embed-probe.mjs [--phase <${PHASES.join("|")}>] [options]`,
			"",
			"Options: [--mode lp|rv|both] [--cdp-port 9222] [--docker <container>] [--vault <dir>]",
			"         [--state <path>] [--repeat <n>] [--no-write-docs]",
			"",
			"Requires a real Obsidian launched with --remote-debugging-port and the plugin enabled.",
			"See the file comment for what each phase does.",
		].join("\n")
	);
}

function freshState() {
	return { startedAt: new Date().toISOString(), vault: null, obsidian: null, preSnapshot: null, modes: {}, hover: null, fixtureRestored: null, stepErrors: [] };
}

function loadState(path) {
	if (!existsSync(path)) return freshState();
	try {
		return { ...freshState(), ...JSON.parse(readFileSync(path, "utf8")) };
	} catch {
		return freshState();
	}
}

const saveState = (path, state) => writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const modeData = (state, mode) => (state.modes[mode] ??= {});

/** Runs one probe step. A throw or timeout is recorded and becomes "unobservable", never a crash. */
async function step(state, name, mode, fn) {
	try {
		return await fn();
	} catch (err) {
		const error = String(err && err.message ? err.message : err);
		state.stepErrors.push({ step: name, mode: mode ?? null, error });
		console.warn(`  step "${name}"${mode ? ` (${mode})` : ""} -> ${UNOBSERVABLE}: ${error}`);
		return UNOBSERVABLE;
	}
}

// ---- vault, fixtures ---------------------------------------------------------------------------
async function resolveVault(args) {
	if (args.vault) return args.vault;
	if (!args.docker) return "/config/test-vault";
	const { stdout } = await execFileAsync("docker", ["inspect", args.docker, "--format", "{{json .Mounts}}"]);
	const mount = JSON.parse(stdout).find((m) => m.Destination === "/config");
	if (!mount) throw new Error(`container ${args.docker} has no /config mount; pass --vault`);
	return join(mount.Source, "test-vault");
}

function walk(dir, skip, out = {}) {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const rel = relative(skip.root, full);
		if (skip.names.includes(rel.split("/")[0])) continue;
		if (statSync(full).isDirectory()) walk(full, skip, out);
		else out[rel] = createHash("sha1").update(readFileSync(full)).digest("hex");
	}
	return out;
}

/** Everything in the vault except Obsidian's own config folder and this probe's fixture folder. */
const vaultSnapshot = (vault) => walk(vault, { root: vault, names: [".obsidian", FOLDER] });

function hostFifty1Text() {
	const targets = ["![[Probe Fundamentals#^0169a6]]", "![[Probe Fundamentals#Lesson 8]]", "![[Probe Whole Note]]"];
	const lines = ["# Probe Host 51", ""];
	for (let i = 0; i < 51; i++) lines.push(targets[i % 3], "");
	return lines.join("\n");
}

/**
 * The probe owns `<vault>/embed-probe/` only if it created it. A folder of that name without the
 * marker file is somebody's real content (the vault passed in may be Dan's real one), so the probe
 * refuses to run rather than delete it. Returns "absent", or "leftover" for a folder a previous
 * (crashed) probe run left behind, which is safe to replace.
 */
export function guardFixtureFolder(vault) {
	const dest = join(vault, FOLDER);
	if (!existsSync(dest)) return "absent";
	if (existsSync(join(dest, MARKER))) return "leftover";
	throw new Error(`refusing to run: ${dest} already exists and was not created by this probe (no ${MARKER} marker in it). Move or rename it, or point --vault at a disposable test vault.`);
}

/** Deletes the fixture folder, but only one this probe created. */
export function removeFixtureFolder(vault) {
	if (guardFixtureFolder(vault) === "leftover") rmSync(join(vault, FOLDER), { recursive: true, force: true });
}

export function installFixtures(vault) {
	removeFixtureFolder(vault);
	const dest = join(vault, FOLDER);
	mkdirSync(dest, { recursive: true });
	writeFileSync(join(dest, MARKER), "created by scripts/e2e-embed-probe.mjs; removed by its cleanup phase\n", "utf8");
	for (const name of readdirSync(FIXTURES)) copyFileSync(join(FIXTURES, name), join(dest, name));
	writeFileSync(join(vault, HOST_51), hostFifty1Text(), "utf8");
}

/** Puts the two edited source notes back to their fixture text (idempotence between modes/runs). */
function restoreSources(vault) {
	for (const path of [SOURCE, WHOLE]) copyFileSync(join(FIXTURES, basename(path)), join(vault, path));
}

/** The external edit (a git pull, an agent): rename the Lesson 8 line, revise an item. */
function editSources(vault) {
	const source = readFileSync(join(FIXTURES, basename(SOURCE)), "utf8");
	const revisedSource = source.replace("- Lesson 8: Collections", "- Lesson 8 (revised): Collections");
	const whole = readFileSync(join(FIXTURES, basename(WHOLE)), "utf8");
	const revisedWhole = whole.replace("- Item A1\n", "- Item A1 (revised)\n");
	if (revisedSource === source || revisedWhole === whole) throw new Error("the fixture text no longer matches the edit script");
	writeFileSync(join(vault, SOURCE), revisedSource, "utf8");
	writeFileSync(join(vault, WHOLE), revisedWhole, "utf8");
}

// ---- CDP plumbing --------------------------------------------------------------------------------
async function withCdp(args, state, fn) {
	const cdp = await connectCdp({ cdpPort: args.cdpPort, docker: args.docker });
	try {
		await cdp.send("Runtime.enable");
		await cdp.evaluate(PAGE_LIB, { awaitPromise: false });
		return await fn(cdp);
	} finally {
		cdp.close();
	}
}

const call = (cdp, fn, ...fnArgs) =>
	cdp.evaluate(`window.__pfsEmbedProbe.${fn}(${fnArgs.map((a) => JSON.stringify(a)).join(", ")})`, { timeoutMs: 60000 });

/** Waits for Obsidian to index a fixture note. If the container's file watcher missed it (new
 * files on a bind mount sometimes are), the same text is written through Obsidian's own adapter. */
async function waitFileReady(cdp, path, vault) {
	for (let i = 0; i < 24; i++) {
		if (await call(cdp, "fileReady", path)) return;
		await sleep(250);
	}
	await call(cdp, "ensureFile", path, readFileSync(join(vault, path), "utf8"));
	for (let i = 0; i < 40; i++) {
		if (await call(cdp, "fileReady", path)) return;
		await sleep(250);
	}
	throw new Error(`Obsidian never indexed ${path}`);
}

async function waitFilesReady(cdp, paths, vault) {
	for (const path of paths) await waitFileReady(cdp, path, vault);
}

const FIXTURE_NOTES = [HOST, SECOND_HOST, HOST_51, HOVER_HOST, SOURCE, WHOLE, `${FOLDER}/Probe Nested Outer.md`, `${FOLDER}/Probe Nested Inner.md`];

async function realClick(cdp, path, key, label) {
	await call(cdp, "rectOf", path, key, label); // scrolls the toggle into view
	await sleep(300);
	const { x, y } = await call(cdp, "rectOf", path, key, label);
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
	await sleep(700);
}

const foldedLabels = (snapshotEmbed) => (snapshotEmbed ? snapshotEmbed.toggles.filter((t) => t.collapsed).map((t) => t.label) : null);
const embedByKey = (snapshot, key) => (snapshot && snapshot.embeds ? snapshot.embeds.find((e) => e.key === key) ?? null : null);
const toggleAt = (snapshot, key, index) => embedByKey(snapshot, key)?.toggles?.[index] ?? null;
const eventSignature = (events) => (Array.isArray(events) ? events.map((e) => (e.isTrusted === null ? e.type : `${e.type}${e.isTrusted ? "" : " (synthetic)"}`)) : UNOBSERVABLE);

/** Whether the item a kind folds (the first toggle whose label starts with `item`) is collapsed in
 * the embed with `key`; UNOBSERVABLE when the embed or the toggle is not in the snapshot. */
export function itemFolded(snapshot, key, item) {
	const toggle = embedByKey(snapshot, key)?.toggles?.find((t) => t.label.startsWith(item));
	return toggle ? toggle.collapsed === true : UNOBSERVABLE;
}

/**
 * Did the fold survive? `before`/`after` are the folded labels of an embed (arrays) or UNOBSERVABLE.
 * A fold that was never there at close time cannot be "kept" or "lost": that is a failed
 * precondition, reported as UNOBSERVABLE with the reason, never as "no" (R2).
 */
export function retention(before, after, { compare = "labels" } = {}) {
	const bad = (v) => v === UNOBSERVABLE || v === null || v === undefined;
	if (bad(before)) return { retained: UNOBSERVABLE, reason: "the fold state before closing/editing could not be read" };
	if (before.length === 0) return { retained: UNOBSERVABLE, reason: "nothing in the embed was folded at the time the host was closed or the source edited, so what Obsidian keeps cannot be observed" };
	if (bad(after)) return { retained: UNOBSERVABLE, reason: "the fold state afterwards could not be read" };
	const same = compare === "count" ? after.length === before.length : JSON.stringify(after) === JSON.stringify(before);
	return { retained: same, reason: null };
}

/** Makes sure the item `kind` folds is folded in the host (a real mouse click if it is not), then reads it back. */
async function ensureFolded(cdp, kind) {
	const { key, item } = KINDS[kind];
	const first = await call(cdp, "toggleState", HOST, key, item);
	if (first.collapsed === true) return { wasFolded: true, folded: true };
	await realClick(cdp, HOST, key, item);
	const after = await call(cdp, "toggleState", HOST, key, item);
	return { wasFolded: false, folded: after.collapsed === true };
}

/**
 * Does the embed show the externally edited text (the "(revised)" lines)? Folded items may not be
 * rendered at all, so a folded kind is read twice: as it stands (toggle labels and the embed's
 * text), then, if the edit is not visible, after unfolding the item the kind folded. The result
 * says which way it was read; `updated: false` after an unfold is a real "the embed did not update".
 */
async function readEditedText(cdp, kind, afterSnapshot) {
	const { key, item } = KINDS[kind];
	const e = embedByKey(afterSnapshot, key);
	if (!e) return { updated: UNOBSERVABLE, method: UNOBSERVABLE };
	const shows = async (toggles) => toggles.some((t) => t.label.includes("(revised)")) || (await call(cdp, "embedHasText", HOST, key, "(revised)"));
	if (await shows(e.toggles)) return { updated: true, method: "visible" };
	if (!e.toggles.some((t) => t.collapsed)) return { updated: false, method: "visible" };
	await call(cdp, "syntheticClick", HOST, key, item);
	await sleep(700);
	const unfolded = embedByKey(await call(cdp, "snapshot", HOST), key);
	if (!unfolded) return { updated: UNOBSERVABLE, method: "after-unfold" };
	return { updated: await shows(unfolded.toggles), method: "after-unfold" };
}

// ---- reset ---------------------------------------------------------------------------------------
async function resetFixture(cdp, vault) {
	await call(cdp, "closeProbeLeaves", `${FOLDER}/`);
	await call(cdp, "clearFoldKeys");
	restoreSources(vault);
	await sleep(1200);
}

// ---- phases ----------------------------------------------------------------------------------------
async function runSetup(args, state, vault) {
	await withCdp(args, state, async (cdp) => {
		for (const mode of selectedModes(args)) {
			console.log(`setup (${MODES[mode].label})`);
			const data = (state.modes[mode] = {});
			await step(state, "reset", mode, () => resetFixture(cdp, vault));
			await step(state, "wait-indexed", mode, () => waitFilesReady(cdp, FIXTURE_NOTES, vault));

			const open = await step(state, "open-host", mode, () => call(cdp, "openHost", HOST, mode));
			data.open = open;
			data.render = open === UNOBSERVABLE ? UNOBSERVABLE : await step(state, "render-summary", mode, () => call(cdp, "summarize", open.recorder, 150));
			const snap = await step(state, "snapshot", mode, () => call(cdp, "snapshot", HOST));
			data.snapshotBeforeFold = snap;
			data.hostEmbedOrderOk =
				snap === UNOBSERVABLE || !snap.embeds
					? UNOBSERVABLE
					: HOST_EMBED_ORDER.length === snap.embeds.length && HOST_EMBED_ORDER.every((e, i) => snap.embeds[i].src === e.src);

			data.folds = {};
			for (const kind of KIND_IDS) {
				const { key, item } = KINDS[kind];
				data.folds[kind] = await step(state, `real-click ${kind}`, mode, async () => {
					const before = await call(cdp, "toggleState", HOST, key, item);
					await call(cdp, "armEvents", HOST, key);
					await realClick(cdp, HOST, key, item);
					const events = await call(cdp, "readEvents");
					await call(cdp, "disarmEvents");
					const after = await call(cdp, "toggleState", HOST, key, item);
					return { item, before, after, events, changed: before.collapsed !== after.collapsed, folded: after.collapsed === true };
				});
			}

			data.afterFold = await step(state, "snapshot-after-fold", mode, () => call(cdp, "snapshot", HOST));

			// Is Obsidian's fold memory keyed to the source note? Asked once per embed kind, with only
			// that kind folded, so a fold of one kind cannot be mistaken for another's.
			data.memory = { kinds: {} };
			for (const kind of KIND_IDS) {
				data.memory.kinds[kind] = await step(state, `fold-memory ${kind}`, mode, () => runKindMemory(cdp, state, mode, kind));
			}
			// Leave the primary host open and clean (no fold memory, nothing folded) for the next phase.
			await step(state, "reset-after-fold-memory", mode, async () => {
				await call(cdp, "clearFoldKeys");
				await call(cdp, "openHost", HOST, mode);
			});
		}
	});
}

/**
 * One kind's fold-memory experiment: with a clean host, fold only this kind's item in the primary
 * host, then look for the fold in (a) the source note opened on its own, (b) the same embed in a
 * second host, and (c) for the whole-note kind, the `![](x.md)` embed of the same note in the
 * primary host after it was re-rendered by closing and reopening it.
 */
async function runKindMemory(cdp, state, mode, kind) {
	const { key, item, source, sourceSpec } = KINDS[kind];
	await call(cdp, "clearFoldKeys");
	await call(cdp, "openHost", HOST, mode);
	const fold = await ensureFolded(cdp, kind);
	const storage = await call(cdp, "foldKeys");
	const out = { folded: fold.folded, wasFoldedBeforeClick: fold.wasFolded, storageKeys: Object.keys(storage), storage };
	out.sourceNote = await step(state, `source-note-state ${kind}`, mode, async () => {
		await call(cdp, "openPlain", source, mode);
		const s = await call(cdp, "sourceNoteState", source, sourceSpec);
		await call(cdp, "closeLeavesFor", source);
		return s;
	});
	out.secondHost = await step(state, `second-host ${kind}`, mode, async () => {
		await call(cdp, "openHost", SECOND_HOST, mode);
		const s = await call(cdp, "snapshot", SECOND_HOST);
		await call(cdp, "closeLeavesFor", SECOND_HOST);
		const e = embedByKey(s, key);
		return { found: !!e, folded: itemFolded(s, key, item), foldedLabels: e ? foldedLabels(e) : UNOBSERVABLE };
	});
	if (kind === "whole-note") {
		out.sameHost = await step(state, `same-host-second-embed ${kind}`, mode, async () => {
			// Re-render the host first: the earlier snapshot predates any re-render of the md-link embed.
			await call(cdp, "closeLeavesFor", HOST);
			await sleep(800);
			await call(cdp, "openHost", HOST, mode);
			const s = await call(cdp, "snapshot", HOST);
			const e = embedByKey(s, MD_LINK_KEY);
			return { found: !!e, folded: itemFolded(s, MD_LINK_KEY, item), foldedLabels: e ? foldedLabels(e) : UNOBSERVABLE, primaryEmbedFolded: itemFolded(s, key, item) };
		});
	} else out.sameHost = NOT_APPLICABLE;
	return out;
}

async function runReopen(args, state) {
	await withCdp(args, state, async (cdp) => {
		for (const mode of selectedModes(args)) {
			console.log(`reopen (${MODES[mode].label})`);
			const data = modeData(state, mode);
			const out = (data.reopen = {});
			// Each kind is measured on its own: fold it (asserting it is folded before closing, R2),
			// close the host, reopen it, and compare. Block and heading embeds of one note share
			// Obsidian's per-note fold entry, so folding all three together would let one overwrite another.
			out.perKind = {};
			for (const kind of KIND_IDS) {
				out.perKind[kind] = await step(state, `retention ${kind}`, mode, async () => {
					const { key } = KINDS[kind];
					await call(cdp, "clearFoldKeys");
					await call(cdp, "openHost", HOST, mode);
					const fold = await ensureFolded(cdp, kind);
					const before = await call(cdp, "snapshot", HOST);
					const foldedBeforeClose = foldedLabels(embedByKey(before, key)) ?? UNOBSERVABLE;
					await call(cdp, "closeLeavesFor", HOST);
					await sleep(800);
					const opened = await call(cdp, "openHost", HOST, mode);
					const render = await call(cdp, "summarize", opened.recorder, 150);
					const after = await call(cdp, "snapshot", HOST);
					const foldedAfterReopen = foldedLabels(embedByKey(after, key)) ?? UNOBSERVABLE;
					const storageAfterReopen = await call(cdp, "foldKeys");
					const { retained, reason } = retention(foldedBeforeClose, foldedAfterReopen);
					return { wasFoldedBeforeClick: fold.wasFolded, foldedBeforeClose, foldedAfterReopen, retained, reason, storageAfterReopen, open: opened, render };
				});
			}
			const results = KIND_IDS.map((k) => out.perKind[k]);
			const last = [...results].reverse().find(isObj);
			out.open = last ? last.open : UNOBSERVABLE;
			out.render = last ? last.render : UNOBSERVABLE;
			out.foldedBeforeClose = Object.fromEntries(KIND_IDS.map((k) => [k, isObj(out.perKind[k]) ? out.perKind[k].foldedBeforeClose : UNOBSERVABLE]));
			out.foldedAfterReopen = Object.fromEntries(KIND_IDS.map((k) => [k, isObj(out.perKind[k]) ? out.perKind[k].foldedAfterReopen : UNOBSERVABLE]));
			out.retained = Object.fromEntries(KIND_IDS.map((k) => [k, isObj(out.perKind[k]) ? out.perKind[k].retained : UNOBSERVABLE]));
			out.retainedReason = Object.fromEntries(KIND_IDS.map((k) => [k, isObj(out.perKind[k]) ? out.perKind[k].reason : "the retention step for this kind did not complete (see stepErrors)"]));

			await step(state, "ensure-host-open", mode, async () => {
				const snap = await call(cdp, "snapshot", HOST);
				if (snap.error) await call(cdp, "openHost", HOST, mode);
			});

			out.drive = {};
			for (const kind of KIND_IDS) {
				const { key, item } = KINDS[kind];
				out.drive[kind] = await step(state, `synthetic-click ${kind}`, mode, async () => {
					const before = await call(cdp, "toggleState", HOST, key, item);
					await call(cdp, "armEvents", HOST, key);
					await call(cdp, "syntheticClick", HOST, key, item);
					await sleep(500);
					const events = await call(cdp, "readEvents");
					await call(cdp, "disarmEvents");
					const middle = await call(cdp, "toggleState", HOST, key, item);
					// Put the item back to folded so the edit phase starts from the same state.
					if (!middle.collapsed) await call(cdp, "syntheticClick", HOST, key, item);
					await sleep(400);
					const restored = await call(cdp, "toggleState", HOST, key, item);
					return { item, before, afterSynthetic: middle, events, changed: before.collapsed !== middle.collapsed, foldedAgain: restored.collapsed === true };
				});
			}
		}
	});
}

async function runEdit(args, state, vault) {
	await withCdp(args, state, async (cdp) => {
		for (const mode of selectedModes(args)) {
			console.log(`edit (${MODES[mode].label})`);
			const data = modeData(state, mode);
			const out = (data.edit = {});
			await step(state, "ensure-host-open", mode, async () => {
				const snap = await call(cdp, "snapshot", HOST);
				if (snap.error) await call(cdp, "openHost", HOST, mode);
			});
			const prefold = {};
			for (const kind of KIND_IDS) prefold[kind] = await step(state, `ensure-folded ${kind}`, mode, () => ensureFolded(cdp, kind));
			out.preFolded = prefold;
			await sleep(500);
			const before = await step(state, "snapshot-before-edit", mode, () => call(cdp, "snapshot", HOST));
			out.foldedBefore = Object.fromEntries(KIND_IDS.map((k) => [k, before === UNOBSERVABLE ? UNOBSERVABLE : foldedLabels(embedByKey(before, KINDS[k].key)) ?? UNOBSERVABLE]));
			const rec = await step(state, "start-recorder", mode, () => call(cdp, "recordHost", `edit|${mode}`, HOST));
			const wrote = await step(state, "external-write", mode, async () => {
				editSources(vault);
				return true;
			});
			if (rec !== UNOBSERVABLE && wrote !== UNOBSERVABLE) {
				out.quiet = await step(state, "wait-quiet", mode, async () => {
					await sleep(1500);
					return call(cdp, "waitQuiet", rec, 1200, 10000);
				});
				out.render = await step(state, "render-summary", mode, () => call(cdp, "summarize", rec, 150));
			} else {
				out.render = UNOBSERVABLE;
			}
			const after = await step(state, "snapshot-after-edit", mode, () => call(cdp, "snapshot", HOST));
			out.foldedAfter = Object.fromEntries(KIND_IDS.map((k) => [k, after === UNOBSERVABLE ? UNOBSERVABLE : foldedLabels(embedByKey(after, KINDS[k].key)) ?? UNOBSERVABLE]));
			const retainedBy = Object.fromEntries(KIND_IDS.map((k) => [k, retention(out.foldedBefore[k], out.foldedAfter[k], { compare: "count" })]));
			out.retained = Object.fromEntries(KIND_IDS.map((k) => [k, retainedBy[k].retained]));
			out.retainedReason = Object.fromEntries(KIND_IDS.map((k) => [k, retainedBy[k].reason]));

			// Did the embed show the edited text? Read after the fold state above is recorded: a folded
			// section may not render its items at all, so the item is unfolded first when needed (R3).
			out.contentUpdated = {};
			out.contentUpdatedMethod = {};
			for (const kind of KIND_IDS) {
				const read = await step(state, `read-edited-text ${kind}`, mode, () => readEditedText(cdp, kind, after));
				out.contentUpdated[kind] = isObj(read) ? read.updated : UNOBSERVABLE;
				out.contentUpdatedMethod[kind] = isObj(read) ? read.method : UNOBSERVABLE;
			}
			await step(state, "stop-recorder", mode, () => call(cdp, "stopRecorder", `edit|${mode}`));
			await step(state, "restore-sources", mode, async () => restoreSources(vault));
		}
	});
}

async function runLazy(args, state, vault) {
	await withCdp(args, state, async (cdp) => {
		await step(state, "wait-indexed", null, () => waitFileReady(cdp, HOST_51, vault));
		for (const mode of selectedModes(args)) {
			console.log(`lazy rendering, 51 embeds (${MODES[mode].label})`);
			const data = modeData(state, mode);
			data.lazy = await step(state, "lazy-sample", mode, async () => {
				const samples = await call(cdp, "openAndSample", HOST_51, mode, [0, 1000, 5000]);
				await call(cdp, "closeLeavesFor", HOST_51);
				return { embedsInHost: 51, samples };
			});
		}
	});
}

async function runHover(args, state) {
	await withCdp(args, state, async (cdp) => {
		console.log("hover preview");
		state.hover = await step(state, "hover-preview", null, async () => {
			await step(state, "wait-indexed", null, () => waitFileReady(cdp, HOVER_HOST, state.vault));
			await call(cdp, "openPlain", HOVER_HOST, "rv");
			const { x, y } = await call(cdp, "hoverLinkRect", HOVER_HOST);
			await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
			await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
			await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 2, y });
			await sleep(3500);
			const popovers = await call(cdp, "hoverPopovers");
			await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
			await call(cdp, "closeLeavesFor", HOVER_HOST);
			return { popovers, opened: popovers.length > 0 };
		});
	});
}

async function runCleanup(args, state, vault) {
	await step(state, "cleanup", null, async () => {
		await withCdp(args, state, async (cdp) => {
			await call(cdp, "closeProbeLeaves", `${FOLDER}/`);
			await call(cdp, "clearFoldKeys");
		});
	});
	removeFixtureFolder(vault);
	await sleep(500);
	if (state.preSnapshot) {
		// The fixture folder is outside the snapshot (the probe owns it), so its absence is checked
		// on its own: a vault is restored only if every other file matches and the folder is gone.
		const now = vaultSnapshot(vault);
		state.fixtureRestored = JSON.stringify(Object.entries(now).sort()) === JSON.stringify(Object.entries(state.preSnapshot).sort()) && !existsSync(join(vault, FOLDER));
	} else state.fixtureRestored = null;
	console.log(`cleanup: vault restored = ${state.fixtureRestored}`);
}

// ---- verdicts ----------------------------------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === "object";

export function comboFor(state, mode, kind) {
	const m = state.modes[mode] ?? {};
	const { key, item } = KINDS[kind];
	const fold = m.folds?.[kind];
	const snapEmbed = embedByKey(m.snapshotBeforeFold, key);
	const reopen = m.reopen;
	const edit = m.edit;
	const render = isObj(m.render) ? m.render[key] : null;
	const reopenRender = isObj(reopen?.render) ? reopen.render[key] : null;
	const editRender = isObj(edit?.render) ? edit.render[key] : null;
	const drive = reopen?.drive?.[kind];

	const clickSeen = isObj(fold) && Array.isArray(fold.events) && fold.events.some((e) => e.type === "click" && e.isTrusted === true);
	const stateChanged = isObj(fold) && fold.changed === true;
	const driven = isObj(drive) && drive.changed === true;
	const rendered = !!snapEmbed && snapEmbed.rendered === true;
	const toggleFound = !!snapEmbed && snapEmbed.toggles.some((t) => t.label.startsWith(item));
	const renderObserved = !!render && render.firstEventMs != null;
	const rerenderObserved = !!editRender && editRender.bursts >= 1;

	const unobservable = [];
	if (!snapEmbed) unobservable.push("the embed could not be located in the host DOM");
	if (!isObj(fold)) unobservable.push("the real click step did not complete");
	if (!isObj(drive)) unobservable.push("the synthetic-click step did not complete");
	if (!renderObserved) unobservable.push("no render events were captured for the embed");
	if (!rerenderObserved) unobservable.push("no re-render was captured after the external source edit");
	const retainedReopen = reopen?.retained?.[kind] ?? UNOBSERVABLE;
	const retainedEdit = edit?.retained?.[kind] ?? UNOBSERVABLE;
	const contentUpdated = edit?.contentUpdated?.[kind] ?? UNOBSERVABLE;
	const retainedReopenWhy = reopen?.retainedReason?.[kind] ?? "the close-and-reopen step did not run";
	const retainedEditWhy = edit?.retainedReason?.[kind] ?? "the external-edit step did not run";
	if (retainedReopen === UNOBSERVABLE) unobservable.push(`what Obsidian keeps across closing and reopening the host: ${retainedReopenWhy}`);
	if (retainedEdit === UNOBSERVABLE) unobservable.push(`what Obsidian keeps across an external source edit: ${retainedEditWhy}`);
	if (contentUpdated === UNOBSERVABLE) unobservable.push("whether the embed showed the edited source text could not be read");

	const toggleEl = snapEmbed ? toggleDescription(snapEmbed, item) : null;
	const combo = {
		hostMode: MODES[mode].id,
		kind,
		verdict: "supported",
		reason: null,
		toggle: {
			selector: toggleEl,
			foundItems: snapEmbed ? snapEmbed.toggles.map((t) => ({ type: t.type, label: t.label })) : UNOBSERVABLE,
			stateSignal: "is-collapsed class on the .collapse-indicator and on its owning li or heading",
		},
		clickEvents: isObj(fold) ? eventSignature(fold.events) : UNOBSERVABLE,
		clickChangedState: isObj(fold) ? stateChanged : UNOBSERVABLE,
		syntheticClickChangedState: isObj(drive) ? driven : UNOBSERVABLE,
		render: renderObserved
			? { firstEventMs: render.firstEventMs, loadedMs: render.loadedMs, firstRenderSettledMs: render.firstRenderSettledMs, bursts: render.bursts, replacedElements: render.replacedElements }
			: UNOBSERVABLE,
		reopenRender: reopenRender ? { firstEventMs: reopenRender.firstEventMs, loadedMs: reopenRender.loadedMs, firstRenderSettledMs: reopenRender.firstRenderSettledMs, bursts: reopenRender.bursts } : UNOBSERVABLE,
		rerenderAfterSourceEdit: editRender
			? { bursts: editRender.bursts, burstStartsMs: editRender.burstStartsMs, replacedElements: editRender.replacedElements }
			: isObj(edit) && isObj(edit.render)
				? { bursts: 0, burstStartsMs: [], replacedElements: 0 }
				: UNOBSERVABLE,
		retainedAcrossReopen: retainedReopen,
		retainedAcrossReopenWhy: retainedReopen === UNOBSERVABLE ? retainedReopenWhy : null,
		retainedAcrossSourceEdit: retainedEdit,
		retainedAcrossSourceEditWhy: retainedEdit === UNOBSERVABLE ? retainedEditWhy : null,
		sourceContentUpdatedAfterEdit: contentUpdated,
		sourceContentReadMethod: edit?.contentUpdatedMethod?.[kind] ?? UNOBSERVABLE,
		unobservable,
	};

	const reasons = [];
	if (!snapEmbed) reasons.push("the probe could not observe the embed in the host (see stepErrors)");
	else if (!rendered) reasons.push("the embed did not render in the host");
	if (rendered && !toggleFound) reasons.push(`no fold toggle was found for "${item}" inside the embed`);
	if (reasons.length) {
		combo.verdict = "unsupported";
		combo.reason = `${reasons.join("; ")}${unobservable.length ? ` (${unobservable.join("; ")})` : ""}`;
		return combo;
	}
	if (!(clickSeen && stateChanged)) reasons.push("a real click on the toggle was not observed as a click that changes fold state");
	if (!driven) reasons.push("a synthetic click on the toggle was not observed to change fold state, so the fold cannot be driven");
	if (!renderObserved) reasons.push("render timing could not be observed");
	if (!rerenderObserved) reasons.push("a re-render after a source edit could not be observed");
	if (retainedReopen === UNOBSERVABLE) reasons.push(`what Obsidian keeps across closing and reopening the host could not be observed (${retainedReopenWhy})`);
	if (retainedEdit === UNOBSERVABLE) reasons.push(`what Obsidian keeps across an external source edit could not be observed (${retainedEditWhy})`);
	if (contentUpdated === UNOBSERVABLE) reasons.push("whether the embed showed the externally edited source text could not be read");
	else if (contentUpdated === false) reasons.push(`the embed did not show the externally edited source text (read ${combo.sourceContentReadMethod}), so a fold kept across the edit cannot be shown to apply to the new content`);
	if (reasons.length) {
		combo.verdict = "partial";
		combo.reason = reasons.join("; ");
	}
	return combo;
}

function toggleDescription(snapEmbed, item) {
	const t = snapEmbed.toggles.find((x) => x.label.startsWith(item));
	if (!t) return null;
	return t.type === "heading"
		? "h1-h6 > .heading-collapse-indicator.collapse-indicator"
		: "li > .list-collapse-indicator.collapse-indicator";
}

const LEAK_PLACES = {
	sourceNoteOpensFolded: "the source note opened on its own",
	secondEmbedInSecondHostFolded: "the same embed in a second host note",
	secondEmbedOfSameNoteInSameHostFolded: "the `![](x.md)` embed of the same note in the same host, after the host was reopened",
};

/** One kind in one host mode: where (if anywhere) its fold showed up outside the embed it was made in. */
function foldMemoryForKind(kind, k) {
	if (!isObj(k)) return { answer: UNOBSERVABLE, reason: "the fold-memory step for this kind did not complete (see stepErrors)" };
	const reading = (r) => (isObj(r) && typeof r.collapsed === "boolean" ? r.collapsed : UNOBSERVABLE);
	const folded = (r) => (isObj(r) && typeof r.folded === "boolean" ? r.folded : UNOBSERVABLE);
	const keyed = (k.storageKeys ?? []).filter((key) => key.endsWith(`-note-fold-${KINDS[kind].source}`));
	const checks = {
		sourceNoteOpensFolded: reading(k.sourceNote),
		secondEmbedInSecondHostFolded: folded(k.secondHost),
		secondEmbedOfSameNoteInSameHostFolded: k.sameHost === NOT_APPLICABLE ? NOT_APPLICABLE : folded(k.sameHost),
	};
	const out = { obsidianWritesKeyForSourceNote: keyed.length > 0, storageKeys: keyed, ...checks };
	if (k.folded !== true) return { ...out, answer: UNOBSERVABLE, reason: "the item was not folded when the checks ran, so a fold that did not show up proves nothing" };
	const leakedTo = Object.keys(LEAK_PLACES).filter((c) => checks[c] === true);
	if (leakedTo.length) return { ...out, answer: "refuted", leakedTo: leakedTo.map((c) => LEAK_PLACES[c]) };
	const unread = Object.keys(LEAK_PLACES).filter((c) => checks[c] === UNOBSERVABLE);
	if (unread.length) return { ...out, answer: UNOBSERVABLE, reason: `could not be read: ${unread.map((c) => LEAK_PLACES[c]).join("; ")}` };
	return { ...out, answer: "confirmed" };
}

/**
 * The E10 question, answered per embed kind and host mode, then overall. One kind leaking is enough
 * to refute Dan's observation overall (the statement names the kinds that leak and the kinds that
 * do not); it is "confirmed" only if every kind in every mode was read and none leaked.
 */
export function foldMemoryAnswer(state) {
	const perMode = {};
	for (const mode of Object.keys(state.modes)) {
		const memory = state.modes[mode].memory;
		perMode[mode] = Object.fromEntries(KIND_IDS.map((kind) => [kind, foldMemoryForKind(kind, isObj(memory) && isObj(memory.kinds) ? memory.kinds[kind] : null)]));
	}
	const answers = Object.values(perMode).flatMap((kinds) => Object.values(kinds));
	const perKind = Object.fromEntries(
		KIND_IDS.map((kind) => {
			const mine = Object.values(perMode).map((kinds) => kinds[kind].answer);
			return [kind, mine.length === 0 ? UNOBSERVABLE : mine.includes("refuted") ? "refuted" : mine.includes(UNOBSERVABLE) ? UNOBSERVABLE : "confirmed"];
		})
	);
	const group = (answer) => KIND_IDS.filter((kind) => perKind[kind] === answer).map((kind) => kindLabel(kind));
	const refuted = group("refuted");
	const unknown = group(UNOBSERVABLE);
	const confirmed = group("confirmed");
	const leaks = refuted.map((label) => {
		const kind = KIND_IDS.find((x) => kindLabel(x) === label);
		const places = new Set(Object.values(perMode).flatMap((kinds) => kinds[kind].leakedTo ?? []));
		return `${label}: the fold also showed up in ${[...places].join("; ")}`;
	});
	const keyedToSource = answers.some((p) => p.obsidianWritesKeyForSourceNote === true);
	let danObservation;
	let statement;
	if (refuted.length) {
		danObservation = "refuted";
		statement = `Refuted for ${refuted.join(", ")}. Folded on its own, ${leaks.join(". ")}. So Obsidian's own fold memory is not independent of the source note for ${refuted.length > 1 ? "those kinds" : "that kind"}.`;
		if (confirmed.length) statement += ` Confirmed independent for ${confirmed.join(", ")}.`;
		if (unknown.length) statement += ` Could not be read for ${unknown.join(", ")}.`;
	} else if (answers.length === 0 || unknown.length) {
		danObservation = UNOBSERVABLE;
		statement = `The experiment could not be completed for ${(unknown.length ? unknown : ["any embed kind"]).join(", ")}, so Dan's observation is neither confirmed nor refuted for them.${confirmed.length ? ` Confirmed independent for ${confirmed.join(", ")}.` : ""}`;
	} else {
		danObservation = "confirmed";
		statement = `Confirmed for ${confirmed.join(", ")} in every host mode probed: ${keyedToSource ? "Obsidian does write a fold-memory entry keyed to the source note's path when a fold is clicked inside an embed, but" : "Obsidian wrote no fold-memory entry for the source note, and"} neither the source note opened on its own nor a second embed of the same content picked the fold up.`;
	}
	return {
		question: "Is Obsidian's embed fold memory keyed to the source note?",
		keyedToSourceNote: answers.length === 0 ? UNOBSERVABLE : keyedToSource,
		danObservation,
		perKind,
		statement,
		perMode,
	};
}

export function buildReport(state) {
	const modes = Object.keys(MODES);
	const combinations = [];
	for (const mode of modes) for (const kind of KIND_IDS) combinations.push(comboFor(state, mode, kind));

	const verdicts = {};
	for (const c of combinations) {
		verdicts[c.hostMode] ??= {};
		verdicts[c.hostMode][c.kind] = c.verdict === "supported" ? { verdict: "supported" } : { verdict: c.verdict, reason: c.reason };
	}

	const extras = {};
	for (const mode of modes) {
		const snap = state.modes[mode]?.snapshotBeforeFold;
		extras[MODES[mode].id] = {};
		for (const { name, src } of HOST_EMBED_ORDER) {
			const e = snap && snap.embeds ? snap.embeds.find((x) => x.src === src) : null;
			extras[MODES[mode].id][name] = e
				? { tag: e.tag, classes: e.classes, dataType: e.dataType, isNoteEmbed: e.isNoteEmbed, rendered: e.rendered, nestedEmbeds: e.nestedEmbeds, detectedAsHost: e.detected, toggleCount: e.toggles.length }
				: UNOBSERVABLE;
		}
	}

	const detection = {};
	for (const mode of modes) {
		const snap = state.modes[mode]?.snapshotBeforeFold;
		const block = snap && snap.embeds ? snap.embeds.find((x) => x.key === KINDS.block.key) : null;
		detection[MODES[mode].id] = block ? { lesson8BlockEmbedDetected: !!block.detected, detectedAs: block.detected } : { lesson8BlockEmbedDetected: UNOBSERVABLE, detectedAs: UNOBSERVABLE };
	}

	const lazy = {};
	for (const mode of modes) lazy[MODES[mode].id] = state.modes[mode]?.lazy ?? UNOBSERVABLE;

	return {
		schemaVersion: 1,
		generatedBy: "scripts/e2e-embed-probe.mjs",
		generatedAt: new Date().toISOString(),
		obsidianVersion: state.obsidian?.obsidianVersion ?? UNOBSERVABLE,
		verdicts,
		combinations,
		foldMemory: foldMemoryAnswer(state),
		fixtureCoverage: extras,
		hostDetection: detection,
		lazyRendering: lazy,
		hoverPreview: state.hover ?? UNOBSERVABLE,
		fixtureRestored: state.fixtureRestored,
		stepErrors: state.stepErrors,
	};
}

// ---- docs ---------------------------------------------------------------------------------------------
const modeLabel = (id) => (id === "live-preview" ? "Live Preview" : "Reading view");
const kindLabel = (kind) => KINDS[kind].label;
const yesNo = (v) => (v === UNOBSERVABLE ? UNOBSERVABLE : v ? "yes" : "no");
const ms = (v) => (v === null || v === undefined ? "n/a" : `${v} ms`);

/** What the lazy-rendering numbers do and do not show (PR-2 R5). */
export const LAZY_NOTE =
	"In Live Preview the count can go down between samples (more embeds rendered at 0 s than at 1 s and 5 s). This is most likely CodeMirror 6 virtualising the viewport: embeds that scroll out of view are unmounted, and rendered again when they scroll back, so an embed's element and its fold arrows can disappear and be recreated while the host stays open. Render handling must therefore treat a Live Preview embed that appears again as a new render, not only the first one. This is inferred, not measured: no sample was taken while scrolling.";

/** The caveat on a "no" for block and heading embeds: the edit phase folds all three kinds before
 * the external edit, and block and heading embeds of one note share Obsidian's per-note fold
 * entry (PR-2 R8), so one can overwrite the other. Empty for every other reading. */
export function editRetentionCaveat(combo) {
	if (combo.retainedAcrossSourceEdit !== false) return "";
	if (combo.kind !== "block" && combo.kind !== "heading") return "";
	return " (caveat: all three kinds were folded together before this edit, and block and heading embeds of one note share Obsidian's per-note fold entry, so this no may be interference from the other kind and not how Obsidian treats this kind alone; the reopen check measures each kind on its own)";
}

export function gapsMarkdown(report) {
	const gaps = report.combinations.filter((c) => c.verdict !== "supported");
	const lines = [
		"# Embed fold support: gaps for the 0.2.0 release notes",
		"",
		"Generated by `scripts/e2e-embed-probe.mjs` from `docs/embed-probe.json`. Each line is a combination of host mode and embed kind that the probe could not show to be fully supported; raise them with Dan at Review.",
		"",
	];
	if (gaps.length === 0) {
		lines.push("No gaps: all six combinations (Live Preview and Reading view, times block, heading and whole-note embeds) are supported.", "");
	} else {
		for (const c of gaps) lines.push(`- ${modeLabel(c.hostMode)}, ${kindLabel(c.kind)} (${c.verdict}): ${c.reason}`);
		lines.push("");
	}
	return lines.join("\n");
}

export function reportMarkdown(report) {
	const L = [];
	L.push("# E10/G18: how Obsidian exposes embed folds, proven against real Obsidian", "");
	L.push(`Obsidian version: ${report.obsidianVersion}. Generated by \`scripts/e2e-embed-probe.mjs\` (\`npm run test:e2e:embed-probe\`) at ${report.generatedAt}.`, "");
	L.push("## Verdicts", "", "| Host mode | Block embed | Heading embed | Whole-note embed |", "|---|---|---|---|");
	for (const hostMode of ["live-preview", "reading-view"]) {
		const v = report.verdicts[hostMode];
		L.push(`| ${modeLabel(hostMode)} | ${v.block.verdict} | ${v.heading.verdict} | ${v["whole-note"].verdict} |`);
	}
	L.push("");
	const gaps = report.combinations.filter((c) => c.verdict !== "supported");
	if (gaps.length) for (const c of gaps) L.push(`- ${modeLabel(c.hostMode)}, ${kindLabel(c.kind)} (${c.verdict}): ${c.reason}`);
	else L.push("Every combination is supported: no gaps (see `docs/embed-release-gaps.md`).");
	L.push("", "## Fold toggle: element, events, state", "");
	L.push("In both host modes an embedded note is a reading-style render inside `.internal-embed.markdown-embed`. List items carry a `.list-collapse-indicator` and headings a `.heading-collapse-indicator`; folding sets `is-collapsed` on the indicator and on its owning `li` or heading, and hides the child list.", "");
	for (const c of report.combinations) {
		L.push(`### ${modeLabel(c.hostMode)}, ${kindLabel(c.kind)}: ${c.verdict}`, "");
		L.push(`- Toggle: \`${c.toggle.selector ?? UNOBSERVABLE}\``);
		L.push(`- Toggles found: ${Array.isArray(c.toggle.foundItems) ? c.toggle.foundItems.map((t) => `${t.type} "${t.label}"`).join(", ") : UNOBSERVABLE}`);
		L.push(`- Events seen on a real click (capture phase on the embed): ${Array.isArray(c.clickEvents) ? c.clickEvents.join(", ") : UNOBSERVABLE}`);
		L.push(`- A real click changed fold state: ${yesNo(c.clickChangedState)}; a synthetic click changed it: ${yesNo(c.syntheticClickChangedState)}`);
		if (c.render !== UNOBSERVABLE) L.push(`- First render: first mutation ${ms(c.render.firstEventMs)}, \`is-loaded\` at ${ms(c.render.loadedMs)}, first burst settled ${ms(c.render.firstRenderSettledMs)}, ${c.render.bursts} burst(s), element replaced ${c.render.replacedElements} time(s)`);
		else L.push(`- First render: ${UNOBSERVABLE}`);
		if (c.reopenRender !== UNOBSERVABLE) L.push(`- Render after reopening the host: first mutation ${ms(c.reopenRender.firstEventMs)}, settled ${ms(c.reopenRender.firstRenderSettledMs)}, ${c.reopenRender.bursts} burst(s)`);
		if (c.rerenderAfterSourceEdit !== UNOBSERVABLE) L.push(`- Re-render after an external source edit: ${c.rerenderAfterSourceEdit.bursts} burst(s) at ${c.rerenderAfterSourceEdit.burstStartsMs.map((x) => `${x} ms`).join(", ") || "n/a"} after observation started; element replaced ${c.rerenderAfterSourceEdit.replacedElements} time(s)`);
		else L.push(`- Re-render after an external source edit: ${UNOBSERVABLE}`);
		L.push(`- Obsidian kept the fold across closing and reopening the host: ${yesNo(c.retainedAcrossReopen)}${c.retainedAcrossReopenWhy ? ` (${c.retainedAcrossReopenWhy})` : ""}`);
		L.push(`- Obsidian kept the fold across an external edit of the source: ${yesNo(c.retainedAcrossSourceEdit)}${c.retainedAcrossSourceEditWhy ? ` (${c.retainedAcrossSourceEditWhy})` : ""}${editRetentionCaveat(c)}; embed showed the edited text: ${yesNo(c.sourceContentUpdatedAfterEdit)} (read ${c.sourceContentReadMethod})`);
		if (c.unobservable.length) L.push(`- Unobservable: ${c.unobservable.join("; ")}`);
		L.push("");
	}
	const fm = report.foldMemory;
	L.push("## Is Obsidian's embed fold memory keyed to the source note?", "", `**${fm.danObservation}.** ${fm.statement}`, "");
	L.push("Answer per embed kind: " + Object.entries(fm.perKind).map(([kind, a]) => `${kindLabel(kind)} ${a}`).join("; ") + ". Each kind was folded on its own in a clean host, then looked for in the source note opened by itself, in the same embed in a second host note, and (whole-note only) in the `![](x.md)` embed of the same note in the same host after reopening it.", "");
	for (const [mode, kinds] of Object.entries(fm.perMode)) {
		for (const [kind, p] of Object.entries(kinds)) {
			L.push(`- ${modeLabel(MODES[mode]?.id ?? mode)}, ${kindLabel(kind)}: ${p.answer}${p.leakedTo ? ` (also showed up in: ${p.leakedTo.join("; ")})` : ""}${p.reason ? ` (${p.reason})` : ""}. Source note opened folded: ${p.sourceNoteOpensFolded}; second host folded: ${p.secondEmbedInSecondHostFolded}; same-host second embed folded: ${p.secondEmbedOfSameNoteInSameHostFolded}; Obsidian wrote a key for the source note: ${p.obsidianWritesKeyForSourceNote}`);
		}
	}
	L.push("", "## Fixture coverage (host mode, embed kind, element)", "");
	for (const [hostMode, kinds] of Object.entries(report.fixtureCoverage)) {
		L.push(`### ${modeLabel(hostMode)}`, "");
		for (const [name, e] of Object.entries(kinds)) {
			L.push(e === UNOBSERVABLE ? `- ${name}: ${UNOBSERVABLE}` : `- ${name}: \`${e.tag}.${e.classes.join(".")}\`, note embed: ${e.isNoteEmbed}, rendered: ${e.rendered}, toggles: ${e.toggleCount}, nested embeds inside: ${e.nestedEmbeds}, container rule: ${e.detectedAsHost ? `host (${e.detectedAsHost.mode})` : "ignored"}`);
		}
		L.push("");
	}
	L.push("## Host detection (GP1)", "");
	for (const [hostMode, d] of Object.entries(report.hostDetection)) L.push(`- ${modeLabel(hostMode)}: Lesson 8 block embed detected as an embed host: ${yesNo(d.lesson8BlockEmbedDetected)}`);
	L.push("", "## Lazy rendering: 51-embed host", "", "Counts are top-level embeds present in the DOM and rendered, sampled after the view finished opening.", "", LAZY_NOTE, "");
	for (const [hostMode, l] of Object.entries(report.lazyRendering)) {
		if (l === UNOBSERVABLE) L.push(`- ${modeLabel(hostMode)}: ${UNOBSERVABLE}`);
		else L.push(`- ${modeLabel(hostMode)}: ${l.samples.map((s) => `${s.atMs / 1000} s: ${s.rendered}/${l.embedsInHost} rendered (${s.inDom} in DOM)`).join("; ")}`);
	}
	L.push("", "## Hover preview (E13)", "");
	const h = report.hoverPreview;
	if (h === UNOBSERVABLE || !h.opened) L.push(`- ${UNOBSERVABLE}: no hover popover could be opened.`);
	else for (const p of h.popovers) L.push(`- Popover with ${p.embeds} embed(s) (${p.loadedNoteEmbeds} rendered note embeds). Inside a workspace Markdown view: ${p.insideWorkspaceMarkdownView}. The container rule ignores it: ${!p.insideWorkspaceMarkdownView}.`);
	L.push("", "## Housekeeping", "", `- Fixture vault restored (no file outside \`.obsidian/\` changed): ${report.fixtureRestored}`);
	if (report.stepErrors.length) {
		L.push("- Steps that threw or timed out (recorded as unobservable):");
		for (const e of report.stepErrors) L.push(`  - ${e.step}${e.mode ? ` (${e.mode})` : ""}: ${e.error}`);
	} else L.push("- No step threw or timed out.");
	L.push("");
	return L.join("\n");
}

export function writeReports(args, report, docsDir = DOCS) {
	const json = JSON.stringify(report, null, 2) + "\n";
	if (!args.writeDocs) return;
	mkdirSync(docsDir, { recursive: true });
	writeFileSync(join(docsDir, "embed-probe.json"), json, "utf8");
	writeFileSync(join(docsDir, "embed-probe.md"), reportMarkdown(report), "utf8");
	writeFileSync(join(docsDir, "embed-release-gaps.md"), gapsMarkdown(report), "utf8");
}

// ---- driver -------------------------------------------------------------------------------------------
function selectedModes(args) {
	return args.mode === "both" ? ["lp", "rv"] : [args.mode];
}

async function prepare(args, state, fresh) {
	if (fresh) Object.assign(state, freshState());
	state.vault = await resolveVault(args);
	if (!existsSync(state.vault)) throw new Error(`vault directory not found: ${state.vault} (pass --vault)`);
	const info = await step(state, "connect", null, () =>
		withCdp(args, state, async (cdp) => call(cdp, "pluginInfo"))
	);
	if (info !== UNOBSERVABLE) {
		state.obsidian = info;
		if (basename(state.vault) !== info.vaultName) throw new Error(`--vault ${state.vault} is not the open vault "${info.vaultName}"`);
	}
	return info !== UNOBSERVABLE;
}

async function runAll(args, state, vault) {
	if (!(await prepare(args, state, true))) return;
	state.preSnapshot = vaultSnapshot(vault);
	installFixtures(vault);
	for (const mode of selectedModes(args)) {
		const one = { ...args, mode };
		await runSetup(one, state, vault);
		await runReopen(one, state);
		await runEdit(one, state, vault);
		await runLazy(one, state, vault);
	}
	await runHover(args, state);
}

async function runOnce(args, phase) {
	const state = phase === "all" ? freshState() : loadState(args.state);
	const vault = await resolveVault(args);
	if (!existsSync(vault)) throw new Error(`vault directory not found: ${vault} (pass --vault)`);
	// Before anything connects or writes: never touch an `embed-probe` folder this probe did not create.
	if (phase === "all" || phase === "setup" || phase === "cleanup") guardFixtureFolder(vault);
	state.vault = vault;
	args = { ...args };
	try {
		if (phase === "all") {
			await runAll(args, state, vault);
		} else if (phase === "setup") {
			if (!(await prepare(args, state, false))) return state;
			state.preSnapshot ??= vaultSnapshot(vault);
			installFixtures(vault);
			await runSetup(args, state, vault);
		} else if (phase === "reopen") await runReopen(args, state);
		else if (phase === "edit") await runEdit(args, state, vault);
		else if (phase === "lazy") await runLazy(args, state, vault);
		else if (phase === "hover") await runHover(args, state);
	} catch (err) {
		state.stepErrors.push({ step: `phase ${phase}`, mode: null, error: String(err && err.message ? err.message : err) });
		console.warn(`phase ${phase} failed: ${err && err.message ? err.message : err}`);
	}
	if (phase === "all" || phase === "cleanup") {
		try {
			await runCleanup(args, state, vault);
		} catch (err) {
			state.stepErrors.push({ step: "cleanup", mode: null, error: String(err && err.message ? err.message : err) });
		}
	}
	saveState(args.state, state);
	return state;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) return printUsage();
	const phase = args.phase ?? "all";
	if (!PHASES.includes(phase) || !["lp", "rv", "both"].includes(args.mode)) {
		printUsage();
		process.exitCode = 1;
		return;
	}

	let lastVerdicts = null;
	let report = null;
	for (let run = 1; run <= args.repeat; run++) {
		if (args.repeat > 1) console.log(`--- run ${run} of ${args.repeat}`);
		const state = await runOnce(args, phase);
		report = buildReport(state);
		const verdicts = JSON.stringify(report.verdicts);
		if (lastVerdicts !== null && verdicts !== lastVerdicts) {
			console.error("verdicts differ between runs:\n", lastVerdicts, "\n", verdicts);
			process.exitCode = 1;
		}
		lastVerdicts = verdicts;
		if (args.repeat > 1 && report.fixtureRestored === false) process.exitCode = 1;
	}

	// The report phase (and the end of `all`) always writes both documents, even if steps failed.
	if (phase === "all" || phase === "report" || phase === "cleanup") {
		writeReports(args, report);
		if (args.writeDocs) console.log(`Wrote docs/embed-probe.json, docs/embed-probe.md and docs/embed-release-gaps.md (state: ${args.state})`);
	}
	for (const c of report.combinations) console.log(`${modeLabel(c.hostMode)} / ${kindLabel(c.kind)}: ${c.verdict}${c.reason ? ` (${c.reason})` : ""}`);
	console.log(`Dan's observation (embed folds are independent): ${report.foldMemory.danObservation}`);
	if (report.fixtureRestored === false) process.exitCode = 1;
}

// Imported by tests/unit/embed-probe-logic.test.ts for its pure functions: only run as a script.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error("e2e-embed-probe failed:", err);
		process.exitCode = 1;
	});
}
