import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["plugin/_generated/**"] },
  {
    files: ["plugin/**/*.ts", "core/**/*.ts", "server/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.lint.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
      complexity: ["error", 15],
      "max-depth": ["error", 4],
    },
  },
  {
    // The community scanner ruleset (#13). It applies only to what ships to
    // Obsidian: the plugin and the core/ modules bundled into it.
    files: ["plugin/**/*.ts", "core/**/*.ts"],
    extends: [
      obsidianmd.configs.recommended,
      {
        // Rules a later sub-issue turns back on; each is a sweep of its own.
        rules: {
          // #14: window timers, globals, the config dir, command ids and names,
          // the fetch exception on mobile, sentence case, createEl, TFile casts.
          "obsidianmd/prefer-window-timers": "off",
          "obsidianmd/no-global-this": "off",
          "obsidianmd/hardcoded-config-path": "off",
          "obsidianmd/commands/no-plugin-id-in-command-id": "off",
          "obsidianmd/commands/no-plugin-name-in-command-name": "off",
          "no-restricted-globals": "off",
          "obsidianmd/ui/sentence-case": "off",
          "obsidianmd/prefer-create-el": "off",
          "obsidianmd/no-tfile-tfolder-cast": "off",
          // #15: recovery.ts imports node:fs/promises and node:path at the top
          // level (breaks mobile); they move behind a desktop-only import.
          "obsidianmd/no-nodejs-modules": "off",
          // #16: the settings tab renders in display(); it moves to
          // getSettingDefinitions().
          "obsidianmd/settings-tab/prefer-setting-definitions": "off",
        },
      },
    ],
  },
  {
    // core/ stays dependency-free: no plugin/ or server/ imports.
    files: ["core/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/plugin/**"], message: "core/ must not import from plugin/" },
          { group: ["**/server/**"], message: "core/ must not import from server/" },
        ],
      }],
    },
  },
  {
    // server/ is the relay: no plugin/ imports.
    files: ["server/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/plugin/**"], message: "server/ must not import from plugin/" },
        ],
      }],
    },
  },
);
