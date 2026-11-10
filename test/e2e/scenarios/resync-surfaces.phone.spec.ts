import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { expectFits } from "../helpers/fit";
import { waitForUnlocked } from "../helpers/geode";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
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
    await seed(o);
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
    await expect.poll(async () => await statusRowText(o), { timeout: 120_000 }).toContain(
      "Resync stopped",
    );
    await expect.poll(async () => await resyncButtonText(o), { timeout: 15_000 }).toBe("Try again");
    await o.screenshot(shotPath("6-stopped-resync-row-phone"));
    await scrollToRow(o, "Sync status");
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

function statusRowText(o: Phone): Promise<string> {
  return o.eval<string>(`
    (() => {
      const row = document.querySelector('[data-testid="geode-settings-sync-status"]');
      return row?.querySelector(".setting-item-description")?.textContent?.trim() ?? "";
    })()
  `);
}

function resyncButtonText(o: Phone): Promise<string> {
  return o.eval<string>(`
    (() => {
      const btn = document.querySelector('[data-testid="geode-settings-resync"]');
      return btn?.textContent?.trim() ?? "";
    })()
  `);
}

function confirmOpen(o: Phone): Promise<boolean> {
  return o.eval<boolean>(`!!document.querySelector(".geode-confirm-modal")`);
}

function noticeCount(o: Phone): Promise<number> {
  return o.eval<number>(`document.querySelectorAll(".notice").length`);
}

function trackedCount(o: Phone): Promise<number> {
  return o.eval<number>(`
    (() => {
      const state = app.plugins.plugins.geode.syncManager?.state;
      return state ? [...state.getAllLocalFiles().values()].filter((r) => !r.deleted).length : 0;
    })()
  `);
}

async function seed(o: Phone): Promise<void> {
  await o.eval(`
    const files = [];
    for (let index = 0; index < ${NOTES}; index++) {
      files.push({ path: "notes/note-" + String(index).padStart(3, "0") + ".md", size: 700 + index });
    }
    for (const [index, file] of files.entries()) {
      let state = 7919 + index * 104729;
      const bytes = new Uint8Array(file.size);
      for (let i = 0; i < bytes.length; i++) {
        state = (state * 1103515245 + 12345) % 2147483648;
        bytes[i] = state & 0xff;
      }
      if (!(await app.vault.adapter.exists("notes"))) await app.vault.createFolder("notes");
      await app.vault.createBinary(file.path, bytes.buffer);
    }
    await app.plugins.plugins.geode.syncManager.handlePendingOps(
      files.map((file) => ({ path: file.path, kind: "commit" })),
    );
    return true;
  `);
}
