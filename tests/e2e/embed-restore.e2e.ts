#!/usr/bin/env node
/**
 * PR-5 (ticket warkworth-21) end to end against a real, already-running Obsidian: embed folds
 * come back when the embed renders again (G2, G9, G13, E4, E14, GP3, GP5). Container-only: it
 * needs the obsidian-development-template container of `use-desktop-container.md`, this plugin
 * built and enabled, and Obsidian started with --remote-debugging-port. The tester runs it; it is
 * not part of `npm test` (its `.e2e.ts` name does not match vitest's `tests/**\/*.test.ts`).
 *
 * It drives the REAL arrow: a trusted mouse press and release at the arrow's position
 * (`Input.dispatchMouseEvent`), never a store write and never a scripted `el.click()` (which the
 * plugin's click-only classification correctly ignores). It asserts on the DOM of the embeds and
 * on this plugin's data.json, and captures the screenshots the spec names.
 *
 * Fixture vault (built by the tester, paths relative to the vault root; override with flags):
 *   Salesforce Tech Test Rocketship Course.md   embeds ![[Competitive Coding Fundamentals#^0169a6]]
 *                                               among about 50 other embeds
 *   Competitive Coding Fundamentals.md          the source note; "Lesson 8" carries ^0169a6
 *   Second Host.md                              embeds the same block, and nothing else of note
 *
 * Same own-copy-of-the-CDP-plumbing convention as tests/e2e/relaunch.e2e.ts (a `.ts` relative
 * import would need `allowImportingTsExtensions`). Phases, in order; quit and relaunch Obsidian by
 * hand where marked (this script cannot, and has no business hardcoding the binary path):
 *
 *   --phase fold            open the host in Live Preview, fold Lesson 8 inside the embed with a
 *                           real mouse click, wait out the flush, assert data.json holds exactly
 *                           one embeds entry for it and that the source note's entry is untouched.
 *   --phase reopen          close the host, open it again, assert Lesson 8 is folded and nothing
 *                           else is, and that data.json did not change (GP3, G2).
 *                           Screenshot PR-5.GP3-reopened.png.
 *   --phase reading-view    flip the host to Reading view, assert the same fold shows and that
 *                           data.json gained no second key (GP5 first half, G9).
 *                           Screenshot PR-5.GP5-reading-view.png.
 *   --phase second-host     open Second Host.md: assert its embed is fully expanded, screenshot
 *                           PR-5.GP5-second-host.png, fold "Count word frequency" there, and assert
 *                           the Rocketship entry and the source note's entry are unchanged, and the
 *                           Rocketship embed still shows only Lesson 8 folded (GP5 second half, F2).
 *   --phase two-panes       with the source note folded differently (by the tester, beforehand),
 *                           open the host in two panes: assert both show identical folds, none
 *                           beyond the stored set, and that data.json did not change (E4, E14).
 *                           Screenshot PR-5.E14-two-panes.png.
 *   --phase after-relaunch  after quitting and relaunching Obsidian by hand (G2): reconnect with
 *                           retries, open the host, assert Lesson 8 is folded again and data.json
 *                           is unchanged. Screenshot PR-5.GP3-relaunched.png.
 *
 * Usage: node tests/e2e/embed-restore.e2e.ts --phase <name> [--cdp-port 9222]
 *   [--vault-root /config/test-vault] [--host <vault path>] [--source <vault path>]
 *   [--second-host <vault path>] [--data <path>] [--screenshots screenshots] [--wait-ms 1500]
 *   [--connect-retries 30] [--connect-retry-delay-ms 2000] [--help]
 * Or `npm run test:e2e:embed-restore -- --phase fold`.
 *
 * Not run by the coder turn: there is no Obsidian in the coder's environment.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_ID = "persistent-folded-state";
const BLOCK_SUBPATH = "^0169a6";
const LESSON_8 = "Lesson 8";
const CHILD_ROW = "Count word frequency";
const ROCKETSHIP_SRC = `Competitive Coding Fundamentals#${BLOCK_SUBPATH}`;

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
	const result = (await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
		exceptionDetails?: unknown;
		result: { value: unknown };
	};
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

// --- CLI ---------------------------------------------------------------------------------------

const PHASES = ["fold", "reopen", "reading-view", "second-host", "two-panes", "after-relaunch"] as const;
type Phase = (typeof PHASES)[number];

interface Args {
	phase?: Phase;
	cdpPort: number;
	host: string;
	source: string;
	secondHost: string;
	data: string;
	screenshots: string;
	waitMs: number;
	connectRetries: number;
	connectRetryDelayMs: number;
	help: boolean;
}

function parseArgs(argv: string[]): Args {
	let vaultRoot = "/config/test-vault";
	const args: Args = {
		cdpPort: 9222,
		host: "Salesforce Tech Test Rocketship Course.md",
		source: "Competitive Coding Fundamentals.md",
		secondHost: "Second Host.md",
		data: "",
		screenshots: "screenshots",
		waitMs: 1500,
		connectRetries: 30,
		connectRetryDelayMs: 2000,
		help: false,
	};
	let dataGiven = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = (): string => argv[++i] ?? "";
		if (arg === "--phase") args.phase = next() as Phase;
		else if (arg === "--cdp-port") args.cdpPort = Number(next());
		else if (arg === "--vault-root") vaultRoot = next() || vaultRoot;
		else if (arg === "--host") args.host = next() || args.host;
		else if (arg === "--source") args.source = next() || args.source;
		else if (arg === "--second-host") args.secondHost = next() || args.secondHost;
		else if (arg === "--data") {
			args.data = next();
			dataGiven = true;
		} else if (arg === "--screenshots") args.screenshots = next() || args.screenshots;
		else if (arg === "--wait-ms") args.waitMs = Number(next());
		else if (arg === "--connect-retries") args.connectRetries = Number(next());
		else if (arg === "--connect-retry-delay-ms") args.connectRetryDelayMs = Number(next());
		else if (arg === "--help" || arg === "-h") args.help = true;
	}
	if (!dataGiven) args.data = join(vaultRoot, ".obsidian", "plugins", PLUGIN_ID, "data.json");
	return args;
}

function printUsage(): void {
	console.log(
		[
			`Usage: node tests/e2e/embed-restore.e2e.ts --phase <${PHASES.join("|")}> [options]`,
			"",
			"PR-5 end to end: fold Lesson 8 inside the Rocketship embed with a real click, then check it",
			"comes back on reopen, in Reading view, in a second host (expanded), in two panes, and after a relaunch.",
			"",
			"Options: [--cdp-port 9222] [--vault-root /config/test-vault] [--host <path>] [--source <path>]",
			"         [--second-host <path>] [--data <path>] [--screenshots screenshots] [--wait-ms 1500]",
			"         [--connect-retries 30] [--connect-retry-delay-ms 2000]",
		].join("\n"),
	);
}

// --- data.json ---------------------------------------------------------------------------------

interface EmbedRecordLike {
	host: string;
	target: string;
	subpath: string;
	occurrence: number;
	outer?: unknown;
	folds: { text?: string }[];
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

function rocketshipRecords(data: StoredDataLike, args: Args): EmbedRecordLike[] {
	return (data.embeds ?? []).filter((e) => e.host === args.host && e.target === args.source && e.subpath === BLOCK_SUBPATH);
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

// --- page-side expressions ---------------------------------------------------------------------

/** Text nodes directly under a row: the row's own text, not its children's. */
const ROW_TEXT = `(a) => Array.from(a.parentElement.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim()`;

function leavesOf(path: string): string {
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
		for (const leaf of ${leavesOf(path)}) { leaf.detach(); n++; }
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

/** Centre of the arrow for the row starting with `row`, in the embed with src `src`, in a pane. */
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
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
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

/** A real mouse press and release at the arrow, as a person makes it: trusted events. */
async function realClickArrow(cdp: CdpConnection, path: string, pane: number, src: string, row: string): Promise<void> {
	const first = (await evaluate(cdp, arrowPointExpression(path, pane, src, row))) as { x: number; y: number } | null;
	if (!first) throw new Error(`no arrow "${row}" in embed ${src} of ${path} (pane ${pane})`);
	await sleep(300); // after scrollIntoView
	const point = ((await evaluate(cdp, arrowPointExpression(path, pane, src, row))) as { x: number; y: number } | null) ?? first;
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
	await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
	await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function screenshot(cdp: CdpConnection, args: Args, name: string): Promise<string> {
	if (!existsSync(args.screenshots)) mkdirSync(args.screenshots, { recursive: true });
	const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
	const file = join(args.screenshots, name);
	writeFileSync(file, Buffer.from(shot.data, "base64"));
	return file;
}

async function open(cdp: CdpConnection, path: string, mode: "live-preview" | "reading-view" = "live-preview"): Promise<void> {
	const opened = (await evaluate(cdp, openExpression(path, mode))) as { ok: boolean; reason?: string };
	if (!opened.ok) throw new Error(opened.reason);
}

// --- checks ------------------------------------------------------------------------------------

function lesson8(embed: EmbedState | undefined): ArrowState | undefined {
	return embed?.arrows.find((a) => a.row.startsWith(LESSON_8));
}

/** The embed shows Lesson 8 folded and nothing else folded (the stored set, no more). */
function expectOnlyLesson8Folded(problems: string[], where: string, embed: EmbedState | undefined): void {
	const arrow = lesson8(embed);
	if (!arrow) problems.push(`${where}: no "${LESSON_8}" arrow in the embed`);
	else if (!arrow.collapsed) problems.push(`${where}: "${LESSON_8}" is not folded`);
	const stray = (embed?.arrows ?? []).filter((a) => a.collapsed && !a.row.startsWith(LESSON_8));
	if (stray.length > 0) problems.push(`${where}: folds beyond the stored set: ${stray.map((a) => a.row).join(", ")}`);
}

function report(phase: string, problems: string[], extra: string[] = []): void {
	for (const line of extra) console.log(`  ${line}`);
	if (problems.length === 0) {
		console.log(`PASS ${phase}`);
	} else {
		console.log(`FAIL ${phase}`);
		for (const problem of problems) console.log(`  - ${problem}`);
		process.exitCode = 1;
	}
}

// --- phases ------------------------------------------------------------------------------------

async function phaseFold(args: Args): Promise<void> {
	const problems: string[] = [];
	await withConnection(args.cdpPort, async (cdp) => {
		const sourceBefore = json(readData(args.data).files?.[args.source] ?? null);
		await open(cdp, args.host);
		const before = await waitForEmbed(cdp, args.host, ROCKETSHIP_SRC, args.waitMs);
		if (lesson8(before)?.collapsed) problems.push(`${LESSON_8} was already folded before the click (clear data.json and Obsidian's own fold memory first)`);

		await realClickArrow(cdp, args.host, 0, ROCKETSHIP_SRC, LESSON_8);
		await sleep(args.waitMs);

		const embeds = await readEmbeds(cdp, args.host);
		expectOnlyLesson8Folded(problems, "after the click", embeds.find((e) => e.src === ROCKETSHIP_SRC));
		const data = readData(args.data);
		const records = rocketshipRecords(data, args);
		if (records.length !== 1) problems.push(`expected exactly one embeds entry for the block, found ${records.length}`);
		else if (!records[0].folds.some((f) => (f.text ?? "").startsWith("lesson 8"))) problems.push("the stored folds do not include Lesson 8");
		if (json(data.files?.[args.source] ?? null) !== sourceBefore) problems.push("the source note's own stored entry changed (F2)");
	});
	report("fold (Lesson 8 folded by a real click and stored)", problems);
}

async function phaseReopen(args: Args): Promise<void> {
	const problems: string[] = [];
	let shot = "";
	await withConnection(args.cdpPort, async (cdp) => {
		const dataBefore = json(readData(args.data));
		await evaluate(cdp, closeExpression(args.host));
		await sleep(500);
		await open(cdp, args.host);
		const embed = await waitForEmbed(cdp, args.host, ROCKETSHIP_SRC, args.waitMs);
		expectOnlyLesson8Folded(problems, "after reopening in Live Preview", embed);
		shot = await screenshot(cdp, args, "PR-5.GP3-reopened.png");
		await sleep(args.waitMs);
		if (json(readData(args.data)) !== dataBefore) problems.push("data.json changed during the restore: a restore must never record");
	});
	report("reopen (GP3, G2)", problems, [`screenshot: ${shot}`]);
}

async function phaseReadingView(args: Args): Promise<void> {
	const problems: string[] = [];
	let shot = "";
	await withConnection(args.cdpPort, async (cdp) => {
		const dataBefore = readData(args.data);
		const flipped = (await evaluate(cdp, flipToReadingExpression(args.host))) as number;
		if (flipped === 0) throw new Error(`no open pane of ${args.host} to flip: run --phase reopen first`);
		const embed = await waitForEmbed(cdp, args.host, ROCKETSHIP_SRC, args.waitMs);
		expectOnlyLesson8Folded(problems, "after flipping to Reading view", embed);
		shot = await screenshot(cdp, args, "PR-5.GP5-reading-view.png");
		await sleep(args.waitMs);
		const after = readData(args.data);
		if (json(after) !== json(dataBefore)) problems.push("data.json changed on flipping to Reading view");
		if (rocketshipRecords(after, args).length !== 1) problems.push("a second key was created for the same embed (G9)");
	});
	report("reading-view (GP5 first half, G9)", problems, [`screenshot: ${shot}`]);
}

async function phaseSecondHost(args: Args): Promise<void> {
	const problems: string[] = [];
	let shot = "";
	await withConnection(args.cdpPort, async (cdp) => {
		const dataBefore = readData(args.data);
		const rocketshipBefore = json(rocketshipRecords(dataBefore, args));
		const sourceBefore = json(dataBefore.files?.[args.source] ?? null);

		await open(cdp, args.secondHost);
		const embed = await waitForEmbed(cdp, args.secondHost, ROCKETSHIP_SRC, args.waitMs);
		const folded = embed.arrows.filter((a) => a.collapsed);
		if (folded.length > 0) problems.push(`the second host's embed is not fully expanded: ${folded.map((a) => a.row).join(", ")}`);
		shot = await screenshot(cdp, args, "PR-5.GP5-second-host.png");

		await realClickArrow(cdp, args.secondHost, 0, ROCKETSHIP_SRC, CHILD_ROW);
		await sleep(args.waitMs);

		const after = readData(args.data);
		if (json(rocketshipRecords(after, args)) !== rocketshipBefore) problems.push("the Rocketship embed's stored entry changed when folding in the second host");
		if (json(after.files?.[args.source] ?? null) !== sourceBefore) problems.push("the source note's stored entry changed (F2)");
		const second = (after.embeds ?? []).filter((e) => e.host === args.secondHost && e.target === args.source && e.subpath === BLOCK_SUBPATH);
		if (second.length !== 1) problems.push(`expected one entry for the second host's embed, found ${second.length}`);

		// The Rocketship host's embed, still open in its own pane, is unchanged.
		const rocketship = (await readEmbeds(cdp, args.host)).find((e) => e.src === ROCKETSHIP_SRC);
		expectOnlyLesson8Folded(problems, "the Rocketship embed after folding in the second host", rocketship);
	});
	report("second-host (GP5 second half, F2)", problems, [`screenshot: ${shot}`]);
}

async function phaseTwoPanes(args: Args): Promise<void> {
	const problems: string[] = [];
	let shot = "";
	await withConnection(args.cdpPort, async (cdp) => {
		const dataBefore = json(readData(args.data));
		// The tester folded the source note differently in its own editor beforehand; the host is now
		// opened in two panes and both must show exactly the stored set.
		await evaluate(cdp, closeExpression(args.host));
		await sleep(500);
		for (let i = 0; i < 2; i++) {
			await open(cdp, args.host);
			await sleep(500);
		}
		const states: EmbedState[] = [];
		for (let pane = 0; pane < 2; pane++) {
			const embed = await waitForEmbed(cdp, args.host, ROCKETSHIP_SRC, args.waitMs, pane);
			expectOnlyLesson8Folded(problems, `pane ${pane}`, embed);
			states.push(embed);
		}
		if (json(states[0].arrows) !== json(states[1].arrows)) problems.push("the two panes show different folds");
		shot = await screenshot(cdp, args, "PR-5.E14-two-panes.png");
		await sleep(args.waitMs);
		if (json(readData(args.data)) !== dataBefore) problems.push("data.json changed while two panes restored (E14: a restore was recorded as a user fold)");
	});
	report("two-panes (E4, E14)", problems, [`screenshot: ${shot}`]);
}

async function phaseAfterRelaunch(args: Args): Promise<void> {
	const problems: string[] = [];
	let shot = "";
	await withConnection(
		args.cdpPort,
		async (cdp) => {
			await sleep(args.waitMs);
			const dataBefore = json(readData(args.data));
			if (rocketshipRecords(readData(args.data), args).length !== 1) problems.push("data.json has no single entry for the Rocketship embed after the relaunch");
			await open(cdp, args.host);
			const embed = await waitForEmbed(cdp, args.host, ROCKETSHIP_SRC, args.waitMs);
			expectOnlyLesson8Folded(problems, "after the relaunch", embed);
			shot = await screenshot(cdp, args, "PR-5.GP3-relaunched.png");
			await sleep(args.waitMs);
			if (json(readData(args.data)) !== dataBefore) problems.push("data.json changed during the restore after the relaunch");
		},
		args.connectRetries,
		args.connectRetryDelayMs,
	);
	report("after-relaunch (G2)", problems, [`screenshot: ${shot}`]);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.phase) {
		printUsage();
		process.exitCode = args.help ? 0 : 1;
		return;
	}
	switch (args.phase) {
		case "fold":
			return phaseFold(args);
		case "reopen":
			return phaseReopen(args);
		case "reading-view":
			return phaseReadingView(args);
		case "second-host":
			return phaseSecondHost(args);
		case "two-panes":
			return phaseTwoPanes(args);
		case "after-relaunch":
			return phaseAfterRelaunch(args);
		default:
			printUsage();
			process.exitCode = 1;
	}
}

main().catch((err: unknown) => {
	console.error(err);
	process.exitCode = 1;
});
