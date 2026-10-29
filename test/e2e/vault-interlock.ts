// Refuse to wipe a vault that is not the one GEODE_PHONE_VAULT names. Global setup
// checks once per run, but a spec can set GEODE_PHONE_RESET mid-run (#gate7), so
// every destructive wipe site calls the guard itself, right before deleting.
// The comparison is pure so `deno test` can cover the refusal without a device.

import { basename } from "node:path";
import { phoneTestVault } from "./env.ts";

/** Why resetting is unsafe, or null when `openName` is the vault at `vaultPath`. */
export function vaultNameProblem(openName: string, vaultPath: string): string | null {
  const expected = basename(vaultPath);
  if (openName === expected) return null;
  return `GEODE_PHONE_RESET interlock: the open vault is ${JSON.stringify(openName)}, not ${
    JSON.stringify(expected)
  }: ` +
    `refusing to reset. Open the "${expected}" test vault on the phone (or launch ` +
    "Obsidian into it) and re-run, or point GEODE_PHONE_VAULT at your test vault.";
}

/** Throws unless the open vault is the one GEODE_PHONE_VAULT names. */
export function assertTestVault(openName: string): void {
  const problem = vaultNameProblem(openName, phoneTestVault());
  if (problem) throw new Error(problem);
}
