import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EMBED_CAPABILITIES } from "../../src/embed-capabilities";

const DOCS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs");
const probe = JSON.parse(readFileSync(join(DOCS, "embed-probe.json"), "utf8")) as {
	verdicts: Record<string, Record<string, { verdict: string; reason?: string }>>;
	combinations: { hostMode: string; kind: string; verdict: string; reason: string | null; unobservable: string[] }[];
};
const gaps = readFileSync(join(DOCS, "embed-release-gaps.md"), "utf8");

const MODES = ["live-preview", "reading-view"];
const KINDS = ["block", "heading", "whole-note"];
const COMBOS = MODES.flatMap((hostMode) => KINDS.map((kind) => ({ hostMode, kind })));

describe("src/embed-capabilities.ts matches docs/embed-probe.json (G18)", () => {
	it("the JSON has all six combinations, each with a verdict from the closed set", () => {
		expect(Object.keys(probe.verdicts).sort()).toEqual([...MODES].sort());
		for (const { hostMode, kind } of COMBOS) {
			expect(["supported", "partial", "unsupported"]).toContain(probe.verdicts[hostMode]?.[kind]?.verdict);
		}
		expect(probe.combinations).toHaveLength(6);
		for (const { hostMode, kind } of COMBOS) {
			expect(probe.combinations.filter((c) => c.hostMode === hostMode && c.kind === kind)).toHaveLength(1);
		}
	});

	it("the typed constant equals the JSON verdicts exactly (same keys, verdicts and reasons)", () => {
		expect(JSON.parse(JSON.stringify(EMBED_CAPABILITIES))).toEqual(probe.verdicts);
	});

	it("every combination in the JSON agrees with its entry in verdicts", () => {
		for (const c of probe.combinations) {
			expect(probe.verdicts[c.hostMode][c.kind].verdict).toBe(c.verdict);
		}
	});

	it("every non-supported entry has a reason and a matching line in docs/embed-release-gaps.md", () => {
		const nonSupported = COMBOS.filter(({ hostMode, kind }) => probe.verdicts[hostMode][kind].verdict !== "supported");
		for (const { hostMode, kind } of nonSupported) {
			const entry = probe.verdicts[hostMode][kind];
			expect(entry.reason, `${hostMode}/${kind} needs a reason`).toBeTruthy();
			const line = gaps.split("\n").find((l) => l.includes(entry.reason as string));
			expect(line, `${hostMode}/${kind} needs a line in embed-release-gaps.md`).toBeDefined();
			expect(line).toContain(`(${entry.verdict})`);
		}
		if (nonSupported.length === 0) expect(gaps).toMatch(/No gaps/);
	});

	it("when every combination is supported the gaps file says no gaps; otherwise it does not claim so", () => {
		const allSupported = COMBOS.every(({ hostMode, kind }) => probe.verdicts[hostMode][kind].verdict === "supported");
		expect(/No gaps/.test(gaps)).toBe(allSupported);
	});

	it("an entry marked unobservable by the probe is never recorded as supported", () => {
		for (const c of probe.combinations) {
			if (c.unobservable.length > 0) expect(c.verdict).not.toBe("supported");
		}
	});
});
