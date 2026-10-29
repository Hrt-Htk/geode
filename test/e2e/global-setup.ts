// Acquires the shared test-phone flock for the whole run and runs the test-vault
// interlock before any GEODE_PHONE_RESET. Desktop-only runs (no GEODE_PHONE)
// take no lock, so `--project=default` never queues. The returned function is
// Playwright's global teardown: it releases the lock after the last test, and a
// SIGKILLed runner releases it too, because the flock child's stdin pipe closes
// with the parent (test/e2e/phone-lock.ts).
//
// #519: setup and teardown free the fixed server port (test/e2e/server-port.ts).

import { statSync } from "node:fs";
import { requireEnv } from "./env.ts";
import { cdpEvalOnDevice } from "./phone-cdp";
import { acquirePhoneLock } from "./phone-lock";
import { freeServerPort } from "./server-port";
import { hybridInRun, seedDirProblem } from "./seed-guard";
import { assertTestVault } from "./vault-interlock";

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!process.env.GEODE_PHONE) return async () => {};

  // No ADB default: the run targets whatever ANDROID_SERIAL names (see .env.example).
  const serial = requireEnv("ANDROID_SERIAL");

  // #518: a hybrid run reads the seed vault in place; fail before the first
  // test instead of mid-suite in seedFiles. Hybrid specs skip without GEODE_PHONE.
  const problem = seedDirProblem(
    hybridInRun(process.argv),
    process.env.GEODE_SEED_VAULT_DIR,
    (dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    },
  );
  if (problem) throw new Error(problem);

  const serverPort = Number(process.env.GEODE_PHONE_SERVER_PORT ?? "8099");
  const { release } = await acquirePhoneLock();
  try {
    await freeServerPort(serverPort);
    if (process.env.GEODE_PHONE_RESET === "1") {
      assertTestVault(await cdpEvalOnDevice(serial, "app.vault.getName()"));
    }
    return async () => {
      try {
        await freeServerPort(serverPort);
      } finally {
        await release();
      }
    };
  } catch (err) {
    await release();
    throw err;
  }
}
