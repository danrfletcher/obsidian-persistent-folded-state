/**
 * Warkworth-46 PR-2: the pure wait/guard (src/load-wait.ts). `isEditorLoaded` is table-driven over
 * the half-loaded, wrong-note, CRLF and empty-file shapes; the wait state machine is driven with
 * vitest fake timers over a hand-built `LoadWaitIo`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	LOAD_WAIT_GIVE_UP_MS,
	LOAD_WAIT_RECHECK_MS,
	LoadWait,
	LoadWaitRegistry,
	isEditorLoaded,
	normaliseLineEndings,
	type LoadWaitIo,
	type LoadWaitResult,
} from "../../src/load-wait";

const PATH = "Competitive Coding Fundamentals/Competitive Coding Fundamentals.md";
const FULL = "# Title\n\n- [ ] Lesson 1\n  - [ ] Child\n- [ ] Lesson 2\n  - [ ] Child\n";

describe("normaliseLineEndings", () => {
	it("turns CRLF and a lone CR into LF and leaves LF alone", () => {
		expect(normaliseLineEndings("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
		expect(normaliseLineEndings("")).toBe("");
	});

	it("drops one leading BOM and no other U+FEFF", () => {
		expect(normaliseLineEndings("\uFEFFa\r\nb")).toBe("a\nb");
		expect(normaliseLineEndings("\uFEFF\uFEFFa")).toBe("\uFEFFa");
		expect(normaliseLineEndings("a\uFEFFb")).toBe("a\uFEFFb");
	});
});

describe("isEditorLoaded", () => {
	const base = { paneFilePath: PATH, passPath: PATH, diskText: FULL, userEdited: false };

	it.each([
		{ label: "E4 empty editor, non-empty file", editorText: "" },
		{ label: "E4 a prefix of the file", editorText: FULL.slice(0, 20) },
		{ label: "E4 same length, different text", editorText: FULL.replace("Lesson 1", "Lesson X") },
		{ label: "E4 the full text with one character missing", editorText: FULL.slice(0, -1) },
		{ label: "E4 the full text with one character missing in the middle", editorText: FULL.slice(0, 10) + FULL.slice(11) },
		{ label: "E4 the full text with an extra character", editorText: FULL + "x" },
		{ label: "E5 the previous note's text in a reused pane", editorText: "# Another note\n\n- [ ] Other\n" },
	])("is not loaded: $label", ({ editorText }) => {
		expect(isEditorLoaded({ ...base, editorText })).toBe(false);
	});

	it("E5: the right text but the pane still shows another file is not loaded", () => {
		expect(isEditorLoaded({ ...base, editorText: FULL, paneFilePath: "Other/Note.md" })).toBe(false);
	});

	it("E5: a pane whose file cannot be told is not loaded", () => {
		expect(isEditorLoaded({ ...base, editorText: FULL, paneFilePath: null })).toBe(false);
	});

	it("is loaded when the pane shows this file with exactly the disk text", () => {
		expect(isEditorLoaded({ ...base, editorText: FULL })).toBe(true);
	});

	it.each([
		{ label: "CRLF on disk, LF in the editor", diskText: FULL.replace(/\n/g, "\r\n"), editorText: FULL },
		{ label: "LF on disk, CRLF in the editor", diskText: FULL, editorText: FULL.replace(/\n/g, "\r\n") },
		{ label: "lone CR on disk, LF in the editor", diskText: FULL.replace(/\n/g, "\r"), editorText: FULL },
	])("E9 is loaded: $label", ({ diskText, editorText }) => {
		expect(isEditorLoaded({ ...base, diskText, editorText })).toBe(true);
	});

	it.each([
		{ label: "BOM on disk, none in the editor (T1)", diskText: "\uFEFF" + FULL, editorText: FULL },
		{ label: "BOM and CRLF on disk, LF without BOM in the editor", diskText: "\uFEFF" + FULL.replace(/\n/g, "\r\n"), editorText: FULL },
		{ label: "BOM on both sides", diskText: "\uFEFF" + FULL, editorText: "\uFEFF" + FULL },
	])("is loaded: $label", ({ diskText, editorText }) => {
		expect(isEditorLoaded({ ...base, diskText, editorText })).toBe(true);
	});

	it("T1: a BOM on disk does not make a half-loaded note look loaded", () => {
		expect(isEditorLoaded({ ...base, diskText: "\uFEFF" + FULL, editorText: FULL.slice(0, -1) })).toBe(false);
		expect(isEditorLoaded({ ...base, diskText: "\uFEFF" + FULL, editorText: "" })).toBe(false);
	});

	it("E9: CRLF normalisation does not make a half-loaded CRLF note look loaded", () => {
		const crlf = FULL.replace(/\n/g, "\r\n");
		expect(isEditorLoaded({ ...base, diskText: crlf, editorText: FULL.slice(0, -2) })).toBe(false);
	});

	it("a file that really is empty with an empty editor is loaded at once", () => {
		expect(isEditorLoaded({ ...base, diskText: "", editorText: "" })).toBe(true);
	});

	it("an empty file with text in the editor is not loaded (a different note's text)", () => {
		expect(isEditorLoaded({ ...base, diskText: "", editorText: FULL })).toBe(false);
	});

	it("E8: an edit by the user counts as loaded whatever the text or the pane's file says", () => {
		expect(isEditorLoaded({ ...base, editorText: "", userEdited: true })).toBe(true);
		expect(isEditorLoaded({ ...base, editorText: "x", paneFilePath: "Other.md", userEdited: true })).toBe(true);
	});
});

// --- the wait state machine -----------------------------------------------------------------

/** A hand-built `LoadWaitIo` the test drives directly. */
function makeIo(opts: { diskText?: string; paneFilePath?: string | null; editorText?: string } = {}) {
	const state = {
		editorText: opts.editorText ?? "",
		paneFilePath: opts.paneFilePath === undefined ? PATH : opts.paneFilePath,
		alive: true,
		diskText: opts.diskText ?? FULL,
		readError: undefined as unknown,
		readThrows: false,
		/** When set, reads wait until `releaseReads()` is called. */
		holdReads: false,
		held: [] as (() => void)[],
		reads: 0,
		changeListeners: new Set<(change: { userEdit: boolean }) => void>(),
		fileListeners: new Set<(event: "modify" | "gone") => void>(),
	};
	const io: LoadWaitIo = {
		paneFilePath: () => state.paneFilePath,
		editorText: () => state.editorText,
		isAlive: () => state.alive,
		readDisk: (path) => {
			expect(path).toBe(PATH);
			state.reads++;
			if (state.readThrows) throw new Error("sync throw");
			const text = state.diskText;
			const error = state.readError;
			const settle = (): Promise<string> => (error !== undefined ? Promise.reject(error) : Promise.resolve(text));
			if (!state.holdReads) return settle();
			return new Promise<string>((resolve, reject) => {
				state.held.push(() => void settle().then(resolve, reject));
			});
		},
		onEditorChange: (cb) => {
			state.changeListeners.add(cb);
			return () => void state.changeListeners.delete(cb);
		},
		onFileEvent: (_path, cb) => {
			state.fileListeners.add(cb);
			return () => void state.fileListeners.delete(cb);
		},
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	return {
		io,
		state,
		/** Editor text changes, as an update listener would report it. */
		type(text: string, userEdit = false) {
			state.editorText = text;
			for (const cb of [...state.changeListeners]) cb({ userEdit });
		},
		/** The text changes with no event at all (EditorView.setState). */
		silentlySet(text: string) {
			state.editorText = text;
		},
		fileEvent(event: "modify" | "gone") {
			for (const cb of [...state.fileListeners]) cb(event);
		},
		releaseReads() {
			const held = state.held.splice(0);
			for (const release of held) release();
		},
	};
}

/** Lets promise callbacks run without moving the fake clock. */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
}

function track(wait: LoadWait): { result: LoadWaitResult | null } {
	const box: { result: LoadWaitResult | null } = { result: null };
	void wait.done.then((r) => {
		box.result = r;
	});
	return box;
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("LoadWait", () => {
	it("starts idle, waits once started, and does nothing twice if started twice", async () => {
		const h = makeIo({ editorText: "" });
		const wait = new LoadWait(PATH, h.io);
		expect(wait.state).toBe("idle");
		wait.start();
		wait.start();
		expect(wait.state).toBe("waiting");
		await flush();
		expect(h.state.reads).toBe(1);
		expect(h.state.changeListeners.size).toBe(1);
		expect(h.state.fileListeners.size).toBe(1);
		wait.cancel();
	});

	it("ready: already loaded after the one disk read", async () => {
		const h = makeIo({ editorText: FULL });
		const wait = new LoadWait(PATH, h.io);
		const box = track(wait);
		wait.start();
		await flush();
		expect(wait.state).toBe("ready");
		expect(box.result).toEqual({ state: "ready", editorText: FULL, diskText: FULL, userEdited: false });
		expect(h.state.reads).toBe(1);
	});

	it("ready: an empty editor on a file that is empty on disk, at once (no endless wait)", async () => {
		const h = makeIo({ editorText: "", diskText: "" });
		const wait = new LoadWait(PATH, h.io);
		const box = track(wait);
		wait.start();
		await flush();
		expect(box.result).toMatchObject({ state: "ready", editorText: "", diskText: "" });
	});

	it("ready: waits through an empty editor, then reports ready on the change that lands the text", async () => {
		const notLoaded = vi.fn();
		const h = makeIo({ editorText: "" });
		const wait = new LoadWait(PATH, h.io, { onNotLoaded: notLoaded });
		const box = track(wait);
		wait.start();
		await flush();
		expect(wait.state).toBe("waiting");
		expect(notLoaded).toHaveBeenCalledTimes(1);
		expect(notLoaded).toHaveBeenCalledWith({ editorText: "", diskText: FULL });

		h.type(FULL.slice(0, 12)); // half-loaded: still waiting
		expect(wait.state).toBe("waiting");
		h.type(FULL);
		await flush();
		expect(wait.state).toBe("ready");
		expect(box.result).toMatchObject({ state: "ready", editorText: FULL, userEdited: false });
		expect(notLoaded).toHaveBeenCalledTimes(1);
		expect(h.state.reads).toBe(1); // no second read without a modify event
	});

	it("ready: a CRLF note on disk with LF text in the editor", async () => {
		const h = makeIo({ editorText: "", diskText: FULL.replace(/\n/g, "\r\n") });
		const wait = new LoadWait(PATH, h.io);
		wait.start();
		await flush();
		h.type(FULL);
		await flush();
		expect(wait.state).toBe("ready");
	});

	it("ready: a BOM-prefixed note on disk with the BOM-less text in the editor (T1)", async () => {
		const h = makeIo({ editorText: "", diskText: "\uFEFF" + FULL });
		const wait = new LoadWait(PATH, h.io);
		wait.start();
		await flush();
		expect(wait.state).toBe("waiting");
		h.type(FULL);
		await flush();
		expect(wait.state).toBe("ready");
	});

	it("keeps waiting while the pane shows another file, and while it shows the old note's text", async () => {
		const h = makeIo({ editorText: FULL, paneFilePath: "Other.md" });
		const wait = new LoadWait(PATH, h.io);
		wait.start();
		await flush();
		expect(wait.state).toBe("waiting");
		h.type(FULL); // right text, wrong file
		expect(wait.state).toBe("waiting");
		h.state.paneFilePath = PATH;
		h.type("# Old note\n\n- [ ] Old\n"); // right file, old text
		expect(wait.state).toBe("waiting");
		h.type(FULL);
		await flush();
		expect(wait.state).toBe("ready");
	});

	it("re-checks on a slow timer when the text arrives with no change event (setState)", async () => {
		const h = makeIo({ editorText: "" });
		const wait = new LoadWait(PATH, h.io);
		wait.start();
		await flush();
		h.silentlySet(FULL);
		expect(wait.state).toBe("waiting");
		await vi.advanceTimersByTimeAsync(LOAD_WAIT_RECHECK_MS);
		expect(wait.state).toBe("ready");
	});

	it("E10: gives up exactly 30,000 ms after it starts, with nothing in between", async () => {
		expect(LOAD_WAIT_GIVE_UP_MS).toBe(30_000);
		const h = makeIo({ editorText: "" });
		const wait = new LoadWait(PATH, h.io);
		const box = track(wait);
		wait.start();
		await vi.advanceTimersByTimeAsync(29_999);
		expect(wait.state).toBe("waiting");
		expect(box.result).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		expect(wait.state).toBe("gave-up");
		expect(box.result).toEqual({ state: "gave-up", editorText: "", diskText: FULL });
		expect(vi.getTimerCount()).toBe(0);
		expect(h.state.changeListeners.size).toBe(0);
		expect(h.state.fileListeners.size).toBe(0);
	});

	it("a half-loaded editor never shortens the 30 s wait", async () => {
		const h = makeIo({ editorText: "" });
		const wait = new LoadWait(PATH, h.io);
		wait.start();
		await flush();
		h.type(FULL.slice(0, FULL.length - 1)); // all but one character
		await vi.advanceTimersByTimeAsync(29_000);
		expect(wait.state).toBe("waiting");
	});

	it("text that lands in the last moments still counts as ready, not gave-up", async () => {
		const h = makeIo({ editorText: "" });
		const wait = new LoadWait(PATH, h.io);
		wait.start();
		await vi.advanceTimersByTimeAsync(29_900);
		h.silentlySet(FULL);
		await vi.advanceTimersByTimeAsync(100);
		expect(wait.state).toBe("ready");
	});

	it("gives up with no disk length when the read never came back", async () => {
		const h = makeIo({ editorText: "" });
		h.state.holdReads = true;
		const wait = new LoadWait(PATH, h.io);
		const box = track(wait);
		wait.start();
		await vi.advanceTimersByTimeAsync(LOAD_WAIT_GIVE_UP_MS);
		expect(box.result).toEqual({ state: "gave-up", editorText: "", diskText: null });
	});

	it.each([
		{ label: "adapter.read rejects", setup: (h: ReturnType<typeof makeIo>) => void (h.state.readError = new Error("EIO")) },
		{ label: "adapter.read throws synchronously", setup: (h: ReturnType<typeof makeIo>) => void (h.state.readThrows = true) },
	])("E12 read-failed: $label", async ({ setup }) => {
		const h = makeIo({ editorText: "" });
		setup(h);
		const wait = new LoadWait(PATH, h.io);
		const box = track(wait);
		wait.start();
		await flush();
		expect(wait.state).toBe("read-failed");
		expect(box.result).toEqual({ state: "read-failed", editorText: "" });
		expect(vi.getTimerCount()).toBe(0);
		expect(h.state.changeListeners.size + h.state.fileListeners.size).toBe(0);
	});

	it("E12 read-failed: the file is deleted or renamed mid-wait", async () => {
		const h = makeIo({ editorText: "" });
		const wait = new LoadWait(PATH, h.io);
		const box = track(wait);
		wait.start();
		await flush();
		h.fileEvent("gone");
		await flush();
		expect(box.result).toEqual({ state: "read-failed", editorText: "" });
	});

	it("E12 read-failed: a modify event whose re-read fails", async () => {
		const h = makeIo({ editorText: "" });
		const wait = new LoadWait(PATH, h.io);
		wait.start();
		await flush();
		h.state.readError = new Error("ENOENT");
		h.fileEvent("modify");
		await flush();
		expect(wait.state).toBe("read-failed");
		expect(h.state.reads).toBe(2);
	});

	it("re-reads the disk only when a modify event fires, and compares against the newest text", async () => {
		const h = makeIo({ editorText: "# Edited elsewhere\n", diskText: FULL });
		const wait = new LoadWait(PATH, h.io);
		wait.start();
		await flush();
		expect(h.state.reads).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(h.state.reads).toBe(1); // time passing alone never reads again
		h.state.diskText = "# Edited elsewhere\n";
		h.fileEvent("modify");
		await flush();
		expect(h.state.reads).toBe(2);
		expect(wait.state).toBe("ready");
	});

	it("ignores a slow earlier read that comes back after a newer one", async () => {
		const h = makeIo({ editorText: "NEW", diskText: "OLD" });
		h.state.holdReads = true;
		const wait = new LoadWait(PATH, h.io);
		wait.start(); // read 1 (will return OLD), held
		h.state.diskText = "NEW";
		h.fileEvent("modify"); // read 2 (returns NEW), held
		const [first, second] = h.state.held.splice(0);
		// The newer read returns first and the editor matches it.
		second();
		await flush();
		expect(wait.state).toBe("ready");
		first(); // the stale one lands afterwards and changes nothing
		await flush();
		expect(wait.state).toBe("ready");
	});

	it("E8: the user's own edit ends the wait, even before the first read is back", async () => {
		const h = makeIo({ editorText: "" });
		h.state.holdReads = true;
		const wait = new LoadWait(PATH, h.io);
		const box = track(wait);
		wait.start();
		h.type("x", true);
		await flush();
		expect(box.result).toEqual({ state: "ready", editorText: "x", diskText: null, userEdited: true });
	});

	it("a change that is not the user's does not end a wait on non-matching text", async () => {
		const h = makeIo({ editorText: "" });
		const wait = new LoadWait(PATH, h.io);
		wait.start();
		await flush();
		h.type("x", false);
		expect(wait.state).toBe("waiting");
		wait.cancel();
	});

	it("cancelled: reports cancelled, clears every timer and listener, and ignores a read landing later", async () => {
		const h = makeIo({ editorText: "" });
		h.state.holdReads = true;
		const wait = new LoadWait(PATH, h.io);
		const box = track(wait);
		wait.start();
		wait.cancel();
		expect(wait.state).toBe("cancelled");
		await flush();
		expect(box.result).toEqual({ state: "cancelled" });
		expect(vi.getTimerCount()).toBe(0);
		expect(h.state.changeListeners.size + h.state.fileListeners.size).toBe(0);

		h.state.editorText = FULL;
		h.releaseReads(); // the held read now returns the matching text
		await vi.advanceTimersByTimeAsync(LOAD_WAIT_GIVE_UP_MS);
		expect(wait.state).toBe("cancelled");
		expect(box.result).toEqual({ state: "cancelled" });
	});

	it("cancel after the wait ended changes nothing", async () => {
		const h = makeIo({ editorText: FULL });
		const wait = new LoadWait(PATH, h.io);
		wait.start();
		await flush();
		wait.cancel();
		expect(wait.state).toBe("ready");
	});

	it("a pane that has gone away cancels the wait instead of reporting ready", async () => {
		const h = makeIo({ editorText: "" });
		const wait = new LoadWait(PATH, h.io);
		wait.start();
		await flush();
		h.state.alive = false;
		h.silentlySet(FULL);
		await vi.advanceTimersByTimeAsync(LOAD_WAIT_RECHECK_MS);
		expect(wait.state).toBe("cancelled");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a throwing onNotLoaded hook never breaks the wait", async () => {
		const h = makeIo({ editorText: "" });
		const wait = new LoadWait(PATH, h.io, {
			onNotLoaded: () => {
				throw new Error("hook failed");
			},
		});
		wait.start();
		await flush();
		h.type(FULL);
		await flush();
		expect(wait.state).toBe("ready");
	});
});

describe("LoadWaitRegistry", () => {
	it("E17: waits are keyed by pane, so two panes on one note never share a wait", async () => {
		const registry = new LoadWaitRegistry<object>();
		const paneA = {};
		const paneB = {};
		const a = makeIo({ editorText: FULL });
		const b = makeIo({ editorText: "" });
		const waitA = registry.start(paneA, PATH, a.io);
		const waitB = registry.start(paneB, PATH, b.io);
		expect(waitA).not.toBe(waitB);
		expect(registry.size).toBe(2);
		await flush();
		expect(waitA.state).toBe("ready");
		expect(waitB.state).toBe("waiting");
		expect(registry.get(paneA)).toBeUndefined(); // finished waits drop out
		expect(registry.get(paneB)).toBe(waitB);
		b.type(FULL);
		await flush();
		expect(waitB.state).toBe("ready");
		expect(registry.size).toBe(0);
	});

	it("E17: cancelling one pane's wait leaves the other pane's wait running", async () => {
		const registry = new LoadWaitRegistry<object>();
		const paneA = {};
		const paneB = {};
		const a = makeIo({ editorText: "" });
		const b = makeIo({ editorText: "" });
		const waitA = registry.start(paneA, PATH, a.io);
		const waitB = registry.start(paneB, PATH, b.io);
		await flush();
		expect(registry.cancel(paneB)).toBe(true);
		expect(waitB.state).toBe("cancelled");
		expect(waitA.state).toBe("waiting");
		expect(a.state.changeListeners.size).toBe(1);
		a.type(FULL);
		await flush();
		expect(waitA.state).toBe("ready");
		expect(registry.cancel(paneB)).toBe(false);
	});

	it("starting a wait for a pane cancels that pane's earlier wait: at most one live wait per pane", async () => {
		const registry = new LoadWaitRegistry<object>();
		const pane = {};
		const first = makeIo({ editorText: "" });
		const second = makeIo({ editorText: "" });
		const w1 = registry.start(pane, PATH, first.io);
		const w2 = registry.start(pane, PATH, second.io);
		expect(w1.state).toBe("cancelled");
		expect(w2.state).toBe("waiting");
		expect(registry.size).toBe(1);
		expect(registry.get(pane)).toBe(w2);
		await flush();
		first.type(FULL); // the cancelled wait's pane text changes: nothing happens
		expect(w1.state).toBe("cancelled");
		second.type(FULL);
		await flush();
		expect(w2.state).toBe("ready");
	});

	it("cancelAll cancels every pending wait and leaves no timer or listener", async () => {
		const registry = new LoadWaitRegistry<object>();
		const ios = [makeIo({ editorText: "" }), makeIo({ editorText: "" }), makeIo({ editorText: "" })];
		const waits = ios.map((h) => registry.start({}, PATH, h.io));
		await flush();
		registry.cancelAll();
		expect(waits.map((w) => w.state)).toEqual(["cancelled", "cancelled", "cancelled"]);
		expect(registry.size).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		for (const h of ios) expect(h.state.changeListeners.size + h.state.fileListeners.size).toBe(0);
	});
});

describe("purity: src/load-wait.ts has no Obsidian or CodeMirror import", () => {
	const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "load-wait.ts"), "utf8");
	it.each([/from\s+["']obsidian["']/, /from\s+["']@codemirror\//, /from\s+["']node:/, /\bdocument\./, /\bwindow\./])(
		"does not match %s",
		(pattern) => {
			const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
			expect(code).not.toMatch(pattern);
		},
	);
});
