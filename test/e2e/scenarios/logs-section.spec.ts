import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { openLogsSection, openSettingsTab } from "../helpers/logs";

// #434/#453: the Logs section replaced the right-sidebar debug pane. Debug
// logging on drives a Logs section after Advanced, live and in place (no tab
// re-render, scroll survives): sync details line with real values, All /
// Warnings / Errors filter tabs, a fixed-height scrollable monospace log box
// fed by the real ring buffer, Copy logs, and Debug logging off removes the
// section. Screenshot gate: expanded with real lines, Errors filter, off.

const PASSPHRASE = "logs-pass";

const LOGS_HEADING = `.geode-section:has(.setting-item-heading:has-text("Logs"))`;

async function readScroll(o: { eval: <T>(s: string) => Promise<T> }): Promise<number> {
  return await o.eval<number>(`
    (() => {
      const candidates = [".vertical-tab-content", ".modal.mod-settings .modal-content"];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el && el.scrollTop > 0) return el.scrollTop;
      }
      return 0;
    })()
  `);
}

/** Toggle a settings checkbox without the native click's focus-scroll (#134 pattern). */
async function toggleCheckbox(
  o: { eval: <T>(s: string) => Promise<T> },
  sel: string,
): Promise<void> {
  await o.eval(`
    (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) throw new Error("toggleCheckbox: no element for " + ${JSON.stringify(sel)});
      el.checked = !el.checked;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()
  `);
}

test("logs section: real details/log, filters, in-place toggle, no re-render", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("logs");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await openSettingsTab(o);

    /* ---- 1. The Logs section sits after Advanced, collapsed by default ---- */
    const headings = (await o.win
      .locator(".vertical-tab-content .geode-section .setting-item-heading")
      .allTextContents()).map((h) => h.trim());
    expect(headings, "section order with Logs last").toEqual(
      ["Status", "Vault", "Devices", "Sync scope", "Trash", "Advanced", "Logs"],
    );
    await expect(o.win.locator(`${LOGS_HEADING} .geode-section-fields`)).toHaveClass(
      /geode-collapsed/,
    );

    /* ---- 2. Expand: real details line, filter tabs, log box with ring lines ---- */
    await o.win.locator(`${LOGS_HEADING} .geode-collapsible-heading`).click();
    await expect(o.win.locator('[data-testid="geode-log-box"]')).toBeVisible({ timeout: 10_000 });

    const details = o.win.locator('[data-testid="geode-log-details"]');
    await expect
      .poll(async () => (await details.textContent()) ?? "", { timeout: 15_000 })
      .toMatch(/^Connected · seq \d+ · \d+ pending$/);

    const lines = o.win.locator('[data-testid="geode-log-box"] .geode-log-line');
    await expect.poll(async () => await lines.count(), { timeout: 15_000 }).toBeGreaterThan(0);

    await expect(o.win.locator('[data-testid="geode-log-filter-all"]')).toHaveClass(/is-active/);
    await expect(o.win.locator('[data-testid="geode-log-filter-warn"]')).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-log-filter-error"]')).toBeVisible();

    /* ---- Screenshot 1: expanded with real lines (All filter), scrolled into view ---- */
    await o.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await o.win.waitForTimeout(300);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("434-01-logs-expanded.png"),
    });

    /* ---- 3. Errors filter shows only error lines ---- */
    // Generate a REAL error through the misconfigured-vault path (empty salt →
    // unlockVault logs "no salt configured") so the Errors view has content.
    await o.eval(`
      const geode = app.plugins.plugins.geode;
      const saved = geode.pluginSettings.salt;
      geode.pluginSettings.salt = "";
      await geode.unlockVault("anything");
      geode.pluginSettings.salt = saved;
      return true;
    `);
    await expect
      .poll(
        async () =>
          await o.eval<boolean>(
            `app.plugins.plugins.geode.getRecentLog().some((e) => e.level === "error")`,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    await o.win.locator('[data-testid="geode-log-filter-error"]').click();
    await expect(o.win.locator('[data-testid="geode-log-filter-error"]')).toHaveClass(/is-active/);
    await expect(o.win.locator('[data-testid="geode-log-filter-all"]')).not.toHaveClass(
      /is-active/,
    );
    await expect.poll(async () => await lines.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    const classes = await o.win.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="geode-log-box"] .geode-log-line'))
        .map((l) => l.className)
    );
    for (const c of classes) {
      expect(c, "every filtered line is an error line").toContain("geode-log-error");
    }

    /* ---- Screenshot 2: Errors filter ---- */
    await o.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await o.win.waitForTimeout(300);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("434-02-logs-errors.png"),
    });

    /* ---- 4. In-place toggle: no re-render, scroll survives (#134 pattern) ---- */
    // Mark Advanced so a full display() would destroy it; scroll to a fixed
    // offset (not the bottom: removing the last section clamps scrollTop there).
    await o.eval(`
      const adv = Array.from(document.querySelectorAll(".geode-section"))
        .find((s) => s.querySelector(".setting-item-heading")?.textContent?.trim() === "Advanced");
      if (adv) adv.dataset.e2eMarker = "no-rerender";
      const el = document.querySelector(".vertical-tab-content");
      if (el) el.scrollTop = 150;
      return true;
    `);
    const markerPresent = (): Promise<boolean> =>
      o.eval<boolean>(
        `!!document.querySelector('.geode-section[data-e2e-marker="no-rerender"]')`,
      );
    const before = await readScroll(o);
    expect(before, "settings pane should be scrollable").toBeGreaterThan(0);

    // Off: the section is removed in place, marker + scroll survive.
    await toggleCheckbox(o, '[data-testid="geode-settings-toggle-debug"]');
    await expect(o.win.locator(LOGS_HEADING)).toHaveCount(0, { timeout: 10_000 });
    await expect.poll(markerPresent, { timeout: 10_000 }).toBe(true);
    const afterOff = await readScroll(o);
    expect(Math.abs(afterOff - before), "scrollTop unchanged after removing Logs")
      .toBeLessThanOrEqual(1);

    /* ---- Screenshot 3: Debug logging off = no Logs section (scrolled to Advanced) ---- */
    await o.eval(`
      const adv = Array.from(document.querySelectorAll(".geode-section"))
        .find((s) => s.querySelector(".setting-item-heading")?.textContent?.trim() === "Advanced");
      const fields = adv?.querySelector(".geode-section-fields");
      if (adv && fields?.classList.contains("geode-collapsed")) {
        adv.querySelector(".geode-collapsible-heading")?.click();
      }
      adv?.scrollIntoView({ block: "start" });
      return true;
    `);
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await o.win.waitForTimeout(300);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("434-03-debug-off.png"),
    });

    // On: the section comes back in place (still expanded: the session's open state survives).
    const scrollBeforeOn = await readScroll(o);
    await toggleCheckbox(o, '[data-testid="geode-settings-toggle-debug"]');
    await expect(o.win.locator('[data-testid="geode-log-box"]')).toBeVisible({ timeout: 10_000 });
    await expect.poll(markerPresent, { timeout: 10_000 }).toBe(true);
    const afterOn = await readScroll(o);
    expect(Math.abs(afterOn - scrollBeforeOn), "scrollTop unchanged after re-adding Logs")
      .toBeLessThanOrEqual(1);

    // The re-added section still streams the ring (live append).
    const countBefore = await lines.count();
    await o.eval(`
      await app.vault.create("note.md", "# gate434\\ntest\\n");
      return true;
    `);
    await expect
      .poll(async () => await lines.count(), { timeout: 15_000 })
      .toBeGreaterThan(countBefore);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("blocked transport shows Blocked in the log details line", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("blocked");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await openLogsSection(o);

    /* Details line starts with the connected state. */
    await expect
      .poll(
        async () =>
          await o.eval<string>(
            `document.querySelector('[data-testid="geode-log-details"]')?.textContent ?? ""`,
          ),
        { timeout: 15_000 },
      )
      .toMatch(/^Connected · seq \d+ · \d+ pending$/);

    /* Drive the real blocked state the server_version_mismatch message produces:
       transport.blocked + the session's onBlocked handler. getTransportState()
       must then report "blocked" and the details line must render Blocked. */
    await o.eval(`
      const geode = app.plugins.plugins.geode;
      geode.transport.blocked = true;
      geode.onBlocked("9.9.9", "0.0.1");
      return true;
    `);

    await expect
      .poll(
        async () =>
          await o.eval<string>(
            `document.querySelector('[data-testid="geode-log-details"]')?.textContent ?? ""`,
          ),
        { timeout: 15_000 },
      )
      .toMatch(/^Blocked · seq \d+ · \d+ pending$/);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
