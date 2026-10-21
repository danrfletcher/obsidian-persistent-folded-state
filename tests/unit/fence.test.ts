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
	// R4: main.js is built as CJS (esbuild.config.mjs `format: "cjs"`), so a bundled network
	// module shows up as `require("http")`, not `from "http"`. Checked for src/ too (harmless).
	{ label: 'node:http require("http")', pattern: /\brequire\s*\(\s*["'](node:)?http["']\s*\)/ },
	{ label: 'node:https require("https")', pattern: /\brequire\s*\(\s*["'](node:)?https["']\s*\)/ },
	{ label: 'node:net require("net")', pattern: /\brequire\s*\(\s*["'](node:)?net["']\s*\)/ },
	{ label: 'node:dgram require("dgram")', pattern: /\brequire\s*\(\s*["'](node:)?dgram["']\s*\)/ },
	{ label: "posthog/analytics SDK", pattern: /posthog|mixpanel|segment\.io|amplitude|@sentry/i },
];

const UI_SURFACE: { label: string; pattern: RegExp }[] = [
	{ label: "addRibbonIcon", pattern: /\baddRibbonIcon\s*\(/ },
	{ label: "addStatusBarItem", pattern: /\baddStatusBarItem\s*\(/ },
	{ label: "registerView", pattern: /\bregisterView\s*\(/ },
];

describe("fence: the network patterns really match the shapes they exist to catch (R4)", () => {
	it.each([
		['import x from "http"', "node:http import"],
		["import x from 'node:https'", "node:https import"],
		['var import_http = require("http");', 'node:http require("http")'],
		["var h = require('node:https');", 'node:https require("https")'],
		['const n = require( "net" )', 'node:net require("net")'],
		['const d = require("node:dgram")', 'node:dgram require("dgram")'],
	])("%s is caught by %s", (sample, label) => {
		const rule = FORBIDDEN.find((f) => f.label === label);
		expect(rule).toBeDefined();
		expect(sample).toMatch(rule!.pattern);
	});

	it("does not flag the externals the bundle legitimately requires", () => {
		const bundleLike = 'require("obsidian"); require("@codemirror/state"); require("@codemirror/view"); require("httpx-not-a-module");';
		for (const { pattern } of FORBIDDEN) expect(bundleLike).not.toMatch(pattern);
	});
});

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
