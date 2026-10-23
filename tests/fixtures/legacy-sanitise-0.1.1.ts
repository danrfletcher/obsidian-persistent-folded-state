/**
 * A saved copy of the 0.1.1 loader: `sanitizeStoreData` and the snapshot shape `flush` wrote,
 * copied (types inlined) from `src/fold-store.ts` at commit b83d193 (before the `embeds` section
 * existed). It stands in for "an older build" in the E8 compatibility tests. Do not update it
 * when `src/fold-store.ts` changes: its whole value is that it does not know about `embeds`.
 */
import { parseAnchor } from "../../src/anchors";
import { parseDormantAnchor } from "../../src/dormant";

interface LegacyRecord {
	contentHash: string;
	folds: Record<string, unknown>[];
	dormant: Record<string, unknown>[];
}
export interface LegacyStoreData {
	version: number;
	files: Record<string, LegacyRecord>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeAnchorArray(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	const result: Record<string, unknown>[] = [];
	for (const entry of value) {
		const anchor = parseAnchor(entry);
		if (anchor !== null) result.push(anchor as unknown as Record<string, unknown>);
	}
	return result;
}

function sanitizeDormantArray(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	const result: Record<string, unknown>[] = [];
	for (const entry of value) {
		const anchor = parseDormantAnchor(entry);
		if (anchor !== null) result.push(anchor as unknown as Record<string, unknown>);
	}
	return result;
}

export function legacySanitizeStoreData(raw: unknown): LegacyStoreData {
	const empty: LegacyStoreData = { version: 1, files: {} };
	if (!isPlainObject(raw)) return empty;
	if (raw.version !== 1) return empty;
	if (!isPlainObject(raw.files)) return empty;

	const files: Record<string, LegacyRecord> = {};
	for (const [path, value] of Object.entries(raw.files)) {
		if (!isPlainObject(value)) continue;
		if (typeof value.contentHash !== "string") continue;
		if (!Array.isArray(value.folds)) continue;
		files[path] = {
			contentHash: value.contentHash,
			folds: sanitizeAnchorArray(value.folds),
			dormant: sanitizeDormantArray(value.dormant),
		};
	}
	return { version: 1, files };
}

/** What the 0.1.1 build loads and then saves back: its snapshot is `{version, files}` only. */
export function legacyLoadThenSave(raw: unknown): LegacyStoreData {
	return legacySanitizeStoreData(raw);
}
