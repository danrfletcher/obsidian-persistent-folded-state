#!/usr/bin/env node
/**
 * PR-8 (ticket warkworth-21) end to end against a real, already-running Obsidian: embed records
 * follow renames, a folder move, a heading rename and deletes (G10, G11, G17), and an embed folded
 * before each step is still folded when the host is reopened after it (GP3 guard). Container-only:
 * it needs the obsidian-development-template container of `use-desktop-container.md`, this plugin
 * built and enabled, and Obsidian started with --remote-debugging-port. The tester runs it; it is
 * not part of `npm test` (its `.e2e.ts` name does not match vitest's `tests/**\/*.test.ts`) and
 * the coder turn could not run it: there is no Obsidian in the coder's environment.
 *
 * Renames, moves and deletes go through Obsidian's own API over CDP (`app.fileManager.renameFile`,
 * `app.vault.delete`), the same real vault-event path a file-explorer action takes, exactly as
 * tests/e2e/rename-delete.e2e.ts does (see its file comment for that judgement call). The folds are
 * made by a trusted mouse click on the embed's own arrow (`Input.dispatchMouseEvent`), as
 * tests/e2e/embed-restore.e2e.ts does, at a point on the arrow that is not the task checkbox over
 * its centre. The heading rename is made the way Dan makes it: Obsidian's own "Rename this
 * heading..." command (`editor:rename-heading`) on the heading line of the open source note, its
 * dialog filled in and saved, after which Obsidian itself rewrites the host's `![[Source#Heading]]`
 * link (editing the heading line directly does not rewrite links). If Obsidian does not rewrite it
 * within --link-wait-ms, the step reports that and fails: there is no migration to test without
 * the rewrite.
 *
 * Obsidian asks "Update links?" before a rename unless its "Automatically update internal links"
 * setting is on, and that prompt blocks `renameFile` for ever over CDP, so the script turns the
 * setting on for its run and puts it back afterwards. It also starts clean: it answers a prompt
 * a failed run left open, closes stale panes of the two notes, deletes them and what it renames
 * them to, restarts the plugin over no data.json and copies the fixture in again.
 *
 * Fixture (tests/fixtures/embed-lifecycle/, copied by this script to --vault-root, which starts
 * without these two notes, with a fresh data.json): "Lifecycle Host.md" embeds
 * `![[Lifecycle Source#^0169a6]]` (block), `![[Lifecycle Source#Lesson 8]]` (heading) and
 * `![[Lifecycle Source]]` (whole note). One row is folded in each: "Lesson 8" in the block embed,
 * "Count word frequency" in the heading embed, "Lesson 9" in the whole-note embed.
 *
 * One continuous sequence, no relaunch:
 *   1. copy the fixture, open the host, fold one row in each of the three embeds, assert data.json
 *      holds three embed records for the host and keep the source note's own `files` entry.
 *   2. rename the source note: every record's target moves, subpath/occurrence/folds/hash do not;
 *      reopen the host, all three embeds still show their fold.
 *   3. rename the host: records re-key to the new host; reopen, folds intact.
 *   4. move both notes into a new folder, then rename that folder: both paths re-key by prefix.
 *   5. rename the heading "Lesson 8" in the source editor: the heading embed's record moves to the
 *      new subpath with no dormant stamp and no dormant anchors; the block and whole-note records do
 *      not change; reopen, the heading embed's fold is still shown.
 *   6. delete the source, then the host: no `embeds` entry names either (G11), and the Forget
 *      command still runs.
 * Obsidian itself rewrites the host's links when a note or heading is renamed, so the notes' bytes on
 * disk legitimately change in steps 2 to 5; this script does not assert them (the plugin's own
 * no-write rule is checked by the unit and fence tests).
 *
 * The clean start deletes notes and data.json, so it first checks (scripts/lib/test-vault-guard.mjs)
 * that --vault-root is a test vault (named test-vault, or holding a .pfs-test-vault file) and is the
 * vault the connected Obsidian has open, and that --data is that vault's own
 * .obsidian/plugins/<id>/data.json (the file it deletes), and stops if not.
 *
 * Usage: node tests/e2e/embed-rename-delete.e2e.ts [--cdp-port 9222] [--vault-root /config/test-vault]
 *   [--data <path>] [--screenshots screenshots] [--wait-ms 1500] [--link-wait-ms 15000] [--help]
 * Or `npm run test:e2e:embed-rename-delete`.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertDataFileInVault, assertTestVault } from "../../scripts/lib/test-vault-guard.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "embed-lifecycle");
const PLUGIN_ID = "persistent-folded-state";
const FORGET_COMMAND = `${PLUGIN_ID}:forget-note-folds`;
const HOST_NAME = "Lifecycle Host";
const SOURCE_NAME = "Lifecycle Source";
const BLOCK_SUBPATH = "^0169a6";
const HEADING = "Lesson 8";
const RENAMED_HEADING = "Lesson 8 (revised)";
const BLOCK_ROW = "Lesson 8";
const HEADING_ROW = "Count word frequency";
const WHOLE_ROW = "Lesson 9";

// --- CDP (own copy: see the file comment) ------------------------------------------------------

interface CdpTarget {
	type: string;
	webSocketDebuggerUrl?: string;
}

interface CdpConnection {
	send: (method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<unknown>;
	close: () => void;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findDebuggableTarget(cdpPort: number): Promise<CdpTarget> {
	const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
	if (!res.ok) throw new Error(`CDP target list request failed: HTTP ${res.status}`);
	const targets = (await res.json()) as CdpTarget[];
	const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
	if (!target) throw new Error("no debuggable Obsidian window found on that CDP port");
	return target;
}

async function findWithRetry(cdpPort: number, retries: number, delayMs: number): Promise<CdpTarget> {
	let lastErr: unknown;
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			return await findDebuggableTarget(cdpPort);
		} catch (err) {
			lastErr = err;
			await sleep(delayMs);
		}
	}
	throw new Error(`no debuggable Obsidian window on port ${cdpPort} after ${retries} retries: ${String(lastErr)}`);
}

function connectCdp(url: string): CdpConnection {
	const ws = new WebSocket(url);
	let nextId = 1;
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
	let closed = false;
	const rejectAll = (err: Error): void => {
		for (const { reject } of pending.values()) reject(err);
		pending.clear();
	};
	ws.addEventListener("message", (event: MessageEvent) => {
		const message = JSON.parse(String(event.data)) as { id?: number; error?: { message: string }; result?: unknown };
		if (message.id === undefined || !pending.has(message.id)) return;
		const entry = pending.get(message.id);
		pending.delete(message.id);
		if (!entry) return;
		if (message.error) entry.reject(new Error(message.error.message));
		else entry.resolve(message.result);
	});
	ws.addEventListener("close", () => {
		closed = true;
		rejectAll(new Error("CDP socket closed"));
	});
	ws.addEventListener("error", () => rejectAll(new Error("CDP socket error")));
	const ready = new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", (err) => reject(err instanceof Error ? err : new Error(String(err))));
	});
	async function send(method: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<unknown> {
		const timeoutMs = opts.timeoutMs ?? 15000;
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

async function evaluate(cdp: CdpConnection, expression: string): Promise<unknown> {
	await cdp.send("Runtime.enable");
	let result: { exceptionDetails?: unknown; result: { value: unknown } };
	try {
		result = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as typeof result;
	} catch (err) {
		throw new Error(`${String(err instanceof Error ? err.message : err)} while evaluating: ${expression.replace(/\s+/g, " ").trim().slice(0, 160)}`);
	}
	if (result.exceptionDetails) throw new Error(`Runtime.evaluate threw: ${JSON.stringify(result.exceptionDetails)}`);
	return result.result.value;
}

async function withConnection<T>(cdpPort: number, fn: (cdp: CdpConnection) => Promise<T>, retries = 1, retryDelayMs = 0): Promise<T> {
	const target = retries > 1 ? await findWithRetry(cdpPort, retries, retryDelayMs) : await findDebuggableTarget(cdpPort);
	if (!target.webSocketDebuggerUrl) throw new Error("debuggable target has no webSocketDebuggerUrl");
	const cdp = connectCdp(target.webSocketDebuggerUrl);
	try {
		return await fn(cdp);
	} finally {
		cdp.close();
	}
}

// --- page-side expressions shared with embed-restore.e2e.ts (own copy) ----------------------------

/** Text nodes directly under a row: the row's own text, not its children's. */
const ROW_TEXT = `(a) => Array.from(a.parentElement.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()`;

/** The markdown panes showing `path` that are on screen. A tab left behind by an earlier run is a
 * leaf of the same file with a zero-size, hidden view: reading or clicking in it finds nothing. */
function leavesOf(path: string): string {
	return `app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file && l.view.file.path === ${JSON.stringify(path)} && l.view.containerEl.getClientRects().length > 0)`;
}

/** Every markdown pane showing `path`, hidden stale tabs included: for closing them. */
function allLeavesOf(path: string): string {
	return `app.workspace.getLeavesOfType("markdown").filter((l) => l.view.file && l.view.file.path === ${JSON.stringify(path)})`;
}

/** Opens `path` in a new tab in Live Preview (mode source, source:false) or Reading view (preview). */
function openExpression(path: string, mode: "live-preview" | "reading-view"): string {
	return `(async () => {
		const file = app.vault.getFileByPath(${JSON.stringify(path)});
		if (!file) return { ok: false, reason: "no such note: " + ${JSON.stringify(path)} };
		const leaf = app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: ${JSON.stringify(mode === "reading-view" ? "preview" : "source")}, source: false }, active: true });
		return { ok: true };
	})()`;
}

function closeExpression(path: string): string {
	return `(() => {
		let n = 0;
		for (const leaf of ${allLeavesOf(path)}) { leaf.detach(); n++; }
		return n;
	})()`;
}

/** Flips every open pane of `path` to Reading view. */
function flipToReadingExpression(path: string): string {
	return `(async () => {
		let n = 0;
		for (const leaf of ${leavesOf(path)}) {
			const state = leaf.getViewState();
			state.state.mode = "preview";
			await leaf.setViewState(state);
			n++;
		}
		return n;
	})()`;
}

/** Every top-level embed of pane `pane` of `path`: its src and its own arrows with row text and state. */
function readEmbedsExpression(path: string, pane: number): string {
	return `(() => {
		const rowText = ${ROW_TEXT};
		const leaf = ${leavesOf(path)}[${pane}];
		if (!leaf) return JSON.stringify({ error: "no pane ${pane} of " + ${JSON.stringify(path)} });
		const EMBED = ".internal-embed.markdown-embed";
		const embeds = Array.from(leaf.view.containerEl.querySelectorAll(EMBED)).filter((e) => !e.parentElement.closest(EMBED));
		return JSON.stringify(embeds.map((embed) => ({
			src: embed.getAttribute("src"),
			arrows: Array.from(embed.querySelectorAll(".list-collapse-indicator, .heading-collapse-indicator"))
				.filter((a) => a.closest(EMBED) === embed)
				.map((a) => ({ row: rowText(a), collapsed: a.classList.contains("is-collapsed") })),
		})));
	})()`;
}

/** A point clearly on the arrow for the row starting with `row`, in the embed with src `src`, in a
 * pane. The arrow's centre is not used: for a task row the checkbox sits over it (an arrow 42 px
 * wide at x 613-655 has the checkbox at x 631-647), so a click there ticks the task instead of
 * folding. The point is the first of a few fractions of the arrow's width, from the left, at which
 * the topmost element is the arrow itself; `top` names what covers the arrow when none is. */
function arrowPointExpression(path: string, pane: number, src: string, row: string): string {
	return `(() => {
		const rowText = ${ROW_TEXT};
		const leaf = ${leavesOf(path)}[${pane}];
		if (!leaf) return null;
		const EMBED = ".internal-embed.markdown-embed";
		const embed = Array.from(leaf.view.containerEl.querySelectorAll(EMBED)).find((e) => e.getAttribute("src") === ${JSON.stringify(src)});
		if (!embed) return null;
		const arrow = Array.from(embed.querySelectorAll(".list-collapse-indicator, .heading-collapse-indicator")).find((a) => rowText(a).startsWith(${JSON.stringify(row)}));
		if (!arrow) return null;
		arrow.scrollIntoView({ block: "center" });
		const r = arrow.getBoundingClientRect();
		if (r.width === 0 || r.height === 0) return { x: 0, y: 0, onArrow: false, top: "arrow has no size" };
		const y = r.top + r.height / 2;
		for (const fraction of [0.2, 0.1, 0.3, 0.4]) {
			const x = r.left + r.width * fraction;
			const top = document.elementFromPoint(x, y);
			if (top && (top === arrow || arrow.contains(top))) return { x, y, onArrow: true, top: "" };
		}
		const x = r.left + r.width * 0.2;
		const top = document.elementFromPoint(x, y);
		return { x, y, onArrow: false, top: top ? top.tagName + "." + String(top.className) : "nothing" };
	})()`;
}

interface ArrowState {
	row: string;
	collapsed: boolean;
}
interface EmbedState {
	src: string;
	arrows: ArrowState[];
}

async function readEmbeds(cdp: CdpConnection, path: string, pane = 0): Promise<EmbedState[]> {
	const parsed = JSON.parse((await evaluate(cdp, readEmbedsExpression(path, pane))) as string) as EmbedState[] | { error: string };
	if (!Array.isArray(parsed)) throw new Error(parsed.error);
	return parsed;
}

/** Waits for the embed to render with arrows, then for the restore window, pass and re-check to run. */
async function waitForEmbed(cdp: CdpConnection, path: string, src: string, waitMs: number, pane = 0): Promise<EmbedState> {
	const deadline = Date.now() + 15000;
	for (;;) {
		try {
			const hit = (await readEmbeds(cdp, path, pane)).find((e) => e.src === src && e.arrows.length > 0);
			if (hit) {
				await sleep(waitMs);
				return (await readEmbeds(cdp, path, pane)).find((e) => e.src === src) ?? hit;
			}
		} catch {
			// the pane is not there yet
		}
		if (Date.now() > deadline) throw new Error(`embed ${src} never rendered with arrows in ${path}`);
		await sleep(250);
	}
}

interface ArrowPoint {
	x: number;
	y: number;
	onArrow: boolean;
	top: string;
}

/** A real mouse press and release on the arrow, as a person makes it: trusted events. */
async function realClickArrow(cdp: CdpConnection, path: string, pane: number, src: string, row: string): Promise<void> {
	const first = (await evaluate(cdp, arrowPointExpression(path, pane, src, row))) as ArrowPoint | null;
	if (!first) throw new Error(`no arrow "${row}" in embed ${src} of ${path} (pane ${pane})`);
	await sleep(300); // after scrollIntoView
	const point = ((await evaluate(cdp, arrowPointExpression(path, pane, src, row))) as ArrowPoint | null) ?? first;
	if (!point.onArrow) throw new Error(`arrow "${row}" in embed ${src} of ${path} has nothing of its own to click: covered by ${point.top}`);
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
	await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}


// --- CLI ---------------------------------------------------------------------------------------

interface Args {
	cdpPort: number;
	vaultRoot: string;
	data: string;
	screenshots: string;
	waitMs: number;
	linkWaitMs: number;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { cdpPort: 9222, vaultRoot: "/config/test-vault", data: "", screenshots: "screenshots", waitMs: 1500, linkWaitMs: 15000, help: false };
	let dataGiven = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => argv[++i] ?? "";
		if (arg === "--cdp-port") args.cdpPort = Number(next());
		else if (arg === "--vault-root") args.vaultRoot = next() || args.vaultRoot;
		else if (arg === "--data") {
			args.data = next();
			dataGiven = true;
		} else if (arg === "--screenshots") args.screenshots = next() || args.screenshots;
		else if (arg === "--wait-ms") args.waitMs = Number(next());
		else if (arg === "--link-wait-ms") args.linkWaitMs = Number(next());
		else if (arg === "--help" || arg === "-h") args.help = true;
	}
	if (!dataGiven) args.data = join(args.vaultRoot, ".obsidian", "plugins", PLUGIN_ID, "data.json");
	return args;
}

function printUsage(): void {
	console.log(
		[
			"Usage: node tests/e2e/embed-rename-delete.e2e.ts [options]",
			"",
			"PR-8 end to end: renames, a folder move, a heading rename and deletes of notes whose embeds were",
			"folded by a click; asserts data.json after each step and that the folds come back on reopen.",
			"",
			"Options: [--cdp-port 9222] [--vault-root /config/test-vault] [--data <path>]",
			"         [--screenshots screenshots] [--wait-ms 1500] [--link-wait-ms 15000]",
		].join("\n"),
	);
}

// --- data.json ---------------------------------------------------------------------------------

interface EmbedRecordLike {
	host: string;
	target: string;
	subpath: string;
	occurrence: number;
	contentHash?: string;
	outer?: unknown;
	folds: { text?: string }[];
	dormant?: unknown[];
	dormantSince?: number;
}

interface StoredDataLike {
	files?: Record<string, unknown>;
	embeds?: EmbedRecordLike[];
}

function readData(path: string): StoredDataLike {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as StoredDataLike;
	} catch {
		return {};
	}
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

// --- page-side expressions (beyond the shared ones above) --------------------------------------

function renameExpression(from: string, to: string): string {
	return `(async () => {
		const file = app.vault.getAbstractFileByPath(${JSON.stringify(from)});
		if (!file) return { ok: false, reason: "not found: " + ${JSON.stringify(from)} };
		await app.fileManager.renameFile(file, ${JSON.stringify(to)});
		return { ok: true };
	})()`;
}

/** Deletes what an earlier run of this script left behind under the names it renames to. */
function removeLeftoversExpression(paths: string[]): string {
	return `(async () => {
		for (const path of ${JSON.stringify(paths)}) {
			const file = app.vault.getAbstractFileByPath(path);
			if (file) await app.vault.delete(file, true);
		}
		return { ok: true };
	})()`;
}

function createFolderExpression(path: string): string {
	return `(async () => {
		if (!app.vault.getAbstractFileByPath(${JSON.stringify(path)})) await app.vault.createFolder(${JSON.stringify(path)});
		return { ok: true };
	})()`;
}

function deleteExpression(path: string): string {
	return `(async () => {
		const file = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
		if (!file) return { ok: false, reason: "not found: " + ${JSON.stringify(path)} };
		await app.vault.delete(file);
		return { ok: true };
	})()`;
}

/** Renames the heading `## from` of an open source note the way Dan does: cursor on the heading,
 * Obsidian's own "Rename this heading..." command (`editor:rename-heading`), the new text typed
 * into its dialog and Save. That is the one action in which Obsidian itself rewrites the links
 * to the heading in other notes; editing the heading line in the editor does not. */
function renameHeadingExpression(path: string, from: string, to: string): string {
	return `(async () => {
		const leaf = ${leavesOf(path)}[0];
		if (!leaf) return { ok: false, reason: "source is not open" };
		app.workspace.setActiveLeaf(leaf, { focus: true });
		const editor = leaf.view.editor;
		const lines = editor.getValue().split("\\n");
		const index = lines.findIndex((l) => l === "## " + ${JSON.stringify(from)});
		if (index < 0) return { ok: false, reason: "no heading line ## " + ${JSON.stringify(from)} };
		editor.setCursor({ line: index, ch: 3 });
		if (app.commands.executeCommandById("editor:rename-heading") === false) return { ok: false, reason: "the rename-heading command did not run" };
		const wait = (ms) => new Promise((r) => setTimeout(r, ms));
		let box = null;
		for (let i = 0; i < 40 && !box; i++) {
			await wait(100);
			box = document.querySelector(".modal-container .rename-textarea");
		}
		if (!box) return { ok: false, reason: "the Rename heading dialog never opened" };
		box.value = ${JSON.stringify(to)};
		box.dispatchEvent(new Event("input", { bubbles: true }));
		const save = Array.from(document.querySelectorAll(".modal-container .modal-button-container button")).find((b) => b.textContent === "Save");
		if (!save) return { ok: false, reason: "no Save button in the Rename heading dialog" };
		save.click();
		for (let i = 0; i < 40 && document.querySelector(".modal-container .rename-textarea"); i++) await wait(100);
		return document.querySelector(".modal-container .rename-textarea") ? { ok: false, reason: "the Rename heading dialog did not close" } : { ok: true };
	})()`;
}

function runCommandExpression(id: string): string {
	return `(() => ({ ok: app.commands.executeCommandById(${JSON.stringify(id)}) !== false }))()`;
}

/** Waits (up to 15 s) until Obsidian has indexed every one of `paths`. */
function waitForNotesExpression(paths: string[]): string {
	return `(async () => {
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			if (${JSON.stringify(paths)}.every((p) => app.vault.getFileByPath(p) !== null)) return { ok: true };
			await new Promise((r) => setTimeout(r, 250));
		}
		return { ok: false, reason: "Obsidian never indexed " + ${JSON.stringify(paths.join(", "))} };
	})()`;
}

/** Obsidian asks "Update links?" before a rename when its "Automatically update internal links"
 * setting is off, and `renameFile` waits for an answer nobody gives over CDP. Sets it as a person
 * who has it on would, returns the previous value, and answers any such prompt a failed run left
 * open (the pending rename then runs, which the cleanup that follows removes). */
function setAlwaysUpdateLinksExpression(value: unknown): string {
	return `(() => {
		for (const button of document.querySelectorAll(".modal-container .modal-button-container button")) if (button.textContent === "Do not update") button.click();
		const previous = app.vault.getConfig("alwaysUpdateLinks");
		app.vault.setConfig("alwaysUpdateLinks", ${JSON.stringify(value)});
		return { ok: true, previous: previous === undefined ? null : previous };
	})()`;
}

function setPluginEnabledExpression(enabled: boolean): string {
	return `(async () => {
		if (${enabled}) await app.plugins.enablePlugin(${JSON.stringify(PLUGIN_ID)});
		else await app.plugins.disablePlugin(${JSON.stringify(PLUGIN_ID)});
		const on = app.plugins.plugins[${JSON.stringify(PLUGIN_ID)}] !== undefined;
		return { ok: on === ${enabled}, reason: "the plugin is not ${enabled ? "enabled" : "disabled"} afterwards" };
	})()`;
}

/** Polls data.json until `ready` holds for it; returns what it last read, ready or not. */
async function waitForData(args: Args, ready: (data: StoredDataLike) => boolean, timeoutMs = 8000): Promise<StoredDataLike> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const data = readData(args.data);
		if (ready(data) || Date.now() > deadline) return data;
		await sleep(250);
	}
}

async function call(cdp: CdpConnection, expression: string, what: string): Promise<void> {
	const result = (await evaluate(cdp, expression)) as { ok: boolean; reason?: string };
	if (!result.ok) throw new Error(`${what}: ${result.reason ?? "failed"}`);
}

async function screenshot(cdp: CdpConnection, args: Args, name: string): Promise<void> {
	if (!existsSync(args.screenshots)) mkdirSync(args.screenshots, { recursive: true });
	const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
	writeFileSync(join(args.screenshots, name), Buffer.from(shot.data, "base64"));
}

// --- checks ------------------------------------------------------------------------------------

/** Waits until all three embeds of the host are rendered with arrows, then for the restore to run. */
async function waitForEmbeds(cdp: CdpConnection, path: string, waitMs: number): Promise<EmbedState[]> {
	const deadline = Date.now() + 20000;
	for (;;) {
		try {
			const embeds = await readEmbeds(cdp, path);
			if (embeds.length >= 3 && embeds.every((e) => e.arrows.length > 0)) {
				await sleep(waitMs);
				return await readEmbeds(cdp, path);
			}
		} catch {
			// the pane is not there yet
		}
		if (Date.now() > deadline) throw new Error(`the three embeds never rendered with arrows in ${path}`);
		await sleep(250);
	}
}

/** The embed of `source` (a vault path) whose link reads `suffix` after the note name (`#^0169a6`,
 * `#Lesson 8`, or nothing). The `src` attribute is the link text as written: the note's name
 * without `.md`, which Obsidian rewrites to the new name when the note is renamed or moved. */
function embedFor(embeds: EmbedState[], source: string, suffix: string): EmbedState | undefined {
	const name = (source.split("/").pop() ?? source).replace(/\.md$/, "");
	return embeds.find((e) => e.src === name + suffix);
}

function expectFolded(problems: string[], where: string, embed: EmbedState | undefined, row: string, folded = true): void {
	const arrow = embed?.arrows.find((a) => a.row.startsWith(row));
	if (!arrow) problems.push(`${where}: no "${row}" arrow in the embed`);
	else if (arrow.collapsed !== folded) problems.push(`${where}: "${row}" is ${arrow.collapsed ? "folded" : "not folded"}, expected ${folded ? "folded" : "not folded"}`);
}

/** Reopens the host and checks that each embed shows its one fold and none beyond it. */
async function checkFoldsRestored(cdp: CdpConnection, args: Args, problems: string[], where: string, host: string, source: string): Promise<void> {
	await evaluate(cdp, closeExpression(host));
	await call(cdp, openExpression(host, "live-preview"), `${where}: open the host`);
	const embeds = await waitForEmbeds(cdp, host, args.waitMs);
	const rows: [string, string][] = [
		[`#${BLOCK_SUBPATH}`, BLOCK_ROW],
		[`#${HEADING}`, HEADING_ROW],
		["", WHOLE_ROW],
	];
	for (const [suffix, row] of rows) {
		const embed = embedFor(embeds, source, suffix) ?? embedFor(embeds, source, suffix === `#${HEADING}` ? `#${RENAMED_HEADING}` : suffix);
		expectFolded(problems, `${where} (embed ${suffix || "whole note"})`, embed, row);
		const stray = (embed?.arrows ?? []).filter((a) => a.collapsed && !a.row.startsWith(row));
		if (stray.length > 0) problems.push(`${where} (embed ${suffix || "whole note"}): folds beyond the stored set: ${stray.map((a) => a.row).join(", ")}`);
	}
}

/** The records of `host`: asserts they are exactly the three kinds, each keyed to `source`, in order. */
function expectRecords(problems: string[], where: string, data: StoredDataLike, host: string, source: string, headingSubpath = HEADING): EmbedRecordLike[] {
	const mine = (data.embeds ?? []).filter((e) => e.host === host);
	const want = [BLOCK_SUBPATH, headingSubpath, ""];
	const got = want.map((subpath) => mine.find((e) => e.subpath === subpath && e.target === source));
	got.forEach((record, i) => {
		if (!record) problems.push(`${where}: no embed record for host "${host}", target "${source}", subpath "${want[i]}"`);
		else if (record.occurrence !== 0) problems.push(`${where}: occurrence index changed to ${record.occurrence} for subpath "${want[i]}"`);
		else if (record.folds.length === 0) problems.push(`${where}: the record for subpath "${want[i]}" lost its folds`);
	});
	if (mine.length !== 3) problems.push(`${where}: expected 3 embed records for "${host}", found ${mine.length}`);
	return got.filter((r): r is EmbedRecordLike => r !== undefined);
}

function expectNothingNames(problems: string[], where: string, data: StoredDataLike, paths: string[]): void {
	for (const record of data.embeds ?? []) {
		for (const path of paths) {
			if (record.host === path || record.target === path) problems.push(`${where}: an embed record still names "${path}"`);
		}
	}
}

function expectCarriedOver(problems: string[], where: string, before: EmbedRecordLike[], after: EmbedRecordLike[]): void {
	before.forEach((b, i) => {
		const a = after[i];
		if (!a) return;
		if (json(a.folds) !== json(b.folds)) problems.push(`${where}: folds changed for subpath "${b.subpath}" (they must be carried over unchanged)`);
		if (a.contentHash !== b.contentHash) problems.push(`${where}: contentHash changed for subpath "${b.subpath}"`);
		if (json(a.dormant ?? []) !== json(b.dormant ?? [])) problems.push(`${where}: dormant anchors changed for subpath "${b.subpath}"`);
	});
}

function report(phase: string, problems: string[]): void {
	if (problems.length === 0) {
		console.log(`PASS ${phase}`);
	} else {
		console.log(`FAIL ${phase}`);
		for (const problem of problems) console.log(`  - ${problem}`);
		process.exitCode = 1;
	}
}

// --- main sequence -----------------------------------------------------------------------------

/** The whole sequence. `linksChanged` is told the value of "Automatically update internal links"
 * from before the script set it, so `main` can put it back however the sequence ends. */
async function sequence(args: Args, linksChanged: (previous: unknown) => void): Promise<void> {
	const problems: string[] = [];
	const onDisk = (vaultPath: string): string => join(args.vaultRoot, vaultPath);

	let host = `${HOST_NAME}.md`;
	let source = `${SOURCE_NAME}.md`;
	const stem = (path: string): string => (path.split("/").pop() ?? path).replace(/\.md$/, "");

	await withConnection(args.cdpPort, async (cdp) => {
		// 0. A clean start: no prompt, pane or note left from an earlier run, and the plugin restarted
		// over no data.json (removing the file under a running plugin would leave its old records in
		// memory). The fixture notes are copied in only after the old ones are gone.
		// PR-8 R6: nothing is deleted or copied before the vault is known to be the test vault.
		assertTestVault(args.vaultRoot, (await evaluate(cdp, "app.vault.adapter.basePath")) as string | null);
		// --data can name a file anywhere: the one deleted below has to be this vault's own data.json.
		assertDataFileInVault(args.vaultRoot, args.data);
		const links = (await evaluate(cdp, setAlwaysUpdateLinksExpression(true))) as { previous: unknown };
		linksChanged(links.previous);
		await sleep(args.waitMs);
		await evaluate(cdp, closeExpression(host));
		await evaluate(cdp, closeExpression(source));
		await call(cdp, removeLeftoversExpression([host, source, `${SOURCE_NAME} Renamed.md`, `${HOST_NAME} Renamed.md`, "E2E Folder", "E2E Folder Renamed"]), "remove leftovers");
		await call(cdp, setPluginEnabledExpression(false), "disable the plugin");
		if (existsSync(args.data)) rmSync(args.data);
		copyFileSync(join(FIXTURES, host), onDisk(host));
		copyFileSync(join(FIXTURES, source), onDisk(source));
		await call(cdp, waitForNotesExpression([host, source]), "wait for the fixture notes to be indexed");
		await call(cdp, setPluginEnabledExpression(true), "enable the plugin");

		// 1. Fold one row in each embed with a real click.
		await sleep(args.waitMs);
		await call(cdp, openExpression(host, "live-preview"), "open the host");
		await waitForEmbeds(cdp, host, args.waitMs);
		await realClickArrow(cdp, host, 0, `${stem(source)}#${BLOCK_SUBPATH}`, BLOCK_ROW);
		await realClickArrow(cdp, host, 0, `${stem(source)}#${HEADING}`, HEADING_ROW);
		await realClickArrow(cdp, host, 0, stem(source), WHOLE_ROW);
		// The store writes data.json on a debounce of its own: wait for all three records, not a fixed time.
		let data = await waitForData(args, (d) => (d.embeds ?? []).filter((e) => e.host === host).length >= 3);
		let records = expectRecords(problems, "setup: after folding", data, host, source);
		if (problems.length > 0) {
			await screenshot(cdp, args, "PR-8-0-setup-failed.png");
			return;
		}
		const sourceEntry = json(data.files?.[source] ?? null);

		// 2. Rename the source note.
		const renamedSource = `${SOURCE_NAME} Renamed.md`;
		await call(cdp, renameExpression(source, renamedSource), "rename the source");
		await sleep(args.waitMs);
		data = readData(args.data);
		const afterSourceRename = expectRecords(problems, "G10 source rename", data, host, renamedSource);
		expectCarriedOver(problems, "G10 source rename", records, afterSourceRename);
		expectNothingNames(problems, "G10 source rename", data, [source]);
		source = renamedSource;
		records = afterSourceRename;
		// F2: the source note's own entry is the note-level handler's: carried over, not touched by the embed path.
		if (json(data.files?.[source] ?? null) !== sourceEntry) problems.push("F2: the source note's own `files` entry changed across its rename");
		await checkFoldsRestored(cdp, args, problems, "G10 source rename", host, source);
		await screenshot(cdp, args, "PR-8-1-source-renamed.png");

		// 3. Rename the host.
		const renamedHost = `${HOST_NAME} Renamed.md`;
		await call(cdp, renameExpression(host, renamedHost), "rename the host");
		await sleep(args.waitMs);
		data = readData(args.data);
		const afterHostRename = expectRecords(problems, "G10 host rename", data, renamedHost, source);
		expectCarriedOver(problems, "G10 host rename", records, afterHostRename);
		expectNothingNames(problems, "G10 host rename", data, [host]);
		host = renamedHost;
		records = afterHostRename;
		await checkFoldsRestored(cdp, args, problems, "G10 host rename", host, source);
		await screenshot(cdp, args, "PR-8-2-host-renamed.png");

		// 4. Folder: move both notes into a new folder, then rename that folder.
		await call(cdp, createFolderExpression("E2E Folder"), "create folder");
		await call(cdp, renameExpression(source, `E2E Folder/${source}`), "move the source");
		await call(cdp, renameExpression(host, `E2E Folder/${host}`), "move the host");
		source = `E2E Folder/${source}`;
		host = `E2E Folder/${host}`;
		await sleep(args.waitMs);
		await call(cdp, renameExpression("E2E Folder", "E2E Folder Renamed"), "rename the folder");
		await sleep(args.waitMs);
		source = source.replace("E2E Folder/", "E2E Folder Renamed/");
		host = host.replace("E2E Folder/", "E2E Folder Renamed/");
		data = readData(args.data);
		const afterFolder = expectRecords(problems, "G10 folder rename", data, host, source);
		expectCarriedOver(problems, "G10 folder rename", records, afterFolder);
		expectNothingNames(problems, "G10 folder rename", data, [`E2E Folder/${host.split("/").pop()}`]);
		records = afterFolder;
		await checkFoldsRestored(cdp, args, problems, "G10 folder rename", host, source);
		await screenshot(cdp, args, "PR-8-3-folder-renamed.png");

		// 5. Heading rename in the source's editor; Obsidian rewrites the host's link.
		await call(cdp, openExpression(source, "live-preview"), "open the source for editing");
		await sleep(args.waitMs);
		const before = readFileSync(onDisk(source), "utf8");
		const sourceBytesBefore = before;
		await call(cdp, renameHeadingExpression(source, HEADING, RENAMED_HEADING), "rename the heading");
		const deadline = Date.now() + args.linkWaitMs;
		let rewritten = false;
		while (Date.now() < deadline) {
			await sleep(500);
			if (readFileSync(onDisk(host), "utf8").includes(`${RENAMED_HEADING}]]`)) {
				rewritten = true;
				break;
			}
		}
		if (!rewritten) {
			problems.push(`G17: Obsidian did not rewrite the host's link to "${RENAMED_HEADING}" within ${args.linkWaitMs} ms; there is nothing to migrate (not a plugin failure)`);
			return;
		}
		await sleep(args.waitMs);
		data = readData(args.data);
		const afterHeading = expectRecords(problems, "G17 heading rename", data, host, source, RENAMED_HEADING);
		const [blockAfter, headingAfter, wholeAfter] = afterHeading;
		if (blockAfter && json(blockAfter) !== json(records[0])) problems.push("G17: the block embed's record changed on a heading rename");
		if (wholeAfter && json(wholeAfter) !== json(records[2])) problems.push("G17: the whole-note embed's record changed on a heading rename");
		if (headingAfter) {
			if (headingAfter.dormantSince !== undefined) problems.push("G17: the migrated heading record carries a dormancy stamp (it was treated as a retarget)");
			if (json(headingAfter.folds) !== json(records[1].folds) && headingAfter.folds.length === 0) problems.push("G17: the migrated heading record lost its folds");
			if (headingAfter.contentHash === undefined) problems.push("G17: the migrated heading record has no contentHash");
		}
		if ((data.embeds ?? []).some((e) => e.subpath === HEADING && e.target === source)) problems.push(`G17: a record under the old heading "${HEADING}" survives`);
		if (readFileSync(onDisk(source), "utf8") === sourceBytesBefore) problems.push("setup: the heading edit never reached the source note on disk");
		await checkFoldsRestored(cdp, args, problems, "G17 heading rename", host, source);
		await screenshot(cdp, args, "PR-8-4-heading-renamed.png");

		// 6. Delete the source, then the host.
		await call(cdp, deleteExpression(source), "delete the source");
		await sleep(args.waitMs);
		data = readData(args.data);
		expectNothingNames(problems, "G11 source delete", data, [source]);
		await call(cdp, deleteExpression(host), "delete the host");
		await sleep(args.waitMs);
		data = readData(args.data);
		expectNothingNames(problems, "G11 host delete", data, [host, source]);
		if ((data.embeds ?? []).length > 0) problems.push(`G11: ${data.embeds?.length} embed record(s) remain after both notes were deleted`);
		await call(cdp, runCommandExpression(FORGET_COMMAND), "run the Forget command");
		await screenshot(cdp, args, "PR-8-5-deleted.png");
	});

	report("embed-rename-delete (G10, G11, G17)", problems);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		return;
	}
	let changed = false;
	let previous: unknown = null;
	try {
		await sequence(args, (value) => {
			changed = true;
			previous = value;
		});
	} finally {
		if (changed) await withConnection(args.cdpPort, (cdp) => evaluate(cdp, setAlwaysUpdateLinksExpression(previous ?? false))).catch(() => undefined);
	}
}

main().then(
	() => process.exit(process.exitCode ?? 0),
	(err: unknown) => {
		console.error(err);
		process.exit(1);
	},
);
