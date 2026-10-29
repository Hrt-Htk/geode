import tseslint from "typescript-eslint";

export default tseslint.config(
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
