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
          // The rule's `brands` option replaces its default list, so restate the
          // names UI text may use and add the plugin's own.
          "obsidianmd/ui/sentence-case": ["warn", {
            enforceCamelCaseLower: true,
            brands: ["Geode", "Obsidian", "iOS", "iPadOS", "Android", "Windows", "macOS", "Linux"],
          }],
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
