import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FoldStore, hashText } from "../../src/fold-store";
import type { FileFoldRecord } from "../../src/types";

function record(contentHash: string, folds: Record<string, unknown>[] = []): FileFoldRecord {
	return { contentHash, folds, dormant: [] };
}

function makeStore(overrides: Partial<{ loadData: () => Promise<unknown> }> = {}) {
	const saveData = vi.fn(async (_data: unknown) => undefined);
	const loadData = overrides.loadData ?? vi.fn(async () => null);
	const store = new FoldStore({ loadData, saveData });
	return { store, saveData, loadData };
}

describe("FoldStore: get/set/forget/forgetAll", () => {
	it("returns undefined for a path never set", async () => {
		const { store } = makeStore();
		await store.load();
		expect(store.get("Tasks.md")).toBeUndefined();
		expect(store.size).toBe(0);
	});

	it("set stores and get retrieves the record for that path", async () => {
		const { store } = makeStore();
		await store.load();
		store.set("Tasks.md", record("abc"));
		expect(store.get("Tasks.md")).toEqual(record("abc"));
		expect(store.size).toBe(1);
	});

	it("set on an existing path replaces its record entirely", async () => {
		const { store } = makeStore();
		await store.load();
		store.set("Tasks.md", record("abc"));
		store.set("Tasks.md", record("def"));
		expect(store.get("Tasks.md")).toEqual(record("def"));
		expect(store.size).toBe(1);
	});

	it("forget removes only the named path's record and returns true", async () => {
		const { store, saveData } = makeStore();
		await store.load();
		store.set("Tasks.md", record("abc"));
		store.set("Other.md", record("def"));
		const removed = store.forget("Tasks.md");
		expect(removed).toBe(true);
		expect(store.get("Tasks.md")).toBeUndefined();
		expect(store.get("Other.md")).toEqual(record("def"));
		await vi.waitFor(() => expect(saveData).toHaveBeenCalled());
		const written = saveData.mock.calls.at(-1)?.[0] as { files: Record<string, unknown> };
		expect(Object.keys(written.files)).toEqual(["Other.md"]);
	});

	it("forget on a path with no record is a no-op and writes nothing", async () => {
		const { store, saveData } = makeStore();
		await store.load();
		const removed = store.forget("Nope.md");
		expect(removed).toBe(false);
		await new Promise((r) => setTimeout(r, 0));
		expect(saveData).not.toHaveBeenCalled();
	});

	it("forgetAll empties the whole map and returns the count cleared", async () => {
		const { store, saveData } = makeStore();
		await store.load();
		store.set("A.md", record("a"));
		store.set("B.md", record("b"));
		const count = store.forgetAll();
		expect(count).toBe(2);
		expect(store.size).toBe(0);
		await vi.waitFor(() => expect(saveData).toHaveBeenCalled());
		const written = saveData.mock.calls.at(-1)?.[0] as { files: Record<string, unknown> };
		expect(written.files).toEqual({});
	});

	it("forgetAll on an already-empty store is a no-op and writes nothing", async () => {
		const { store, saveData } = makeStore();
		await store.load();
		const count = store.forgetAll();
		expect(count).toBe(0);
		await new Promise((r) => setTimeout(r, 0));
		expect(saveData).not.toHaveBeenCalled();
	});

	it("paths with spaces, unicode and # store and forget correctly", async () => {
		const { store } = makeStore();
		await store.load();
		const paths = ["Projects/Quarry/Tasks with spaces.md", "Notes/Café ☕ Résumé.md", "Area#1/Tag#note.md"];
		for (const path of paths) store.set(path, record(path));
		for (const path of paths) expect(store.get(path)).toEqual(record(path));
		for (const path of paths) expect(store.forget(path)).toBe(true);
		for (const path of paths) expect(store.get(path)).toBeUndefined();
	});
});

describe("FoldStore: debounce window (E12)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a change at t=0 is unwritten at 149ms and written at 150ms", async () => {
		const { store, saveData } = makeStore();
		await store.load();
		store.set("Tasks.md", record("abc"));

		await vi.advanceTimersByTimeAsync(149);
		expect(saveData).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("a further change restarts the 150ms window", async () => {
		const { store, saveData } = makeStore();
		await store.load();
		store.set("Tasks.md", record("abc"));

		await vi.advanceTimersByTimeAsync(100);
		store.set("Tasks.md", record("def")); // restarts the window
		expect(saveData).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(100); // 200ms since the first change, 100ms since the second
		expect(saveData).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(50); // 150ms since the second change
		expect(saveData).toHaveBeenCalledTimes(1);
		const written = saveData.mock.calls[0][0] as { files: Record<string, FileFoldRecord> };
		expect(written.files["Tasks.md"].contentHash).toBe("def");
	});
});

describe("FoldStore: flush serialisation", () => {
	it("overlapping flushes are serialised without corruption, and the final write carries the newest state", async () => {
		const writes: unknown[] = [];
		let resolveFirst: (() => void) | undefined;
		const saveData = vi.fn((data: unknown) => {
			writes.push(data);
			if (writes.length === 1) {
				return new Promise<void>((resolve) => {
					resolveFirst = resolve;
				});
			}
			return Promise.resolve();
		});
		const store = new FoldStore({ loadData: async () => null, saveData });
		await store.load();

		store.set("Tasks.md", record("v1"));
		const flush1 = store.flush(); // schedules the first write

		store.set("Tasks.md", record("v2")); // a second change lands before the first write runs
		const flush2 = store.flush(); // must not race or corrupt the first write

		await vi.waitFor(() => expect(saveData).toHaveBeenCalled());
		resolveFirst?.();
		await Promise.all([flush1, flush2]);

		// Whether this coalesces into one write or produces two, the state that actually lands on
		// disk is never stale: the last write always carries the newest in-memory state.
		const last = writes.at(-1) as { files: Record<string, FileFoldRecord> };
		expect(last.files["Tasks.md"].contentHash).toBe("v2");
	});

	it("a flush with nothing pending writes nothing", async () => {
		const { store, saveData } = makeStore();
		await store.load();
		await store.flush();
		expect(saveData).not.toHaveBeenCalled();
	});

	it("forget during a pending debounced flush writes the post-forget state, never the stale one", async () => {
		vi.useFakeTimers();
		try {
			const { store, saveData } = makeStore();
			await store.load();
			store.set("Tasks.md", record("v1")); // schedules a flush in 150ms

			await vi.advanceTimersByTimeAsync(50);
			store.forget("Tasks.md"); // flushes at once, cancelling the scheduled one

			await vi.advanceTimersByTimeAsync(0);
			expect(saveData).toHaveBeenCalledTimes(1);
			const written = saveData.mock.calls[0][0] as { files: Record<string, unknown> };
			expect(written.files).toEqual({});

			// The cancelled scheduled flush must never fire later and overwrite anything.
			await vi.advanceTimersByTimeAsync(200);
			expect(saveData).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("forgetAll during a pending debounced flush writes the post-forgetAll state, never the stale one", async () => {
		vi.useFakeTimers();
		try {
			const { store, saveData } = makeStore();
			await store.load();
			store.set("A.md", record("a"));
			store.set("B.md", record("b"));

			await vi.advanceTimersByTimeAsync(50);
			store.forgetAll();

			await vi.advanceTimersByTimeAsync(0);
			expect(saveData).toHaveBeenCalledTimes(1);
			const written = saveData.mock.calls[0][0] as { files: Record<string, unknown> };
			expect(written.files).toEqual({});

			await vi.advanceTimersByTimeAsync(200);
			expect(saveData).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("hashText", () => {
	it("gives the same string for the same text", () => {
		expect(hashText("- [ ] Draft proposal")).toBe(hashText("- [ ] Draft proposal"));
	});

	it("gives a different string for different text", () => {
		expect(hashText("a")).not.toBe(hashText("b"));
	});

	it("hashes CRLF and LF text the same", () => {
		const lf = "## Tuesday\n- [ ] Draft proposal\n  - [ ] Sub task\n";
		const crlf = lf.replace(/\n/g, "\r\n");
		expect(hashText(lf)).toBe(hashText(crlf));
	});

	it("hashes empty text without error", () => {
		expect(() => hashText("")).not.toThrow();
		expect(hashText("")).toBe(hashText(""));
	});
});
