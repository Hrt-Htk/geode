// #518: fail-fast decision for hybrid runs without a usable GEODE_SEED_VAULT_DIR.
// Pure (no Playwright, no fs) so it is unit-testable with `deno test`.

/**
 * True when the "hybrid" project is part of the Playwright run. Playwright does
 * not expose the selected projects to global setup, so read the CLI args of the
 * runner process: no `--project` flag means all projects run.
 */
export function hybridInRun(argv: string[]): boolean {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--project") {
      while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        values.push(...argv[++i].split(","));
      }
    } else if (arg.startsWith("--project=")) {
      values.push(...arg.slice("--project=".length).split(","));
    }
  }
  return values.length === 0 || values.includes("hybrid");
}

/** Error message when a hybrid run has no usable seed dir, else null. */
export function seedDirProblem(
  inRun: boolean,
  seedDir: string | undefined,
  isDirectory: (dir: string) => boolean,
): string | null {
  if (!inRun) return null;
  if (!seedDir) {
    return "GEODE_SEED_VAULT_DIR is not set: hybrid runs need it pointing at a real vault " +
      "(used read-only)";
  }
  if (!isDirectory(seedDir)) return `GEODE_SEED_VAULT_DIR is not a directory: ${seedDir}`;
  return null;
}
