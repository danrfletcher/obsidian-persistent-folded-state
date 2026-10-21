/**
 * Builds the "external rewrite" the E10 reload probe (scripts/e2e-reload-probe.mjs) writes to the
 * open note: the shape of what an agent or sync tool does to a note, as the spec describes it —
 * insert lines above, rename a task, append a child. Pure (string in, string out) so it is unit
 * tested without Obsidian (tests/unit/e2e-external-rewrite.test.ts). Not part of the plugin.
 */

/** Index of the first line after a leading `---` frontmatter block (0 when there is none), so
 * the inserted lines never land above the opening `---` and break the note's frontmatter. */
function bodyStart(lines) {
	if (lines[0] !== "---") return 0;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i] === "---") return i + 1;
	}
	return 0;
}

/**
 * @param {string} before the note's current text
 * @param {string} stamp  distinguishes this run's rewrite from the previous one
 * @returns {{ after: string, renamedTask: string | null }}
 */
export function buildExternalRewrite(before, stamp) {
	const lines = before.split("\n");
	const taskIndex = lines.findIndex((line) => /^\s*- \[[ xX]\] \S/.test(line));
	let renamedTask = null;
	if (taskIndex >= 0) {
		const match = /^(\s*)- \[[ xX]\] (.*)$/.exec(lines[taskIndex]);
		const indent = match[1];
		lines[taskIndex] = `${lines[taskIndex]} (renamed ${stamp})`;
		renamedTask = lines[taskIndex];
		lines.splice(taskIndex + 1, 0, `${indent}\t- [ ] appended child ${stamp}`);
	} else {
		// No task in the note: append one, plus a child, so the rewrite still has the same shape.
		if (lines[lines.length - 1] !== "") lines.push("");
		lines.splice(lines.length - 1, 0, `- [ ] probe task (renamed ${stamp})`, `\t- [ ] appended child ${stamp}`);
		renamedTask = `- [ ] probe task (renamed ${stamp})`;
	}
	lines.splice(bodyStart(lines), 0, `Inserted above by e2e-reload-probe ${stamp}`, "");
	return { after: lines.join("\n"), renamedTask };
}
