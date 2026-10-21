import { afterEach, describe, expect, it } from "vitest";
import {
	foldAndConfirm,
	hashText,
	parkCursorOutsideFolds,
	readVisibleLines,
	unfoldAll,
	visibleLinesInclude,
} from "../../scripts/e2e-lib.mjs";

/**
 * T61/T62 (PR-1 polish round 4): the real-Obsidian probes reported `clicked: true, folded: false`
 * for every fold step. These tests run the shared page-side fold helpers
 * (scripts/e2e-lib.mjs) through the same `evaluate` path the probes use, against a jsdom model
 * of Obsidian's editor: one `.cm-editor` per note, fold indicators inside the foldable lines,
 * `app.workspace.activeEditor.editor.cm.dom`, and the `editor:toggle-fold` / `editor:unfold-all`
 * commands. The model enforces the CM6 rule that matters here: a fold whose range contains the
 * cursor is dropped.
 *
 * What this proves is the helpers' own logic (scoping, idempotence, polling, fallback, parking,
 * diagnostics). It does not prove how real Obsidian behaves — that stays the container run's job.
 */

const DOC = [
	"---", // 0
	"project: Quarry", // 1
	"---", // 2
	"", // 3
	"# Quarry Tasks", // 4
	"", // 5
	"## Tuesday", // 6
	"", // 7
	"Notes for Tuesday.", // 8
	"", // 9
	"- Plain list item", // 10
	"\t- A nested list item", // 11
	"", // 12
	"- [ ] Draft proposal", // 13
	"\t- [ ] Outline", // 14
	"\t- [ ] Draft", // 15
	"- [ ] Send invoices", // 16
];

/** Foldable blocks as [first line, last line]; the interior is first+1..last. */
const BLOCKS: Array<[number, number]> = [
	[4, 16], // # Quarry Tasks
	[6, 16], // ## Tuesday (no later heading: swallows everything below)
	[10, 11], // Plain list item
	[13, 15], // Draft proposal
];

interface ModelOptions {
	/** Clicking a fold indicator does nothing (Obsidian ignoring a synthetic click). */
	deadClick?: boolean;
	/** Neither the indicator nor the toggle-fold command folds anything. */
	deadEverything?: boolean;
	/** Block start lines that are already folded when the note is mounted. */
	startFolded?: number[];
	/** Rendering a fold into the DOM is deferred by this many ms. */
	renderDelayMs?: number;
	/** Give the editor a CM6-style posAtDOM so the fallback can locate the block's line. */
	withPosAtDom?: boolean;
}

class EditorModel {
	root: HTMLElement;
	folded = new Set<number>();
	cursor = { line: 0, ch: 0 };
	commandsRun: string[] = [];

	constructor(
		readonly lines: string[],
		readonly options: ModelOptions = {},
	) {
		this.root = document.createElement("div");
		this.root.className = "cm-editor";
		document.body.appendChild(this.root);
		for (const start of options.startFolded ?? []) this.folded.add(start);
		this.render();
	}

	private hidden(): Set<number> {
		const hidden = new Set<number>();
		for (const [start, end] of BLOCKS) {
			if (!this.folded.has(start)) continue;
			for (let i = start + 1; i <= end; i++) hidden.add(i);
		}
		return hidden;
	}

	render(): void {
		this.root.replaceChildren();
		const content = document.createElement("div");
		content.className = "cm-content";
		this.root.appendChild(content);
		const hidden = this.hidden();
		this.lines.forEach((text, index) => {
			if (hidden.has(index)) return;
			const line = document.createElement("div");
			line.className = "cm-line";
			(line as unknown as { __docLine: number }).__docLine = index;
			if (BLOCKS.some(([start]) => start === index)) {
				const wrap = document.createElement("span");
				wrap.className = "cm-fold-indicator";
				const indicator = document.createElement("div");
				indicator.className = "collapse-indicator collapse-icon";
				indicator.addEventListener("click", () => {
					if (this.options.deadClick || this.options.deadEverything) return;
					this.toggle(index);
				});
				wrap.appendChild(indicator);
				line.appendChild(wrap);
			}
			// Live Preview hides a heading's "## " markup away from the cursor.
			line.appendChild(document.createTextNode(text.replace(/^#+ /, "")));
			content.appendChild(line);
		});
	}

	toggle(start: number): void {
		const block = BLOCKS.find(([s]) => s === start);
		if (!block) return;
		const apply = () => {
			if (this.folded.has(start)) this.folded.delete(start);
			else if (this.cursor.line > start && this.cursor.line <= block[1]) return; // CM6 drops it
			else this.folded.add(start);
			this.render();
		};
		if (this.options.renderDelayMs) setTimeout(apply, this.options.renderDelayMs);
		else apply();
	}

	unfoldAll(): void {
		this.folded.clear();
		this.render();
	}

	/** What `app.workspace.activeEditor` exposes. */
	activeEditorInfo() {
		const model = this;
		const cm: Record<string, unknown> = { dom: this.root };
		if (this.options.withPosAtDom) {
			cm.posAtDOM = (el: HTMLElement) => (el as unknown as { __docLine: number }).__docLine * 1000;
			cm.state = { doc: { lineAt: (pos: number) => ({ number: Math.floor(pos / 1000) + 1 }) } };
		}
		return {
			editor: {
				cm,
				getValue: () => model.lines.join("\n"),
				setCursor: (pos: { line: number; ch: number }) => {
					model.cursor = pos;
				},
			},
		};
	}

	commands() {
		return {
			executeCommandById: (id: string) => {
				this.commandsRun.push(id);
				if (this.options.deadEverything) return true;
				if (id === "editor:unfold-all") this.unfoldAll();
				if (id === "editor:toggle-fold") {
					const block = BLOCKS.filter(([s, e]) => this.cursor.line >= s && this.cursor.line <= e).pop();
					// Obsidian's command folds the block whose first line holds the cursor.
					const startsHere = BLOCKS.find(([s]) => s === this.cursor.line);
					if (startsHere ?? block) this.toggle((startsHere ?? block)![0]);
				}
				return true;
			},
		};
	}
}

function installApp(active: EditorModel): void {
	(globalThis as unknown as { app: unknown }).app = {
		workspace: { activeEditor: active.activeEditorInfo() },
		commands: active.commands(),
	};
}

/** The `cdp.send` the probes' `evaluate` helper talks to, backed by indirect eval in this jsdom. */
function fakeCdp() {
	return {
		send: async (method: string, params: Record<string, unknown> = {}) => {
			if (method !== "Runtime.evaluate") return {};
			const value = await (0, eval)(String(params.expression));
			return { result: { value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) } };
		},
		close: () => undefined,
	};
}

const FAST = { waitMs: 0, timeoutMs: 250 };

afterEach(() => {
	document.body.replaceChildren();
	delete (globalThis as unknown as { app?: unknown }).app;
});

describe("foldAndConfirm (page-side fold step)", () => {
	it("folds by indicator click and confirms the interior left the DOM", async () => {
		const note = new EditorModel(DOC);
		installApp(note);
		const result = await foldAndConfirm(fakeCdp(), "Draft proposal", "Outline", FAST);
		expect(result).toMatchObject({ ok: true, folded: true, clicked: true, method: "indicator-click" });
		expect(visibleLinesInclude(await readVisibleLines(fakeCdp()), "Outline")).toBe(false);
		expect(note.folded.has(13)).toBe(true);
	});

	it("is scoped to the active editor: a background tab with the same text is neither clicked nor read", async () => {
		const background = new EditorModel(DOC);
		const active = new EditorModel(DOC);
		installApp(active);
		const result = await foldAndConfirm(fakeCdp(), "Draft proposal", "Outline", FAST);
		expect(result.folded).toBe(true);
		expect(active.folded.has(13)).toBe(true);
		expect(background.folded.size).toBe(0);
		// The background editor still renders "Outline"; a document-wide read would have said the
		// block had not folded (the T61 symptom). The scoped read does not see it.
		expect(document.body.textContent).toContain("Outline");
		expect(visibleLinesInclude(await readVisibleLines(fakeCdp()), "Outline")).toBe(false);
	});

	it("does not click a block that is already folded (a second click would unfold it)", async () => {
		const note = new EditorModel(DOC, { startFolded: [13] });
		installApp(note);
		const result = await foldAndConfirm(fakeCdp(), "Draft proposal", "Outline", FAST);
		expect(result).toMatchObject({ ok: true, folded: true, clicked: false, alreadyFolded: true, method: "already-folded" });
		expect(note.folded.has(13)).toBe(true);
	});

	it("does not treat a needle that is not in the document as already folded", async () => {
		const note = new EditorModel(DOC);
		installApp(note);
		const result = await foldAndConfirm(fakeCdp(), "Draft proposal", "No such line", FAST);
		expect(result.alreadyFolded).toBeUndefined();
		expect(result).toMatchObject({ ok: false, folded: false, clicked: false });
		expect(result.reason).toContain("No such line");
		expect(note.folded.size).toBe(0);
	});

	it("polls for a fold that renders late instead of reading the DOM once", async () => {
		const note = new EditorModel(DOC, { renderDelayMs: 120 });
		installApp(note);
		const result = await foldAndConfirm(fakeCdp(), "Draft proposal", "Outline", { waitMs: 0, timeoutMs: 1000 });
		expect(result).toMatchObject({ folded: true, method: "indicator-click" });
	});

	it("falls back to editor:toggle-fold when the indicator click is ignored, then parks the cursor outside every fold", async () => {
		const note = new EditorModel(DOC, { deadClick: true, withPosAtDom: true });
		installApp(note);
		const result = await foldAndConfirm(fakeCdp(), "Draft proposal", "Outline", FAST);
		expect(result).toMatchObject({ ok: true, folded: true, clicked: true, method: "toggle-fold-command" });
		expect(note.commandsRun).toEqual(["editor:toggle-fold"]);
		expect(note.folded.has(13)).toBe(true);
		expect(note.cursor).toEqual({ line: 4, ch: 0 }); // the "# Quarry Tasks" title line
	});

	it("locates the block's line by text when the editor exposes no posAtDOM", async () => {
		const note = new EditorModel(DOC, { deadClick: true });
		installApp(note);
		const result = await foldAndConfirm(fakeCdp(), "Draft proposal", "Outline", FAST);
		expect(result).toMatchObject({ folded: true, method: "toggle-fold-command" });
		expect(note.folded.has(13)).toBe(true);
	});

	it("folds a task and then its enclosing heading, each confirmed", async () => {
		const note = new EditorModel(DOC, { deadClick: true });
		installApp(note);
		const task = await foldAndConfirm(fakeCdp(), "Draft proposal", "Outline", FAST);
		const heading = await foldAndConfirm(fakeCdp(), "Tuesday", "Notes for Tuesday", FAST);
		expect(task.folded).toBe(true);
		expect(heading.folded).toBe(true);
		expect([...note.folded].sort((a, b) => a - b)).toEqual([6, 13]);
	});

	it("rescues a fold made while the cursor sits inside the block (CM6 drops that fold on the click path)", async () => {
		const note = new EditorModel(DOC);
		note.cursor = { line: 14, ch: 0 }; // inside "Draft proposal"
		installApp(note);
		const result = await foldAndConfirm(fakeCdp(), "Draft proposal", "Outline", FAST);
		expect(result).toMatchObject({ folded: true, method: "toggle-fold-command" });
	});

	it("reports folded:false with a reason and a DOM diagnostic when nothing folds", async () => {
		const background = new EditorModel(DOC);
		const note = new EditorModel(DOC, { deadEverything: true });
		installApp(note);
		const result = await foldAndConfirm(fakeCdp(), "Draft proposal", "Outline", FAST);
		expect(background.folded.size).toBe(0);
		expect(result).toMatchObject({ ok: false, folded: false, clicked: true, method: "none", scopedToActiveEditor: true, editorCount: 2 });
		expect(result.reason).toContain("Outline");
		expect(result.renderedLines.some((line: string) => line.includes("Draft proposal"))).toBe(true);
		expect(result.indicatorClass).toContain("collapse-indicator");
	});

	it("says so when no rendered line contains the needle", async () => {
		installApp(new EditorModel(DOC));
		const result = await foldAndConfirm(fakeCdp(), "Nowhere to be found", "Outline", FAST);
		expect(result).toMatchObject({ ok: false, folded: false, clicked: false, method: "none" });
		expect(result.reason).toContain("Nowhere to be found");
	});
});

describe("unfoldAll / parkCursorOutsideFolds", () => {
	it("unfolds a note that was restored folded and waits for the expected lines", async () => {
		const note = new EditorModel(DOC, { startFolded: [13, 10] });
		installApp(note);
		const result = await unfoldAll(fakeCdp(), ["Outline", "A nested list item"], FAST);
		expect(result).toMatchObject({ unfolded: true, missing: [] });
		expect(note.commandsRun).toEqual(["editor:unfold-all"]);
	});

	it("reports the lines that stayed hidden when unfold-all does nothing", async () => {
		const note = new EditorModel(DOC, { startFolded: [13], deadEverything: true });
		installApp(note);
		const result = await unfoldAll(fakeCdp(), ["Outline"], { waitMs: 0, timeoutMs: 150 });
		expect(result).toMatchObject({ unfolded: false, missing: ["Outline"] });
	});

	it("a fold step after unfold-all starts from a known state (restored-folded note, then fold)", async () => {
		const note = new EditorModel(DOC, { startFolded: [13] });
		installApp(note);
		await unfoldAll(fakeCdp(), ["Outline"], FAST);
		const result = await foldAndConfirm(fakeCdp(), "Draft proposal", "Outline", FAST);
		expect(result).toMatchObject({ folded: true, clicked: true, method: "indicator-click" });
		expect(note.folded.has(13)).toBe(true);
	});

	it("parks the cursor on the title line", async () => {
		const note = new EditorModel(DOC);
		note.cursor = { line: 14, ch: 3 };
		installApp(note);
		expect(await parkCursorOutsideFolds(fakeCdp())).toEqual({ parked: true, line: 4 });
		expect(note.cursor).toEqual({ line: 4, ch: 0 });
	});

	it("says so when there is no active editor", async () => {
		(globalThis as unknown as { app: unknown }).app = { workspace: { activeEditor: null } };
		expect(await parkCursorOutsideFolds(fakeCdp())).toEqual({ parked: false, reason: "no active editor" });
	});
});

describe("hashText", () => {
	it("is stable and treats CRLF like LF", () => {
		expect(hashText("a\r\nb")).toBe(hashText("a\nb"));
		expect(hashText("a")).toMatch(/^[0-9a-f]{16}$/);
		expect(hashText("a")).not.toBe(hashText("b"));
	});
});
