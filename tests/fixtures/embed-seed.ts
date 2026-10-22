/**
 * Shared hand-written fixture for the embed-section tests: two notes and five embed records
 * (two hosts, one target embedded by both), exactly as they sit in `data.json`. Written out
 * literally rather than built from src constants, so a change to the on-disk shape is caught.
 */
import type { EmbedFoldRecord, FileFoldRecord } from "../../src/types";

export const ANCHOR_LESSON_8 = { kind: "heading", indent: 0, text: "lesson 8", siblingIndex: 0, parentChain: [] };
export const ANCHOR_TASK = {
	kind: "task",
	indent: 2,
	text: "write tests",
	siblingIndex: 1,
	parentChain: [{ kind: "heading", text: "lesson 8" }],
};
export const DORMANT_TASK = { ...ANCHOR_TASK, dormantSince: 1_000 };

export const SEED_FILES: Record<string, FileFoldRecord> = {
	"Rocketship.md": { contentHash: "r1", folds: [ANCHOR_LESSON_8], dormant: [] },
	"Other Host.md": { contentHash: "o1", folds: [ANCHOR_TASK], dormant: [] },
};

export const SEED_EMBEDS: EmbedFoldRecord[] = [
	{ host: "Rocketship.md", target: "Competitive Coding Fundamentals.md", subpath: "^0169a6", occurrence: 0, contentHash: "e1", folds: [ANCHOR_LESSON_8], dormant: [] },
	{ host: "Rocketship.md", target: "Competitive Coding Fundamentals.md", subpath: "^0169a6", occurrence: 1, contentHash: "e2", folds: [ANCHOR_TASK], dormant: [] },
	{ host: "Rocketship.md", target: "Competitive Coding Fundamentals.md", subpath: "Lesson 8", occurrence: 0, contentHash: "e3", folds: [], dormant: [DORMANT_TASK] },
	{ host: "Other Host.md", target: "Competitive Coding Fundamentals.md", subpath: "^0169a6", occurrence: 0, contentHash: "e4", folds: [ANCHOR_LESSON_8], dormant: [] },
	{ host: "Other Host.md", target: "Rocketship.md", subpath: "", occurrence: 0, contentHash: "e5", folds: [], dormant: [] },
];

/** The seed as a parsed data.json (deep-cloned so a test can mutate its copy freely). */
export function seedData(): { version: 1; files: Record<string, FileFoldRecord>; embeds: EmbedFoldRecord[] } {
	return structuredClone({ version: 1 as const, files: SEED_FILES, embeds: SEED_EMBEDS });
}
