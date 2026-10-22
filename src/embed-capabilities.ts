/**
 * G18: what the embed probe (scripts/e2e-embed-probe.mjs) proved about folding inside embeds, as
 * a typed constant for later PRs. One verdict per host mode and embed kind. It is edited by hand
 * from docs/embed-probe.json; tests/unit/embed-capabilities.test.ts fails if the two drift, and
 * checks every non-supported entry has a matching line in docs/embed-release-gaps.md.
 *
 * Read-only data: nothing here reads the DOM, the store or the vault.
 */
export type EmbedHostModeId = "live-preview" | "reading-view";
export type EmbedKind = "block" | "heading" | "whole-note";

export type EmbedCapability = { verdict: "supported" } | { verdict: "partial" | "unsupported"; reason: string };

export const EMBED_CAPABILITIES: Readonly<Record<EmbedHostModeId, Readonly<Record<EmbedKind, EmbedCapability>>>> = {
	"live-preview": {
		block: { verdict: "supported" },
		heading: { verdict: "supported" },
		"whole-note": { verdict: "supported" },
	},
	"reading-view": {
		block: { verdict: "supported" },
		heading: { verdict: "supported" },
		"whole-note": { verdict: "supported" },
	},
};
