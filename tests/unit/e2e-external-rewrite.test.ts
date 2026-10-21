import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildExternalRewrite } from "../../scripts/e2e-external-rewrite.mjs";

const FIXTURE = readFileSync(join(process.cwd(), "tests", "fixtures", "tasks-before.md"), "utf8");

describe("e2e reload probe: the external rewrite (R7a)", () => {
	it("inserts lines above, renames a task and appends a child, and nothing else changes", () => {
		const { after, renamedTask } = buildExternalRewrite(FIXTURE, "T1");
		const beforeLines = FIXTURE.split("\n");
		const afterLines = after.split("\n");

		expect(renamedTask).toBe("- [ ] Draft proposal (renamed T1)");
		// frontmatter (lines 1-4) is still intact at the top; the insertion follows it
		expect(afterLines.slice(0, 4)).toEqual(beforeLines.slice(0, 4));
		expect(afterLines.slice(4, 6)).toEqual(["Inserted above by e2e-reload-probe T1", ""]);
		expect(afterLines).toContain("- [ ] Draft proposal (renamed T1)");
		const renamedAt = afterLines.indexOf("- [ ] Draft proposal (renamed T1)");
		expect(afterLines[renamedAt + 1]).toBe("\t- [ ] appended child T1");
		// removing exactly those four additions gives back the original text
		const restored = afterLines.filter((l, i) => !(i === 4 || i === 5 || l === "\t- [ ] appended child T1"));
		restored[restored.indexOf("- [ ] Draft proposal (renamed T1)")] = "- [ ] Draft proposal";
		expect(restored.join("\n")).toBe(FIXTURE);
	});

	it("inserts at the very top when the note has no frontmatter", () => {
		const { after } = buildExternalRewrite("# H\n- [ ] a\n", "T2");
		expect(after).toBe("Inserted above by e2e-reload-probe T2\n\n# H\n- [ ] a (renamed T2)\n\t- [ ] appended child T2\n");
	});

	it("keeps a nested task's indentation for its appended child", () => {
		const { after } = buildExternalRewrite("\t- [x] only\n", "T3");
		expect(after).toContain("\t- [x] only (renamed T3)\n\t\t- [ ] appended child T3");
	});

	it("still produces the same shape for a note with no task", () => {
		const { after, renamedTask } = buildExternalRewrite("just text\n", "T4");
		expect(renamedTask).toBe("- [ ] probe task (renamed T4)");
		expect(after).toBe("Inserted above by e2e-reload-probe T4\n\njust text\n- [ ] probe task (renamed T4)\n\t- [ ] appended child T4\n");
	});

	it("differs from the previous run's rewrite", () => {
		expect(buildExternalRewrite(FIXTURE, "A").after).not.toBe(buildExternalRewrite(FIXTURE, "B").after);
	});
});
