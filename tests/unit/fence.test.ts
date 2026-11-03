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

// Warkworth-46 PR-1 (F3, F6): the diagnostic log adds exactly one command ("Copy diagnostic log",
// in src/commands.ts beside the forget command) and exactly one adapter write site (the log
// writer). Each pin below is narrowed to allow just those; anything else still fails.
const LOG_WRITER = join(SRC, "diagnostic-log-writer.ts");
const srcTextOutsideLogWriter = srcFiles
	.filter((f) => f !== LOG_WRITER)
	.map((f) => readFileSync(f, "utf8"))
	.join("\n");
const COMMANDS_FILE = join(SRC, "commands.ts");
const addCommandSites = (text: string): number => (text.match(/\.addCommand\s*\(/g) ?? []).length;

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

	it("registers exactly two commands (two addCommand call sites, both in src/commands.ts)", () => {
		expect(addCommandSites(srcText)).toBe(2);
		expect(addCommandSites(readFileSync(COMMANDS_FILE, "utf8"))).toBe(2);
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
	// Warkworth-46 PR-1: checked against src/ without the log writer (the only allowed site),
	// see `ADAPTER_WRITE` and its tests below.
	{ label: "vault.createFolder/createBinary/copy/rename/delete/trash", pattern: /\bvault\.(createFolder|createBinary|copy|rename|delete|trash)\s*\(/ },
	{ label: "fileManager.renameFile/trashFile/processFrontMatter", pattern: /\bfileManager\.(renameFile|trashFile|processFrontMatter)\s*\(/ },
	{ label: "localStorage", pattern: /\blocalStorage\b/ },
];

const ADAPTER_WRITE = /\badapter\.(write|writeBinary|append|appendBinary|mkdir|rmdir|remove|rename|copy|trash\w*)\s*\(/;

describe("fence: embed state adds no new file, folder, note or network surface (F4/F9)", () => {
	it.each(NO_NEW_FILES_OR_NETWORK)("src/ does not use $label", ({ pattern }) => {
		expect(srcText).not.toMatch(pattern);
	});

	it("src/ does not use an adapter write/mkdir/append/remove/rename/copy/trash outside the diagnostic log writer", () => {
		expect(srcTextOutsideLogWriter).not.toMatch(ADAPTER_WRITE);
	});

	it("the command list stays exactly two registrations, with no ribbon, status bar or view", () => {
		expect(addCommandSites(srcText)).toBe(2);
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

// Ticket warkworth-21 PR-5 (F1/F3/F7): the embed restore adds no UI surface and acts only on
// workspace markdown views.
describe("fence: PR-5 embed restore adds no UI surface and acts only on workspace markdown views", () => {
	const RESTORE = ["embed-fold-restorer.ts", "embed-restore-plan.ts", "embed-render-coalescer.ts"].map((name) => ({
		name,
		code: readFileSync(join(SRC, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""),
	}));

	it.each(RESTORE.map((r) => [r.name, r.code] as const))("%s registers no command, setting, modal, ribbon, status bar item or view (F7)", (_name, code) => {
		expect(code).not.toMatch(/\.addCommand\s*\(|\.addSettingTab\s*\(|extends Modal\b|\baddRibbonIcon\b|\baddStatusBarItem\b|\bregisterView\b|\bregisterMarkdownPostProcessor\b/);
	});

	it.each(RESTORE.map((r) => [r.name, r.code] as const))("%s reaches for no network or telemetry API (F8)", (_name, code) => {
		for (const { pattern } of FORBIDDEN) expect(code).not.toMatch(pattern);
	});

	it("every restore pass goes through detectEmbedHost, which accepts only a workspace markdown view in Live Preview or Reading view (F3)", () => {
		const restorer = RESTORE[0].code;
		expect(restorer).toMatch(/detectEmbedHost\(this\.deps\.workspace, el\)/);
		expect(restorer).toMatch(/if \(host === null \|\| !this\.supported\(host, el\)\) return;/);
		// No path from a DOM element to a fold that skips the host check: the only click is after it.
		expect(restorer.indexOf("detectEmbedHost(")).toBeGreaterThan(-1);
		expect(restorer.indexOf("detectEmbedHost(")).toBeLessThan(restorer.indexOf("indicator.click("));
	});

	it("src/ still has two commands and one settings tab, and the restorer is created and disposed in main.ts", () => {
		const main = readFileSync(join(SRC, "main.ts"), "utf8");
		expect(addCommandSites(srcText)).toBe(2);
		expect(srcText.match(/\.addSettingTab\s*\(/g) ?? []).toHaveLength(1);
		expect(main).toMatch(/new EmbedFoldRestorer\(/);
		expect(main).toMatch(/this\.embedRestorer\?\.dispose\(\)/);
	});
});

// Warkworth-46 PR-1 (F3, F4, F5): the diagnostic log writes one file, in the plugin's own folder.
describe("fence: the diagnostic log writer is the only adapter write site and writes one file (F3)", () => {
	const code = readFileSync(LOG_WRITER, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

	it("src/diagnostic-log-writer.ts is the only file in src/ with an adapter write call", () => {
		const writers = srcFiles.filter((f) => ADAPTER_WRITE.test(readFileSync(f, "utf8"))).map((f) => f.slice(SRC.length + 1));
		expect(writers).toEqual(["diagnostic-log-writer.ts"]);
	});

	it("it calls only exists, read, write and append on the adapter, and always on this.path", () => {
		const calls = [...code.matchAll(/\badapter\.(\w+)\(([^,)]*)/g)];
		expect(calls.length).toBeGreaterThan(0);
		for (const [, method, firstArg] of calls) {
			expect(["exists", "read", "write", "append"]).toContain(method);
			expect(firstArg.trim()).toBe("this.path");
		}
	});

	it("this.path is built from the plugin folder it is given plus the diagnostic-log.jsonl constant, and nothing else", () => {
		const assignments = [...code.matchAll(/this\.path\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
		expect(assignments).toEqual(["`${pluginDir}/${DIAGNOSTIC_LOG_FILE}`"]);
		expect(code).toMatch(/export const DIAGNOSTIC_LOG_FILE = "diagnostic-log\.jsonl";/);
	});

	it("main.ts gives it manifest.dir (the plugin's own folder), not a vault path", () => {
		const main = readFileSync(join(SRC, "main.ts"), "utf8");
		expect(main).toMatch(/new DiagnosticLogWriter\(\s*this\.app\.vault\.adapter,\s*this\.manifest\.dir \?\?/);
	});

	it("main.ts's fallback when manifest.dir is absent is the plugin's own folder under the config folder, nothing else", () => {
		// `manifest.dir` is optional in Obsidian's typings. The spec said "only manifest.dir plus the
		// constant"; this one fallback is a deliberate, documented deviation (see the PR description).
		const main = readFileSync(join(SRC, "main.ts"), "utf8");
		const call = /new DiagnosticLogWriter\(\s*this\.app\.vault\.adapter,\s*([^;]+?),?\s*\);/.exec(main);
		expect(call?.[1].trim()).toBe("this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`");
	});
});

describe("fence: the diagnostic log adds no dependency, setting or UI (F4, F5, F6)", () => {
	it("package.json has no runtime dependencies", () => {
		const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
		expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
	});

	it("the settings tab is not touched: it does not mention the log", () => {
		expect(readFileSync(join(SRC, "settings-tab.ts"), "utf8")).not.toMatch(/diagnostic/i);
	});

	it("the log modules import nothing but each other", () => {
		for (const name of ["diagnostic-log.ts", "diagnostic-log-writer.ts"]) {
			const imports = [...readFileSync(join(SRC, name), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
			for (const spec of imports) expect(spec, name).toBe("./diagnostic-log");
		}
	});
});
