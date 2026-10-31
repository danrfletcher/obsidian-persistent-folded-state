/**
 * Warkworth-46 PR-1: the diagnostic log writer against the fake in-memory adapter
 * (`MemoryAdapter` in tests/mocks/obsidian.ts, reached as `vault.adapter`): the append chain,
 * trimming on load, a rejecting or throwing adapter (E16), a missing file, ordering and
 * escaping.
 */
import { describe, expect, it, vi } from "vitest";
import { MemoryAdapter, Vault } from "../mocks/obsidian";
import { DIAGNOSTIC_LOG_FILE, DiagnosticLogWriter } from "../../src/diagnostic-log-writer";
import { DIAGNOSTIC_LOG_FIELDS, logLines, type DiagnosticEntry } from "../../src/diagnostic-log";

const DIR = ".obsidian/plugins/persistent-folded-state";
const PATH = `${DIR}/${DIAGNOSTIC_LOG_FILE}`;
const NOW = new Date("2026-10-28T10:00:00.000Z");

function entry(over: Partial<DiagnosticEntry> = {}): DiagnosticEntry {
	return {
		path: "Notes/Tasks.md",
		pass: "open",
		editorLen: 100,
		diskLen: -1,
		foldsBefore: 1,
		dormantBefore: 0,
		foldsAfter: 1,
		dormantAfter: 0,
		outcome: "applied",
		...over,
	};
}

function make(adapter = new MemoryAdapter(), options: { maxLines?: number; warn?: (m: string, e: unknown) => void } = {}) {
	const warn = vi.fn<(message: string, err: unknown) => void>(options.warn);
	const writer = new DiagnosticLogWriter(adapter, DIR, { now: () => NOW, warn, maxLines: options.maxLines });
	return { adapter, writer, warn };
}

const paths = (adapter: MemoryAdapter): string[] => logLines(adapter.files.get(PATH) ?? "").map((l) => (JSON.parse(l) as { path: string }).path);

describe("the adapter on the mock vault", () => {
	it("app.vault.adapter is the fake in-memory adapter", () => {
		expect(new Vault().adapter).toBeInstanceOf(MemoryAdapter);
	});
});

describe("DiagnosticLogWriter: path and first write", () => {
	it("builds its path from the plugin folder and the diagnostic-log.jsonl constant", () => {
		expect(DIAGNOSTIC_LOG_FILE).toBe("diagnostic-log.jsonl");
		expect(make().writer.path).toBe(PATH);
	});

	it("the plugin folder or file is missing on first run: the first append creates the file", async () => {
		const { adapter, writer } = make();
		expect(adapter.files.has(PATH)).toBe(false);
		writer.log(entry());
		await writer.drain();
		const lines = logLines(adapter.files.get(PATH) as string);
		expect(lines).toHaveLength(1);
		expect(Object.keys(JSON.parse(lines[0]) as object)).toEqual([...DIAGNOSTIC_LOG_FIELDS]);
		expect(JSON.parse(lines[0])).toMatchObject({ t: "2026-10-28T10:00:00.000Z", path: "Notes/Tasks.md", pass: "open", outcome: "applied" });
		expect(adapter.files.get(PATH)?.endsWith("\n")).toBe(true);
	});

	it("only ever touches the one file", async () => {
		const { adapter, writer } = make();
		writer.log(entry());
		writer.log(entry());
		await writer.drain();
		expect(new Set(adapter.calls.map((c) => c.path))).toEqual(new Set([PATH]));
	});

	it("an invalid entry writes nothing", async () => {
		const { adapter, writer } = make();
		writer.log(entry({ pass: "bogus" as DiagnosticEntry["pass"] }));
		await writer.drain();
		expect(adapter.calls).toEqual([]);
		expect(adapter.files.size).toBe(0);
	});
});

describe("DiagnosticLogWriter: ordering and the serialised chain", () => {
	it("two passes that log in the same tick both land, in call order, as whole lines", async () => {
		const { adapter, writer } = make();
		writer.log(entry({ path: "first.md" }));
		writer.log(entry({ path: "second.md" }));
		writer.log(entry({ path: "third.md" }));
		await writer.drain();
		expect(paths(adapter)).toEqual(["first.md", "second.md", "third.md"]);
		const text = adapter.files.get(PATH) as string;
		expect(text.split("\n")).toHaveLength(4); // three lines + the trailing newline
		for (const line of logLines(text)) expect(() => JSON.parse(line)).not.toThrow();
	});

	it("writes run one at a time: a slow write holds back the next", async () => {
		const adapter = new MemoryAdapter();
		let inFlight = 0;
		let maxInFlight = 0;
		const realAppend = adapter.append.bind(adapter);
		adapter.append = async (path, data) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			await realAppend(path, data);
			inFlight--;
		};
		const { writer } = make(adapter);
		for (let i = 0; i < 5; i++) writer.log(entry({ path: `n${i}.md` }));
		await writer.drain();
		expect(maxInFlight).toBe(1);
		expect(paths(adapter)).toEqual(["n0.md", "n1.md", "n2.md", "n3.md", "n4.md"]);
	});

	it("paths with unicode, spaces, quotes and newlines each stay exactly one physical line", async () => {
		const odd = ["Notes/日本語 café.md", "a b/c d.md", 'q"uote\'s.md', "new\nline\r\nname.md"];
		const { adapter, writer } = make();
		for (const path of odd) writer.log(entry({ path }));
		await writer.drain();
		const text = adapter.files.get(PATH) as string;
		expect(text.split("\n")).toHaveLength(odd.length + 1);
		expect(paths(adapter)).toEqual(odd);
	});

	it("log() returns at once: a never-resolving adapter does not block the caller", () => {
		const adapter = new MemoryAdapter();
		adapter.hang = true;
		const { writer } = make(adapter);
		expect(() => {
			writer.log(entry());
			writer.log(entry());
		}).not.toThrow();
	});
});

describe("DiagnosticLogWriter: the cap and trimming on load", () => {
	const seed = (adapter: MemoryAdapter, n: number): void => {
		adapter.files.set(PATH, Array.from({ length: n }, (_, i) => `{"seed":${i}}\n`).join(""));
	};
	const seeds = (adapter: MemoryAdapter): string[] => logLines(adapter.files.get(PATH) as string);

	it.each([
		{ existing: 1, expected: 2 },
		{ existing: 999, expected: 1000 },
		{ existing: 1000, expected: 1000 },
		{ existing: 1500, expected: 1000 },
	])("a file of $existing lines plus one append holds $expected, new line last, oldest gone", async ({ existing, expected }) => {
		const { adapter, writer } = make();
		seed(adapter, existing);
		writer.log(entry({ path: "newest.md" }));
		await writer.drain();
		const lines = seeds(adapter);
		expect(lines).toHaveLength(expected);
		expect((JSON.parse(lines[lines.length - 1]) as { path: string }).path).toBe("newest.md");
		if (existing >= 1000) {
			// The newest 999 seeds survive; the oldest are gone.
			expect(lines[0]).toBe(`{"seed":${existing - 999}}`);
			expect(lines[998]).toBe(`{"seed":${existing - 1}}`);
		} else {
			expect(lines[0]).toBe('{"seed":0}');
		}
	});

	it("an over-cap file is trimmed on first load and an in-cap file is not rewritten", async () => {
		const a = make();
		seed(a.adapter, 1500);
		a.writer.log(entry());
		await a.writer.drain();
		expect(a.adapter.calls.filter((c) => c.method === "write")).toHaveLength(2); // the trim on load, then the at-cap rewrite for the new line
		const b = make();
		seed(b.adapter, 10);
		b.writer.log(entry());
		await b.writer.drain();
		expect(b.adapter.calls.filter((c) => c.method === "write")).toHaveLength(0); // appended only
		expect(b.adapter.calls.filter((c) => c.method === "append")).toHaveLength(1);
	});

	it("the file never holds more than the cap through a long run of appends", async () => {
		const { adapter, writer } = make(new MemoryAdapter(), { maxLines: 10 });
		for (let i = 0; i < 37; i++) writer.log(entry({ path: `p${i}.md` }));
		await writer.drain();
		const result = paths(adapter);
		expect(result).toHaveLength(10);
		expect(result[0]).toBe("p27.md");
		expect(result[9]).toBe("p36.md");
	});

	it("the default cap is 1,000 lines", async () => {
		const { adapter, writer } = make();
		seed(adapter, 1000);
		writer.log(entry({ path: "last.md" }));
		writer.log(entry({ path: "last2.md" }));
		await writer.drain();
		expect(seeds(adapter)).toHaveLength(1000);
		expect(paths(adapter).slice(-2)).toEqual(["last.md", "last2.md"]);
	});

	it("a corrupt line and a truncated last line are kept as they are, and the next line starts on its own line", async () => {
		const { adapter, writer } = make();
		adapter.files.set(PATH, 'garbage line\n{"t":"2026","path":"cut');
		expect(() => writer.log(entry({ path: "after.md" }))).not.toThrow();
		await writer.drain();
		const lines = seeds(adapter);
		expect(lines.slice(0, 2)).toEqual(['garbage line', '{"t":"2026","path":"cut']);
		expect((JSON.parse(lines[2]) as { path: string }).path).toBe("after.md");
		expect(lines).toHaveLength(3);
	});
});

describe("DiagnosticLogWriter: a failing adapter never throws and warns once (E16)", () => {
	it("a rejecting adapter: log() and drain() do not throw, and there is one console.warn however many failures", async () => {
		const adapter = new MemoryAdapter();
		adapter.failWith = new Error("disk full");
		const { writer, warn } = make(adapter);
		for (let i = 0; i < 5; i++) expect(() => writer.log(entry())).not.toThrow();
		await expect(writer.drain()).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][1]).toEqual(new Error("disk full"));
	});

	it("a synchronously throwing adapter is caught the same way", async () => {
		const adapter = new MemoryAdapter();
		adapter.throwSync = true;
		const { writer, warn } = make(adapter);
		expect(() => {
			writer.log(entry());
			writer.log(entry());
		}).not.toThrow();
		await expect(writer.drain()).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("after a failure the writer recovers: the next line is written from a fresh read of the file", async () => {
		const adapter = new MemoryAdapter();
		const { writer, warn } = make(adapter);
		writer.log(entry({ path: "one.md" }));
		await writer.drain();
		adapter.failWith = new Error("transient");
		writer.log(entry({ path: "lost.md" }));
		await writer.drain();
		adapter.failWith = undefined;
		writer.log(entry({ path: "two.md" }));
		await writer.drain();
		expect(paths(adapter)).toEqual(["one.md", "two.md"]);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("falls back to console.warn when no warn function is given", async () => {
		const adapter = new MemoryAdapter();
		adapter.failWith = new Error("nope");
		const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const writer = new DiagnosticLogWriter(adapter, DIR, { now: () => NOW });
			writer.log(entry());
			writer.log(entry());
			await writer.drain();
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});
});

describe("DiagnosticLogWriter: readAll and re-enabling", () => {
	it("readAll is null for a missing file and the whole text once lines are queued", async () => {
		const { writer } = make();
		await expect(writer.readAll()).resolves.toBeNull();
		writer.log(entry({ path: "x.md" }));
		const text = await writer.readAll(); // waits for the queued line
		expect(logLines(text as string)).toHaveLength(1);
	});

	it("readAll rejects when the read itself fails (the command turns that into a Notice)", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set(PATH, "x\n");
		adapter.readFailWith = new Error("EACCES");
		await expect(make(adapter).writer.readAll()).rejects.toThrow("EACCES");
	});

	it("unload: drain resolves without throwing, and a new writer keeps appending to the same file", async () => {
		const adapter = new MemoryAdapter();
		const first = make(adapter).writer;
		first.log(entry({ path: "before-unload.md" }));
		await expect(first.drain()).resolves.toBeUndefined();

		const second = make(adapter).writer; // the plugin re-enabled
		second.log(entry({ path: "after-reenable.md" }));
		await second.drain();
		expect(paths(adapter)).toEqual(["before-unload.md", "after-reenable.md"]);
	});

	it("re-enable while the old writer still has lines queued: the cap holds and every line lands in order", async () => {
		const adapter = new MemoryAdapter();
		adapter.files.set(PATH, [0, 1, 2, 3].map((i) => JSON.stringify({ path: `seed${i}.md` })).join("\n") + "\n");
		const first = make(adapter, { maxLines: 5 }).writer;
		first.log(entry({ path: "late1.md" }));
		first.log(entry({ path: "late2.md" }));
		first.log(entry({ path: "late3.md" }));
		// onunload only does `void drain()`; the plugin is enabled again straight away.
		void first.drain();
		const second = make(adapter, { maxLines: 5 }).writer;
		second.log(entry({ path: "new1.md" }));
		second.log(entry({ path: "new2.md" }));
		await second.drain();
		await first.drain();
		const result = paths(adapter);
		expect(result).toHaveLength(5);
		expect(result).toEqual(["late1.md", "late2.md", "late3.md", "new1.md", "new2.md"]);
	});

	it("readAll with a write that never settles: reads the file as it is after readWaitMs instead of hanging", async () => {
		vi.useFakeTimers();
		try {
			const adapter = new MemoryAdapter();
			adapter.files.set(PATH, '{"path":"already-there.md"}\n');
			adapter.hang = true;
			const { writer } = make(adapter);
			writer.log(entry({ path: "stuck.md" }));
			let text: string | null | undefined;
			const read = writer.readAll().then((t) => {
				text = t;
			});
			await vi.advanceTimersByTimeAsync(2999);
			expect(text).toBeUndefined(); // still inside the wait
			await vi.advanceTimersByTimeAsync(1);
			await read;
			expect(text).toBe('{"path":"already-there.md"}\n');
		} finally {
			vi.useRealTimers();
		}
	});

	it("readAll with a write that never settles and a missing file: null, not a hang", async () => {
		vi.useFakeTimers();
		try {
			const adapter = new MemoryAdapter();
			adapter.hang = true;
			const { writer } = make(adapter);
			writer.log(entry());
			const read = writer.readAll();
			await vi.advanceTimersByTimeAsync(3000);
			await expect(read).resolves.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("unload with a stuck write: nothing throws", () => {
		const adapter = new MemoryAdapter();
		adapter.hang = true;
		const { writer } = make(adapter);
		writer.log(entry());
		expect(() => void writer.drain()).not.toThrow();
	});
});
