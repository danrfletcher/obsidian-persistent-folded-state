/**
 * Shared plumbing for the real-Obsidian probes and e2e scripts (scripts/e2e-*-probe.mjs,
 * tests/e2e/*.e2e.ts): the Chrome DevTools Protocol client, plugin data.json helpers, and the
 * page-side fold helpers. One copy, so a fix lands everywhere at once. PR-1 (polish) T63 moved
 * the CDP client here from scripts/e2e-reload-probe.mjs (PR-2's original) and deleted the copies
 * in the restore probe, the dormant-baseline probe and tests/e2e/dormant-baseline.e2e.ts; R3
 * did the same for tests/e2e/relaunch.e2e.ts and tests/e2e/rename-delete.e2e.ts, which had kept
 * their own CDP client and their own document-wide fold helpers. tests/unit/e2e-scripts.test.ts
 * fails if any script grows its own copy again.
 *
 * Plain ES module with no side effects on import and no dependency on src/*, so it runs under
 * plain Node, type-stripped `.ts` e2e scripts, and vitest (tests/unit/e2e-lib.test.ts drives the
 * page-side expressions against a jsdom model of Obsidian's editor).
 *
 * Fold helpers (T61/T62 — fold clicks reported `clicked: true` while nothing folded):
 *
 *  - Every DOM read and click is scoped to the *active editor's* `.cm-editor` element
 *    (`app.workspace.activeEditor.editor.cm.dom`), not the whole `document`. Obsidian keeps
 *    background tabs' editors mounted, so after a probe has opened a second note (or reopened the
 *    same one) a document-wide `.cm-line` search can match, click and "confirm" lines that belong
 *    to a different, hidden editor.
 *  - A fold step is idempotent: when the block's interior is already not rendered it is reported
 *    as `alreadyFolded` and not clicked (a second click on a collapsed indicator would *unfold*
 *    it — the failure shape of a note Obsidian restored folded before the probe started).
 *  - After the click the page polls (rather than reading once) for the interior to leave the DOM.
 *    If the click never takes, the step falls back to Obsidian's own `editor:toggle-fold`
 *    command with the cursor on the block's first line (the path the reload probe already shows
 *    emits a fold transaction), then parks the cursor outside every fold again.
 *  - The result always says which method folded the block and carries a small DOM diagnostic, so
 *    a step that still fails explains itself instead of reporting a bare `folded: false`.
 *
 * None of this can prove Obsidian's behaviour — it makes the probes' own steps verifiable and
 * self-diagnosing. The jsdom tests cover the logic; the real-Obsidian run is the tester's.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** @typedef {{ send: (method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<any>, close: () => void }} Cdp */

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- CDP ----------------------------------------------------------------------------------

export async function findDebuggableTarget(cdpPort) {
	const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
	if (!res.ok) throw new Error(`CDP target list request failed: HTTP ${res.status}`);
	const targets = await res.json();
	const target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
	if (!target) throw new Error("no debuggable Obsidian window found on that CDP port");
	return target;
}

/** Retries `findDebuggableTarget` — used where Obsidian is still starting back up (its CDP
 * server, and a fresh debuggable target, don't exist yet right after a relaunch). */
export async function findDebuggableTargetWithRetry(cdpPort, retries, delayMs) {
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

/** Minimal CDP client: one WebSocket, JSON-RPC request/response by id. Every pending call is
 * rejected (not left hanging) the moment the socket closes or errors, and every call also has
 * its own timeout — so a phase whose Obsidian quits or never responds fails fast and visibly.
 * @param {string} webSocketDebuggerUrl
 * @returns {Cdp} */
export function connectCdp(webSocketDebuggerUrl) {
	const ws = new WebSocket(webSocketDebuggerUrl);
	let nextId = 1;
	const pending = new Map();
	let closed = false;

	function rejectAllPending(err) {
		for (const { reject } of pending.values()) reject(err);
		pending.clear();
	}

	ws.addEventListener("message", (event) => {
		const message = JSON.parse(String(event.data));
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

/** @param {Cdp} cdp
 * @param {string} expression
 * @param {{ awaitPromise?: boolean }} [opts]
 * @returns {Promise<any>} */
export async function evaluate(cdp, expression, { awaitPromise = false } = {}) {
	await cdp.send("Runtime.enable");
	const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
	if (result.exceptionDetails) throw new Error(`Runtime.evaluate threw: ${JSON.stringify(result.exceptionDetails)}`);
	return result.result.value;
}

/** @template T
 * @param {number} cdpPort
 * @param {(cdp: Cdp) => Promise<T>} fn
 * @param {{ retries?: number, retryDelayMs?: number }} [opts]
 * @returns {Promise<T>} */
export async function withConnection(cdpPort, fn, { retries = 1, retryDelayMs = 0 } = {}) {
	const target =
		retries > 1 ? await findDebuggableTargetWithRetry(cdpPort, retries, retryDelayMs) : await findDebuggableTarget(cdpPort);
	const cdp = connectCdp(target.webSocketDebuggerUrl);
	try {
		return await fn(cdp);
	} finally {
		cdp.close();
	}
}

// --- this plugin's own data.json (read/written directly from the host filesystem) -------------

/** @typedef {{ kind?: string }} StoredAnchorLike */
/** @typedef {{ contentHash: string, folds: StoredAnchorLike[], dormant: unknown[] }} StoredFileRecordLike */
/** @typedef {{ version: number, files: Record<string, StoredFileRecordLike> }} StoredDataLike */

/** @returns {StoredDataLike | null} */
export function readPluginData(dataPath) {
	if (!existsSync(dataPath)) return null;
	try {
		return JSON.parse(readFileSync(dataPath, "utf8"));
	} catch {
		return null;
	}
}

/** @param {string} dataPath @param {StoredDataLike} data */
export function writePluginData(dataPath, data) {
	writeFileSync(dataPath, JSON.stringify(data), "utf8");
}

/** @param {StoredDataLike | null} data @param {string} vaultPath
 * @returns {StoredFileRecordLike | undefined} */
export function recordFor(data, vaultPath) {
	return data?.files[vaultPath];
}

/** Duplicate of src/fold-store.ts's own `hashText` — kept dependency-free from src/* so these
 * scripts stay plain, independently-runnable files with no build step. */
export function hashText(text) {
	const normalized = text.replace(/\r\n?/g, "\n");
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

// --- page-side fold helpers ---------------------------------------------------------------

/** Shared page-side prelude: the active editor, its `.cm-editor` root (falling back to the whole
 * document when Obsidian exposes no active editor), and the cursor parking used by every fold
 * step. Spliced into each expression below. */
const PAGE_PRELUDE = `
const __info = (typeof app !== "undefined" && app.workspace && app.workspace.activeEditor) || null;
const __editor = (__info && __info.editor) || null;
const __cm = (__editor && __editor.cm) || null;
const __root = (__cm && __cm.dom) || document;
const __lines = () => Array.from(__root.querySelectorAll(".cm-line"));
const __lineTexts = () => __lines().map((el) => el.textContent || "");
const __parkCursor = () => {
	if (!__editor) return { parked: false, reason: "no active editor" };
	const lines = __editor.getValue().split("\\n");
	const title = lines.findIndex((line) => /^# /.test(line));
	__editor.setCursor({ line: title >= 0 ? title : 0, ch: 0 });
	return { parked: true, line: title >= 0 ? title : 0 };
};
`;

/** T1 (PR-1 test round 1): CM6 drops a fold whose range contains the selection head, so a fold
 * made while the cursor sits inside the block reports success and leaves the block unfolded.
 * Park the cursor on the note's "# " title line, which lies outside every foldable block of
 * tests/fixtures/tasks-before.md (a fold starts at the end of its first line), before folding. */
export const PARK_CURSOR_OUTSIDE_FOLDS_EXPRESSION = `
(function () {
${PAGE_PRELUDE}
	return __parkCursor();
})()
`;

/** The rendered text of every `.cm-line` in the active editor (CM6 never renders the interior
 * lines of a folded range, so a line's absence is the fold signal). */
export const READ_VISIBLE_LINES_EXPRESSION = `
(function () {
${PAGE_PRELUDE}
	return JSON.stringify(__lineTexts());
})()
`;

export function visibleLinesInclude(visibleLines, needle) {
	return visibleLines.some((line) => line.includes(needle));
}

/** @param {Cdp} cdp @returns {Promise<string[]>} */
export async function readVisibleLines(cdp) {
	return JSON.parse(await evaluate(cdp, READ_VISIBLE_LINES_EXPRESSION));
}

/** Clicks the fold indicator of the first rendered line (in the active editor) containing
 * `needle`, with no confirmation — for steps that *expand* a block. Returns
 * `{clicked, reason?, lineText?, indicatorClass?}`. */
export function clickFoldIndicatorExpression(needle) {
	return `
(function () {
${PAGE_PRELUDE}
	const needle = ${JSON.stringify(needle)};
	const target = __lines().find((el) => (el.textContent || "").includes(needle));
	if (!target) return { clicked: false, reason: "no rendered .cm-line contains \\"" + needle + "\\"" };
	const indicator = target.querySelector(".cm-fold-indicator .collapse-indicator") ||
		(target.previousElementSibling && target.previousElementSibling.querySelector(".cm-fold-indicator .collapse-indicator"));
	if (!indicator) return { clicked: false, reason: "found the line but no fold-indicator on/near it", lineText: target.textContent };
	indicator.click();
	return { clicked: true, lineText: target.textContent, indicatorClass: String(indicator.className) };
})()
`;
}

/** Folds the block whose first line contains `needle` and confirms from the DOM that
 * `hiddenNeedle` (a line inside the block) is no longer rendered. Async — evaluate it with
 * `awaitPromise: true`. Result: `{ok, folded, clicked, alreadyFolded, method, ...diagnostic}`,
 * where `method` is "already-folded", "indicator-click", "toggle-fold-command" or "none". */
export function foldBlockExpression(needle, hiddenNeedle, { timeoutMs = 3000, pollMs = 100 } = {}) {
	return `
(async function () {
${PAGE_PRELUDE}
	const needle = ${JSON.stringify(needle)};
	const hidden = ${JSON.stringify(hiddenNeedle)};
	const timeoutMs = ${Number(timeoutMs)};
	const pollMs = ${Number(pollMs)};
	const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const hiddenRendered = () => __lineTexts().some((t) => t.includes(hidden));
	const docHasHidden = __editor ? __editor.getValue().includes(hidden) : true;
	const diagnostic = () => ({
		scopedToActiveEditor: !!__cm,
		editorCount: document.querySelectorAll(".cm-editor").length,
		renderedLines: __lineTexts().slice(0, 14),
	});
	const settled = async () => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (!hiddenRendered()) return true;
			await pause(pollMs);
		}
		return !hiddenRendered();
	};

	if (!docHasHidden) {
		// A needle that is not in the note would read as "not rendered" and so as "folded".
		return { ok: false, folded: false, clicked: false, method: "none", reason: "the hidden-line needle \\"" + hidden + "\\" is not in the note's text", ...diagnostic() };
	}
	if (!hiddenRendered()) {
		return { ok: true, folded: true, clicked: false, alreadyFolded: true, method: "already-folded", ...diagnostic() };
	}
	const target = __lines().find((el) => (el.textContent || "").includes(needle));
	if (!target) {
		return { ok: false, folded: false, clicked: false, method: "none", reason: "no rendered .cm-line contains \\"" + needle + "\\"", ...diagnostic() };
	}
	const indicator = target.querySelector(".cm-fold-indicator .collapse-indicator") ||
		(target.previousElementSibling && target.previousElementSibling.querySelector(".cm-fold-indicator .collapse-indicator"));
	const found = { lineText: target.textContent, indicatorClass: indicator ? String(indicator.className) : null };

	if (indicator) {
		indicator.click();
		if (await settled()) return { ok: true, folded: true, clicked: true, method: "indicator-click", ...found };
	}

	// The click never folded the block (or there was no indicator to click). Fall back to
	// Obsidian's own fold command with the cursor on the block's first line.
	let lineNo = -1;
	try {
		if (__cm && __cm.posAtDOM && __cm.state) lineNo = __cm.state.doc.lineAt(__cm.posAtDOM(target)).number - 1;
	} catch (err) {
		lineNo = -1;
	}
	if (lineNo < 0 && __editor) lineNo = __editor.getValue().split("\\n").findIndex((line) => line.includes(needle));
	if (__editor && lineNo >= 0 && typeof app !== "undefined" && app.commands) {
		__editor.setCursor({ line: lineNo, ch: 0 });
		app.commands.executeCommandById("editor:toggle-fold");
		const folded = await settled();
		// The cursor now sits on this block's first line; the next fold step may be an enclosing
		// block that would swallow it (CM6 drops a fold containing the cursor), so park it again.
		__parkCursor();
		return {
			ok: folded,
			folded,
			clicked: true,
			method: folded ? "toggle-fold-command" : "none",
			reason: folded ? undefined : (indicator ? "indicator click and editor:toggle-fold both left \\"" + hidden + "\\" rendered" : "no indicator, and editor:toggle-fold left \\"" + hidden + "\\" rendered"),
			...found,
			...diagnostic(),
		};
	}
	return {
		ok: false,
		folded: false,
		clicked: !!indicator,
		method: "none",
		reason: "indicator click left \\"" + hidden + "\\" rendered and no editor/command was available for the fallback",
		...found,
		...diagnostic(),
	};
})()
`;
}

/** Folds the block (see `foldBlockExpression`), then waits `waitMs` for the plugin's recorder
 * to see it. A result with `folded: false` carries a `reason` and a DOM diagnostic.
 * @param {Cdp} cdp
 * @param {string} needle first line of the block (substring of its rendered text)
 * @param {string} hiddenNeedle a line inside the block that must stop rendering
 * @param {{ waitMs?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, folded: boolean, clicked: boolean, method: string, alreadyFolded?: boolean, reason?: string, [k: string]: any }>} */
export async function foldAndConfirm(cdp, needle, hiddenNeedle, { waitMs = 500, timeoutMs = 3000 } = {}) {
	const result = await evaluate(cdp, foldBlockExpression(needle, hiddenNeedle, { timeoutMs }), { awaitPromise: true });
	await sleep(waitMs);
	return result;
}

/** Runs `editor:unfold-all` and waits until every `expectRendered` line is back in the DOM, so a
 * fold step never starts from a note Obsidian restored (partly) folded — clicking a collapsed
 * indicator *unfolds* it. Obsidian's auto-folded frontmatter may stay folded; list only lines
 * inside the blocks the next steps fold. Async — evaluate with `awaitPromise: true`. */
export function unfoldAllExpression(expectRendered = [], { timeoutMs = 3000, pollMs = 100 } = {}) {
	return `
(async function () {
${PAGE_PRELUDE}
	const expected = ${JSON.stringify(expectRendered)};
	const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const missing = () => expected.filter((needle) => !__lineTexts().some((t) => t.includes(needle)));
	if (typeof app === "undefined" || !app.commands) return { unfolded: false, reason: "no app.commands", missing: missing() };
	app.commands.executeCommandById("editor:unfold-all");
	const deadline = Date.now() + ${Number(timeoutMs)};
	while (Date.now() < deadline && missing().length > 0) await pause(${Number(pollMs)});
	return { unfolded: missing().length === 0, missing: missing(), scopedToActiveEditor: !!__cm };
})()
`;
}

/** @param {Cdp} cdp @param {string[]} [expectRendered] @param {{ waitMs?: number, timeoutMs?: number }} [opts] */
export async function unfoldAll(cdp, expectRendered = [], { waitMs = 500, timeoutMs = 3000 } = {}) {
	const result = await evaluate(cdp, unfoldAllExpression(expectRendered, { timeoutMs }), { awaitPromise: true });
	await sleep(waitMs);
	return result;
}

/** @param {Cdp} cdp */
export async function parkCursorOutsideFolds(cdp) {
	return evaluate(cdp, PARK_CURSOR_OUTSIDE_FOLDS_EXPRESSION);
}
