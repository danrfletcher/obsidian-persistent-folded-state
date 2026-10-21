/**
 * PR-7: table-driven coverage of `src/vault-lifecycle.ts`'s pure re-key/removal rules (G9/G10),
 * the prune-at-load rule, the G8 hash-equals/hash-differs decision, and the E4 native-restore
 * reconciliation as a pure function. Calls the real module throughout — no mocked setter, no
 * faked input standing in for a real removal.
 */
import { describe, expect, it } from "vitest";
import {
	deleteFiles,
	needsRematchOnOpen,
	pruneOrphanFiles,
	reconcileNativeRestore,
	renameFiles,
} from "../../src/vault-lifecycle";
import type { FileFoldRecord } from "../../src/types";

function record(contentHash: string, foldText = "x"): FileFoldRecord {
	return { contentHash, folds: [{ kind: "heading", indent: 0, text: foldText, siblingIndex: 0, parentChain: [] }], dormant: [] };
}

describe("vault-lifecycle: renameFiles (G9)", () => {
	it("re-keys a single file rename in the same folder", () => {
		const before = { "Projects/Quarry/Tasks.md": record("abc") };
		const after = renameFiles(before, "Projects/Quarry/Tasks.md", "Projects/Quarry/Tasks Q4.md");
		expect(after).toEqual({ "Projects/Quarry/Tasks Q4.md": before["Projects/Quarry/Tasks.md"] });
		expect(after).not.toHaveProperty("Projects/Quarry/Tasks.md");
	});

	it("re-keys a single file moved to another folder", () => {
		const before = { "Projects/Quarry/Tasks.md": record("abc") };
		const after = renameFiles(before, "Projects/Quarry/Tasks.md", "Archive/Tasks.md");
		expect(Object.keys(after)).toEqual(["Archive/Tasks.md"]);
		expect(after["Archive/Tasks.md"]).toBe(before["Projects/Quarry/Tasks.md"]); // carried, not rebuilt
	});

	it("carries contentHash and dormant unchanged (no re-matching or re-hashing)", () => {
		const dormantEntry = { kind: "heading", indent: 0, text: "dormant-one", siblingIndex: 0, parentChain: [] };
		const before = {
			"A.md": { contentHash: "abc123", folds: [], dormant: [dormantEntry] },
		};
		const after = renameFiles(before, "A.md", "B.md");
		expect(after["B.md"]).toEqual({ contentHash: "abc123", folds: [], dormant: [dormantEntry] });
	});

	it("re-keys every stored note beneath a renamed/moved folder", () => {
		const before = {
			"Projects/Quarry/Tasks.md": record("a"),
			"Projects/Quarry/Sub/Notes.md": record("b"),
			"Projects/Other.md": record("c"), // outside the renamed folder — untouched
		};
		const after = renameFiles(before, "Projects/Quarry", "Projects/Quarry2024");
		expect(Object.keys(after).sort()).toEqual(["Projects/Other.md", "Projects/Quarry2024/Sub/Notes.md", "Projects/Quarry2024/Tasks.md"]);
		expect(after["Projects/Quarry2024/Tasks.md"]).toBe(before["Projects/Quarry/Tasks.md"]);
		expect(after["Projects/Quarry2024/Sub/Notes.md"]).toBe(before["Projects/Quarry/Sub/Notes.md"]);
		expect(after["Projects/Other.md"]).toBe(before["Projects/Other.md"]);
	});

	it("a rename onto a path that already has a stored entry replaces that entry, and the old key no longer exists", () => {
		const before = { "A.md": record("a-hash"), "B.md": record("b-hash") };
		const after = renameFiles(before, "A.md", "B.md");
		expect(after).toEqual({ "B.md": before["A.md"] }); // destination's stale data discarded
		expect(after).not.toHaveProperty("A.md");
	});

	it("a rename of a path with no stored entry does nothing and does not throw", () => {
		const before = { "Other.md": record("x") };
		expect(() => renameFiles(before, "Missing.md", "Elsewhere.md")).not.toThrow();
		expect(renameFiles(before, "Missing.md", "Elsewhere.md")).toEqual(before);
	});

	it("oldPath === newPath is a no-op", () => {
		const before = { "A.md": record("a") };
		expect(renameFiles(before, "A.md", "A.md")).toEqual(before);
	});

	it("never mutates its input", () => {
		const before = { "A.md": record("a") };
		const snapshot = JSON.stringify(before);
		renameFiles(before, "A.md", "B.md");
		expect(JSON.stringify(before)).toBe(snapshot);
	});

	it("a folder prefix match requires an actual path separator, not just a string prefix", () => {
		// "Projects/Quarry2" must not be treated as nested under "Projects/Quarry".
		const before = { "Projects/Quarry2/Notes.md": record("a") };
		const after = renameFiles(before, "Projects/Quarry", "Projects/Renamed");
		expect(after).toEqual(before);
	});
});

describe("vault-lifecycle: deleteFiles (G10)", () => {
	it("removes a single file's stored folds, dormant folds and content hash", () => {
		const before = { "A.md": record("a"), "B.md": record("b") };
		const after = deleteFiles(before, "A.md");
		expect(after).toEqual({ "B.md": before["B.md"] });
	});

	it("deleting a folder removes the stored folds of every note beneath it", () => {
		const before = {
			"Projects/Quarry/Tasks.md": record("a"),
			"Projects/Quarry/Sub/Notes.md": record("b"),
			"Projects/Other.md": record("c"),
		};
		const after = deleteFiles(before, "Projects/Quarry");
		expect(after).toEqual({ "Projects/Other.md": before["Projects/Other.md"] });
	});

	it("a delete of a path with no stored entry does nothing and does not throw", () => {
		const before = { "Other.md": record("x") };
		expect(() => deleteFiles(before, "Missing.md")).not.toThrow();
		expect(deleteFiles(before, "Missing.md")).toEqual(before);
	});

	it("never mutates its input", () => {
		const before = { "A.md": record("a") };
		const snapshot = JSON.stringify(before);
		deleteFiles(before, "A.md");
		expect(JSON.stringify(before)).toBe(snapshot);
	});

	it("a folder prefix match requires an actual path separator, not just a string prefix", () => {
		const before = { "Projects/Quarry2/Notes.md": record("a") };
		expect(deleteFiles(before, "Projects/Quarry")).toEqual(before);
	});
});

describe("vault-lifecycle: pruneOrphanFiles (G9, \"renamed outside Obsidian: not in v1\")", () => {
	it("keeps entries whose files exist, removes the rest", () => {
		const before = { "Exists.md": record("a"), "Gone.md": record("b") };
		const after = pruneOrphanFiles(before, (path) => path === "Exists.md");
		expect(after).toEqual({ "Exists.md": before["Exists.md"] });
	});

	it("keeps every entry when every file exists", () => {
		const before = { "A.md": record("a"), "B.md": record("b") };
		expect(pruneOrphanFiles(before, () => true)).toEqual(before);
	});

	it("drops every entry when no file exists", () => {
		const before = { "A.md": record("a"), "B.md": record("b") };
		expect(pruneOrphanFiles(before, () => false)).toEqual({});
	});

	it("an empty store prunes to an empty store without calling exists", () => {
		let calls = 0;
		expect(pruneOrphanFiles({}, () => { calls++; return true; })).toEqual({});
		expect(calls).toBe(0);
	});
});

describe("vault-lifecycle: needsRematchOnOpen (G8)", () => {
	it("false when the stored content hash equals the hash of the text on open", () => {
		expect(needsRematchOnOpen("abc", "abc")).toBe(false);
	});

	it("true when the hashes differ", () => {
		expect(needsRematchOnOpen("abc", "def")).toBe(true);
	});
});

describe("vault-lifecycle: reconcileNativeRestore (E4)", () => {
	it("a native fold that matches is left alone (neither toFold nor toUnfold)", () => {
		const range = { startLine: 5, endLine: 10 };
		const result = reconcileNativeRestore([range], [range]);
		expect(result).toEqual({ toFold: [], toUnfold: [] });
	});

	it("equal line count, changed content: a stale native offset not in the matched set is unfolded", () => {
		// E4's own example: the line count didn't change but the content did, so native restore's
		// offset-based fold is no longer meaningful — it isn't in the matched set at all.
		const staleNative = { startLine: 1, endLine: 6 };
		const matched = { startLine: 5, endLine: 10 };
		const result = reconcileNativeRestore([staleNative], [matched]);
		expect(result.toFold).toEqual([matched]);
		expect(result.toUnfold).toEqual([staleNative]);
	});

	it("an empty matched set unfolds every native fold outright", () => {
		const native = [{ startLine: 1, endLine: 3 }, { startLine: 5, endLine: 8 }];
		const result = reconcileNativeRestore(native, []);
		expect(result.toFold).toEqual([]);
		expect(result.toUnfold).toEqual(native);
	});

	it("an empty native-restore set folds everything matched, with nothing to unfold", () => {
		const matched = [{ startLine: 2, endLine: 4 }];
		const result = reconcileNativeRestore([], matched);
		expect(result.toFold).toEqual(matched);
		expect(result.toUnfold).toEqual([]);
	});

	it("both empty: nothing to fold or unfold, no throw", () => {
		expect(reconcileNativeRestore([], [])).toEqual({ toFold: [], toUnfold: [] });
	});

	it("never mutates its inputs", () => {
		const native = [{ startLine: 1, endLine: 3 }];
		const matched = [{ startLine: 2, endLine: 4 }];
		const nativeSnapshot = JSON.stringify(native);
		const matchedSnapshot = JSON.stringify(matched);
		reconcileNativeRestore(native, matched);
		expect(JSON.stringify(native)).toBe(nativeSnapshot);
		expect(JSON.stringify(matched)).toBe(matchedSnapshot);
	});
});

describe("vault-lifecycle: rename arriving while a pending flush exists (no write lands under the old key)", () => {
	it("re-keying before a later flush means the old key is never present when that flush eventually reads the map", () => {
		// This file's own functions are pure and know nothing about flush timing — the actual
		// no-stale-write guarantee is FoldStore's job (handleRename flushes at once against the
		// already-re-keyed map; see tests/integration/vault-events.test.ts). This test only pins
		// down the pure half of that guarantee: the old key is unconditionally absent from the
		// very first return value, with no intermediate state where both keys exist at once.
		const before = { "Old.md": record("a") };
		const after = renameFiles(before, "Old.md", "New.md");
		expect(Object.keys(after)).toEqual(["New.md"]);
	});

	it("PR-1 R4: with a covers predicate, a trimmed native fold agrees with its untrimmed matched range", () => {
		const native = [{ startLine: 2, endLine: 3 }];
		const matched = [{ startLine: 2, endLine: 4 }];
		// Default (exact) comparison: the trimmed fold looks like a stale offset.
		expect(reconcileNativeRestore(native, matched)).toEqual({ toFold: matched, toUnfold: native });
		const covers = (n: { startLine: number; endLine: number }, m: { startLine: number; endLine: number }): boolean =>
			n.startLine === m.startLine && n.endLine <= m.endLine;
		expect(reconcileNativeRestore(native, matched, covers)).toEqual({ toFold: [], toUnfold: [] });
		// A native fold the matched set does not cover is still unfolded.
		const stale = [{ startLine: 7, endLine: 8 }];
		expect(reconcileNativeRestore([...native, ...stale], matched, covers)).toEqual({ toFold: [], toUnfold: stale });
	});
});
