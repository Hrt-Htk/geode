// Machine-specific E2E values (phone serial, server URL, seed vault, …) come from
// the environment: never from a personal default baked into the repo. Locally they
// live in the gitignored `.env.local` at the repo root (see the committed
// `.env.example`); CI sets none of them and needs none.

/**
 * Runtime-neutral env read. The fixtures run under Playwright (node); everything
 * else runs under Deno, whose `process` shim shares `Deno.env`'s store.
 */
function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
  return proc?.env[name];
}

/** The value of `name`, or a failure naming the variable and where to put it. */
export function requireEnv(name: string): string {
  const value = readEnv(name)?.trim();
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local at the repo root and fill it ` +
        `in, or export ${name} before running.`,
    );
  }
  return value;
}

/**
 * Absolute on-device path of the test vault E2E resets and installs into
 * (`GEODE_PHONE_VAULT`). Global setup compares `app.vault.getName()` against this
 * directory's name before any reset; no vault name is baked into the repo.
 */
export function phoneTestVault(): string {
  const vault = requireEnv("GEODE_PHONE_VAULT").replace(/\/+$/, "");
  if (!vault) {
    throw new Error("GEODE_PHONE_VAULT must be a vault folder, not a filesystem root");
  }
  return vault;
}
