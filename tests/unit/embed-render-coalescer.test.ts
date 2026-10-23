/**
 * src/embed-render-coalescer.ts (ticket warkworth-21, PR-5, E5): ten renders within 150 ms cause
 * one pass using the last render, a render after the window starts a new pass, each key has its
 * own window, teardown cancels without error, and none of it touches the store's flush timer.
 * Fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBED_RENDER_SETTLE_MS, EmbedRenderCoalescer } from "../../src/embed-render-coalescer";
import { FoldStore } from "../../src/fold-store";
import type { EmbedFoldRecord } from "../../src/types";

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function coalescer() {
	const passes: { key: string; payload: number }[] = [];
	const c = new EmbedRenderCoalescer<string, number>((key, payload) => passes.push({ key, payload }));
	return { c, passes };
}

describe("the window", () => {
	it("is 150 ms", () => {
		expect(EMBED_RENDER_SETTLE_MS).toBe(150);
	});

	it("one render runs one pass, 150 ms after it, not before", () => {
		const { c, passes } = coalescer();
		c.render("a", 1);
		vi.advanceTimersByTime(149);
		expect(passes).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(passes).toEqual([{ key: "a", payload: 1 }]);
	});

	it("ten renders within 150 ms cause one pass, using the last render", () => {
		const { c, passes } = coalescer();
		for (let i = 1; i <= 10; i++) {
			c.render("a", i);
			vi.advanceTimersByTime(14);
		}
		vi.advanceTimersByTime(150);
		expect(passes).toEqual([{ key: "a", payload: 10 }]);
	});

	it("each render restarts the window: no pass until 150 ms after the last", () => {
		const { c, passes } = coalescer();
		c.render("a", 1);
		vi.advanceTimersByTime(100);
		c.render("a", 2);
		vi.advanceTimersByTime(100);
		expect(passes).toEqual([]);
		vi.advanceTimersByTime(50);
		expect(passes).toEqual([{ key: "a", payload: 2 }]);
	});

	it("a render arriving after the window starts a new pass", () => {
		const { c, passes } = coalescer();
		c.render("a", 1);
		vi.advanceTimersByTime(150);
		c.render("a", 2);
		vi.advanceTimersByTime(150);
		expect(passes).toEqual([
			{ key: "a", payload: 1 },
			{ key: "a", payload: 2 },
		]);
	});

	it("a render made by the pass itself starts a new window rather than being lost", () => {
		const seen: number[] = [];
		const c: EmbedRenderCoalescer<string, number> = new EmbedRenderCoalescer<string, number>((key, payload) => {
			seen.push(payload);
			if (payload === 1) c.render(key, 2);
		});
		c.render("a", 1);
		vi.advanceTimersByTime(150);
		expect(seen).toEqual([1]);
		expect(c.pendingCount).toBe(1);
		vi.advanceTimersByTime(150);
		expect(seen).toEqual([1, 2]);
		expect(c.pendingCount).toBe(0);
	});
});

describe("keys are independent (E5: a 51-embed host)", () => {
	it("a busy key never holds back a quiet one", () => {
		const { c, passes } = coalescer();
		c.render("quiet", 1);
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(40);
			c.render("busy", i);
		}
		expect(passes).toEqual([{ key: "quiet", payload: 1 }]);
		vi.advanceTimersByTime(150);
		expect(passes).toEqual([
			{ key: "quiet", payload: 1 },
			{ key: "busy", payload: 4 },
		]);
	});

	it("51 keys rendering in a scrambled order each get exactly one pass", () => {
		const { c, passes } = coalescer();
		const order = Array.from({ length: 51 }, (_, i) => (i * 20) % 51);
		expect(new Set(order).size).toBe(51);
		for (const n of order) {
			c.render(`e${n}`, n);
			c.render(`e${n}`, n + 1000);
		}
		vi.advanceTimersByTime(150);
		expect(passes).toHaveLength(51);
		expect(new Set(passes.map((p) => p.key)).size).toBe(51);
		for (const p of passes) expect(p.payload).toBe(Number(p.key.slice(1)) + 1000);
	});

	it("a key that renders late is still run, after the others", () => {
		const { c, passes } = coalescer();
		c.render("early", 1);
		vi.advanceTimersByTime(150);
		vi.advanceTimersByTime(5000);
		c.render("late", 2);
		vi.advanceTimersByTime(150);
		expect(passes.map((p) => p.key)).toEqual(["early", "late"]);
	});
});

describe("teardown", () => {
	it("cancel(key) drops that key's pending pass only, and says whether one was pending", () => {
		const { c, passes } = coalescer();
		c.render("a", 1);
		c.render("b", 2);
		expect(c.cancel("a")).toBe(true);
		expect(c.cancel("a")).toBe(false);
		expect(c.cancel("never")).toBe(false);
		vi.advanceTimersByTime(150);
		expect(passes).toEqual([{ key: "b", payload: 2 }]);
	});

	it("cancelWhere drops every matching key and counts them", () => {
		const { c, passes } = coalescer();
		for (const k of ["p1", "p2", "q1"]) c.render(k, 0);
		expect(c.cancelWhere((k) => k.startsWith("p"))).toBe(2);
		expect(c.has("q1")).toBe(true);
		vi.advanceTimersByTime(150);
		expect(passes.map((p) => p.key)).toEqual(["q1"]);
	});

	it("cancelAll runs nothing and does not throw, even when nothing is pending", () => {
		const { c, passes } = coalescer();
		expect(() => c.cancelAll()).not.toThrow();
		c.render("a", 1);
		c.render("b", 1);
		c.cancelAll();
		expect(c.pendingCount).toBe(0);
		vi.advanceTimersByTime(1000);
		expect(passes).toEqual([]);
	});

	it("a key can render again after being cancelled", () => {
		const { c, passes } = coalescer();
		c.render("a", 1);
		c.cancel("a");
		c.render("a", 2);
		vi.advanceTimersByTime(150);
		expect(passes).toEqual([{ key: "a", payload: 2 }]);
	});
});

describe("independence from the store's persistence flush timer (E5)", () => {
	const RECORD: EmbedFoldRecord = {
		host: "Host.md",
		target: "Lessons.md",
		subpath: "",
		occurrence: 0,
		contentHash: "h",
		folds: [{ kind: "task", indent: 0, text: "lesson 2: maps", siblingIndex: 1, parentChain: [] }],
		dormant: [],
	};

	function store() {
		const saved: unknown[] = [];
		const s = new FoldStore({
			loadData: async () => null,
			saveData: async (data) => {
				saved.push(structuredClone(data));
			},
		});
		return { s, saved };
	}

	it("cancelling the coalescer does not cancel a pending flush", async () => {
		const { c, passes } = coalescer();
		const { s, saved } = store();
		c.render("a", 1);
		s.setEmbed(structuredClone(RECORD));
		c.cancelAll();
		await vi.advanceTimersByTimeAsync(150);
		expect(passes).toEqual([]);
		expect(saved).toHaveLength(1);
	});

	it("firing a pass does not flush early, and the flush does not wait for it", async () => {
		const { s, saved } = store();
		const order: string[] = [];
		const c = new EmbedRenderCoalescer<string, number>(() => {
			order.push("pass");
			// A pass that is still working when the flush falls due must not delay it.
			void new Promise<void>(() => undefined);
		});
		c.render("a", 1);
		await vi.advanceTimersByTimeAsync(100);
		s.setEmbed(structuredClone(RECORD));
		await vi.advanceTimersByTimeAsync(49);
		expect(order).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(order).toEqual(["pass"]);
		expect(saved).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(100);
		expect(saved).toHaveLength(1);
	});

	it("is its own SettleDebouncer instance per key, not one shared with anything else", () => {
		const { c } = coalescer();
		c.render("a", 1);
		c.render("b", 1);
		expect(c.pendingCount).toBe(2);
		c.cancel("a");
		expect(c.pendingCount).toBe(1);
		expect(c.has("b")).toBe(true);
	});
});
