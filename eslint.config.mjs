import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{
		ignores: ["main.js", "tests/**", "*.config.mjs", "*.config.ts"],
	},
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.*", "esbuild.config.mjs"],
				},
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		// Deliberate, reviewed trade-off (see the file comment in src/settings-tab.ts): this
		// one-control settings tab keeps the classic imperative `display()` API instead of
		// adopting 1.13.0's declarative `getSettingDefinitions()`, so it won't appear in
		// Obsidian's own in-app settings search. An inline eslint-disable for this is not an
		// option — eslint-comments/no-restricted-disable forbids suppressing any
		// `obsidianmd/*` rule with a comment — so the exception is recorded here instead,
		// where it stays visible and reviewable.
		files: ["src/settings-tab.ts"],
		rules: {
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
]);
