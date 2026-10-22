/**
 * Static fence checks (F7/F8): this PR must not reach for network/telemetry APIs, and must not
 * grow extra UI surface beyond the one command and the one settings-tab button/modal this PR
 * defines. Scans `src/**​/*.ts` and the built `main.js` (run `npm run build` first).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "src");

function listFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listFiles(full));
		else out.push(full);
	}
	return out;
}

const srcFiles = listFiles(SRC).filter((f) => f.endsWith(".ts"));
const srcText = srcFiles.map((f) => readFileSync(f, "utf8")).join("\n");

const FORBIDDEN: { label: string; pattern: RegExp }[] = [
	{ label: "fetch(", pattern: /\bfetch\s*\(/ },
	{ label: "XMLHttpRequest", pattern: /\bXMLHttpRequest\b/ },
	{ label: "WebSocket", pattern: /\bWebSocket\b/ },
	{ label: "navigator.sendBeacon", pattern: /\bsendBeacon\b/ },
	{ label: "obsidian's requestUrl", pattern: /\brequestUrl\b/ },
	{ label: "node:http import", pattern: /from\s+["'](node:)?http["']/ },
	{ label: "node:https import", pattern: /from\s+["'](node:)?https["']/ },
	{ label: "node:net import", pattern: /from\s+["'](node:)?net["']/ },
	{ label: "node:dgram import", pattern: /from\s+["'](node:)?dgram["']/ },
	{ label: "posthog/analytics SDK", pattern: /posthog|mixpanel|segment\.io|amplitude|@sentry/i },
];

const UI_SURFACE: { label: string; pattern: RegExp }[] = [
	{ label: "addRibbonIcon", pattern: /\baddRibbonIcon\s*\(/ },
	{ label: "addStatusBarItem", pattern: /\baddStatusBarItem\s*\(/ },
	{ label: "registerView", pattern: /\bregisterView\s*\(/ },
];

describe("fence: src/ never reaches for network or telemetry (F8)", () => {
	it.each(FORBIDDEN)("does not contain $label", ({ pattern }) => {
		expect(srcText).not.toMatch(pattern);
	});
});

describe("fence: no extra UI surface beyond this PR's command/button/modal (F7)", () => {
	it.each(UI_SURFACE)("does not call $label", ({ pattern }) => {
		expect(srcText).not.toMatch(pattern);
	});

	it("registers exactly one command (one addCommand call site)", () => {
		const matches = srcText.match(/\.addCommand\s*\(/g) ?? [];
		expect(matches).toHaveLength(1);
	});

	it("defines exactly one Modal subclass (the forget-all confirmation)", () => {
		const matches = srcText.match(/extends Modal\b/g) ?? [];
		expect(matches).toHaveLength(1);
	});

	it("adds exactly one settings tab (one addSettingTab call site)", () => {
		const matches = srcText.match(/\.addSettingTab\s*\(/g) ?? [];
		expect(matches).toHaveLength(1);
	});
});

// Ticket warkworth-21 PR-1 (F4/F9): embed state is stored in the plugin's own data.json through
// loadData/saveData only. No new file, folder or vault note may be created, and no node fs/net
// module reached for, by any src file (including ones added later in this stack).
const NO_NEW_FILES_OR_NETWORK: { label: string; pattern: RegExp }[] = [
	{ label: "node:fs import", pattern: /from\s+[\"'](node:)?fs(\/promises)?[\"']/ },
	{ label: "adapter write/mkdir/append/remove/rename", pattern: /\badapter\.(write|writeBinary|append|appendBinary|mkdir|rmdir|remove|rename|copy)\w*\s*\(/ },
	{ label: "vault.createFolder/createBinary/copy/rename/delete/trash", pattern: /\bvault\.(createFolder|createBinary|copy|rename|delete|trash)\s*\(/ },
	{ label: "fileManager.renameFile/trashFile/processFrontMatter", pattern: /\bfileManager\.(renameFile|trashFile|processFrontMatter)\s*\(/ },
	{ label: "localStorage", pattern: /\blocalStorage\b/ },
];

describe("fence: embed state adds no new file, folder, note or network surface (F4/F9)", () => {
	it.each(NO_NEW_FILES_OR_NETWORK)("src/ does not use $label", ({ pattern }) => {
		expect(srcText).not.toMatch(pattern);
	});

	it("the command list stays exactly one registration, with no ribbon, status bar or view", () => {
		expect(srcText.match(/\.addCommand\s*\(/g) ?? []).toHaveLength(1);
		expect(srcText).not.toMatch(/\b(addRibbonIcon|addStatusBarItem|registerView)\s*\(/);
	});
});

describe("fence: manifest.json", () => {
	const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

	it("has the expected id, minAppVersion and isDesktopOnly", () => {
		expect(manifest.id).toBe("persistent-folded-state");
		expect(manifest.minAppVersion).toBe("1.13.0");
		expect(manifest.isDesktopOnly).toBe(false);
	});
});

describe("fence: built main.js (run `npm run build` first)", () => {
	const mainJsPath = join(ROOT, "main.js");
	const built = existsSync(mainJsPath);

	it.runIf(built)("exists (skipped with a clear reason if not built yet)", () => {
		expect(built).toBe(true);
	});

	it.runIf(built).each(FORBIDDEN)("built bundle does not contain $label", ({ pattern }) => {
		const text = readFileSync(mainJsPath, "utf8");
		expect(text).not.toMatch(pattern);
	});

	if (!built) {
		it.skip("main.js has not been built yet — run `npm run build` before this suite to check the bundle too", () => {});
	}
});
