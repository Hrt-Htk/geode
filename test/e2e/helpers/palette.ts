import type { Page } from "@playwright/test";

/**
 * Geode command name → Obsidian command ID mapping.
 * Full ID is `geode:<id>` (plugin ID prefix is auto-added).
 * Mirrors plugin/plumbing/commands.ts: keep in sync.
 */
const COMMAND_IDS: Record<string, string> = {
  "Geode: Push now": "geode:geode-push-now",
  "Geode: Reconcile now": "geode:geode-reconcile-now",
  "Geode: Unlock vault": "geode:geode-unlock",
  "Geode: Lock vault": "geode:geode-lock",
  "Geode: Resync from scratch": "geode:geode-resync",
  "Geode: Export decrypted vault to folder...": "geode:geode-export-decrypted-vault",
};

/**
 * Run a Geode command via `app.commands.executeCommandById`.
 * Works on both desktop and Android (Control+P does not fire on mobile WebView).
 */
export async function runCommand(win: Page, commandName: string): Promise<void> {
  const id = COMMAND_IDS[commandName];
  if (!id) {
    throw new Error(`Unknown command name: ${commandName}. Add it to COMMAND_IDS.`);
  }
  await win.evaluate((cmdId: string) => {
    return (window as any).app?.commands?.executeCommandById(cmdId);
  }, id);
}
