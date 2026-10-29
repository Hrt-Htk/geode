import { expect } from "@playwright/test";
import type { Evaluatable } from "./device-abstraction";

// #434: shared Logs-section driving for specs that read the debug output.
// The Logs section lives in the settings tab after Advanced, only while
// Advanced → Debug logging is on, collapsed by default.

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

/** Expand the Logs section (no-op when already open). Throws when it is absent (Debug logging off). */
export async function expandLogsSection(instance: Evaluatable): Promise<void> {
  const present = await instance.eval<boolean>(`
    (() => {
      const sections = Array.from(document.querySelectorAll(".geode-section"));
      const logs = sections.find((s) =>
        s.querySelector(".setting-item-heading")?.textContent?.trim() === "Logs");
      if (!logs) return false;
      const fields = logs.querySelector(".geode-section-fields");
      if (fields?.classList.contains("geode-collapsed")) {
        logs.querySelector(".geode-collapsible-heading")?.click();
      }
      return true;
    })()
  `);
  if (!present) throw new Error("expandLogsSection: Logs section not present (Debug logging off?)");
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
