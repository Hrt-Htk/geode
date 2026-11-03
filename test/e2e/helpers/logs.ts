import { expect } from "@playwright/test";
import type { Evaluatable } from "./device-abstraction";
import { openSettingsPage } from "./settings-tab";

// #434: shared Logs-section driving for specs that read the debug output.
// The Logs rows show only while Advanced → Debug logging is on: a sub-page on
// Obsidian 1.13+, a collapsed section after Advanced on display() (#16).

/** Open the Geode settings tab. Desktop closes first; mobile must NOT (it prevents the tab from rendering). */
export async function openSettingsTab(instance: Evaluatable, mobile = false): Promise<void> {
  await instance.eval(`
    (() => {
      if (!${mobile} && app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return true;
    })()
  `);
  await expect
    .poll(
      async () =>
        await instance.eval<boolean>(
          `!!document.querySelector('[data-testid="geode-settings-sync-status"]')`,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** Show the Logs rows (the sub-page on 1.13+, the section on display()). Throws when Debug
 * logging is off. */
export async function expandLogsSection(instance: Evaluatable): Promise<void> {
  await openSettingsPage(instance, "Logs");
  await expect
    .poll(
      async () =>
        await instance.eval<boolean>(`
          (() => {
            const box = document.querySelector('[data-testid="geode-log-box"]');
            return !!box && box.offsetParent !== null;
          })()
        `),
      { timeout: 10_000 },
    )
    .toBe(true);
}

/** Open settings and expand the Logs section. */
export async function openLogsSection(instance: Evaluatable, mobile = false): Promise<void> {
  await openSettingsTab(instance, mobile);
  await expandLogsSection(instance);
}
