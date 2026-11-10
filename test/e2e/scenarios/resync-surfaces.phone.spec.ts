import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { expectFits } from "../helpers/fit";
import { waitForUnlocked } from "../helpers/geode";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import {
  confirmOpen,
  noticeTexts,
  resyncButtonText,
  seedResyncFiles,
  statusRowText,
  trackedCount,
} from "../helpers/resync";
import { openSettingsPage, useDisplayPath } from "../helpers/settings-tab";
import { shotPath } from "../helpers/shots";
import { waitForStatusBar } from "../helpers/waits";

// #54: the resync surfaces on device (phone counterpart of resync-surfaces.spec.ts).
// Real resync on the real vault: on-device applies are slow enough that the running
// state is shot as it happens, not frozen.
const PASSPHRASE = "resync-surfaces-phone";
const NOTES = 12;

test("resync surfaces on device: confirm, running, done, stopped", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("resync-surfaces-phone");
  const o = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      debugLogging: true,
    },
  });

  try {
    await o.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(o);
    await waitForStatusBar(o, "Geode: synced", 60_000);
    await seedResyncFiles(o, { notes: NOTES });
    await expect.poll(async () => await trackedCount(o), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(NOTES);
    await waitForStatusBar(o, "Geode: synced", 120_000);

    await dismissModals(o);
    await o.eval(`
      app.setting.open();
      app.setting.openTabById(app.plugins.plugins.geode.manifest.id);
      return true;
    `);
    // Status and Advanced in one pane, the way the mockup lays them out.
    await useDisplayPath(o);
    await openSettingsPage(o, "Advanced");
    await scrollToRow(o, "Resync from scratch");

    /* ---- Confirm ---- */
    await evalClick(o, '[data-testid="geode-settings-resync"]');
    await expect.poll(async () => await confirmOpen(o), { timeout: 15_000 }).toBe(true);
    // #638: the dialog carries two lines now; nothing may hang past its bounds.
    await expectFits(o.win.locator(".geode-confirm-modal"));
    await o.screenshot(shotPath("1-confirm-phone"));

    /* ---- Running ---- */
    await scrollToRow(o, "Sync status");
    await evalClick(o, '[data-testid="geode-confirm-yes"]');
    await expect.poll(async () => await statusRowText(o), { timeout: 60_000 }).toContain(
      "Resyncing",
    );
    await o.screenshot(shotPath("2-running-status-row-phone"));
    await scrollToRow(o, "Resync from scratch");
    await o.screenshot(shotPath("3-running-resync-row-phone"));

    /* ---- Done ---- */
    await expect.poll(async () => await statusRowText(o), { timeout: 300_000 }).toContain(
      "Up to date",
    );
    await scrollToRow(o, "Resync from scratch");
    await expect.poll(async () => await resyncButtonText(o), { timeout: 15_000 })
      .toBe("Resync from scratch");
    await o.screenshot(shotPath("4-done-resync-row-phone"));
    await scrollToRow(o, "Sync status");
    await o.screenshot(shotPath("5-done-status-row-phone"));

    // #54: a resync that finishes leaves no error in the ring buffer.
    expect(
      await o.eval<string[]>(`app.plugins.plugins.geode.getRecentLog()
        .filter((e) => e.level === "error")
        .map((e) => e.msg)`),
    ).toEqual([]);

    /* ---- Stopped ---- */
    await expect.poll(async () => await noticeCount(o), { timeout: 20_000 }).toBe(0);
    await server.stop();
    await scrollToRow(o, "Resync from scratch");
    await evalClick(o, '[data-testid="geode-settings-resync"]');
    await expect.poll(async () => await confirmOpen(o), { timeout: 15_000 }).toBe(true);
    await evalClick(o, '[data-testid="geode-confirm-yes"]');
    // #54 review: the restarted session is offline, and that outage outranks the stopped
    // row; the notice carries the reason and the button the retry.
    await expect.poll(async () => await resyncButtonText(o), { timeout: 120_000 }).toBe(
      "Try again",
    );
    await expect.poll(async () => await noticeTexts(o), { timeout: 15_000 }).toContain(
      "Geode: resync stopped. Server unreachable.",
    );
    await o.screenshot(shotPath("6-stopped-resync-row-phone"));
    await scrollToRow(o, "Sync status");
    const rowText = await statusRowText(o);
    expect(rowText.startsWith("Offline. Retrying") || rowText.startsWith("Resync stopped")).toBe(
      true,
    );
    await o.screenshot(shotPath("7-stopped-status-row-phone"));
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

type Phone = Awaited<ReturnType<typeof connectPhone>>;

/** Put the named settings row at the top of the pane, without scrolling animation. */
function scrollToRow(o: Phone, name: string): Promise<boolean> {
  return o.eval<boolean>(`(() => {
    const row = [...document.querySelectorAll(".modal.mod-settings .setting-item")]
      .find((r) => r.querySelector(".setting-item-name")?.textContent?.trim() === ${
    JSON.stringify(name)
  });
    const pane = document.querySelector(".vertical-tab-content")
      ?? document.querySelector(".modal.mod-settings .modal-content");
    if (!row || !pane) return false;
    const offset = row.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    pane.scrollTop = Math.max(0, offset - 40);
    return true;
  })()`);
}

function noticeCount(o: Phone): Promise<number> {
  return o.eval<number>(`document.querySelectorAll(".notice").length`);
}
