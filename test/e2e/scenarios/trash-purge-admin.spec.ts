import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { enterAdminToken } from "../helpers/admin-token";
import {
  IN_FLOOR_PURGE_ASK,
  IN_FLOOR_PURGE_CANCELLED,
  IN_FLOOR_PURGE_TITLE,
  purgedOneNotice,
} from "../../../plugin/ui/trash-format";

// #677: a device token may only purge a trash row past the server's retention floor.
// Inside it the trash modal asks for the admin token (the Devices view's prompt), and a
// prompt dismissed without one purges nothing and says so.

const PASSPHRASE = "purge-admin-pass";
const NOTE_PATH = "notes/keep-me.md";
const NOTE_CONTENT = "# keep me\nPurged through the admin token.\n";

test("trash purge: inside the retention floor asks for the admin token", async () => {
  test.slow();

  const server = await startServer(); // default 30-day retention floor
  const device = await server.mintToken("purge-admin");

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

    /* ---- A note, then deleted: one fresh trash row, well inside the floor ---- */
    await upsertVaultFile(o, NOTE_PATH, NOTE_CONTENT);
    await commitPath(o, NOTE_PATH, "commit");
    await o.eval(`
      const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
      if (!file) throw new Error("expected the note to delete");
      await app.vault.delete(file);
      return true;
    `);
    await commitPath(o, NOTE_PATH, "delete");
    await expect
      .poll(
        async () => await o.eval<number>("(await app.plugins.plugins.geode.trash.list()).length"),
        {
          timeout: 30_000,
        },
      )
      .toBe(1);

    await o.eval(`app.plugins.plugins.geode.openTrashModal(); return true;`);
    const purge = o.win.locator('[data-testid="geode-trash-purge"]');
    await expect(purge).toHaveCount(1, { timeout: 30_000 });
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);

    /* ---- Purge → confirm → the admin token prompt, not an erase ---- */
    await purge.click();
    await expect(o.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await o.win.locator('[data-testid="geode-confirm-yes"]').click();

    const prompt = o.win.locator(".geode-admin-token-modal");
    await expect(prompt).toBeVisible({ timeout: 20_000 });
    await expect(prompt).toContainText(IN_FLOOR_PURGE_TITLE);
    await expect(prompt).toContainText(IN_FLOOR_PURGE_ASK);
    await prompt.screenshot({ path: shotPath("677-01-admin-prompt.png") });

    /* ---- Dismissed without a token: nothing deleted, a plain message ---- */
    await o.eval(`
      const buttons = [...document.querySelectorAll(".geode-admin-token-modal button")];
      const cancel = buttons.find((b) => b.textContent === "Cancel");
      if (!cancel) throw new Error("expected a Cancel button on the admin token prompt");
      cancel.click();
      return true;
    `);
    await expect(prompt).toHaveCount(0, { timeout: 10_000 });
    const notice = o.win.locator(".notice").last();
    await expect(notice).toContainText(IN_FLOOR_PURGE_CANCELLED, { timeout: 10_000 });
    // The notice element itself (the full-window shot clips a long notice at the edge),
    // then the whole window: the row is still there behind the plain message.
    await notice.screenshot({ path: shotPath("677-04-cancelled-notice.png") });
    await o.win.screenshot({ path: shotPath("677-02-cancelled-row-survives.png") });
    await expect(purge).toHaveCount(1, { timeout: 10_000 });
    expect(await o.eval<number>("(await app.plugins.plugins.geode.trash.list()).length")).toBe(1);

    /* ---- Again with the admin token: the row and its history go ---- */
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await purge.click();
    await expect(o.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await o.win.locator('[data-testid="geode-confirm-yes"]').click();
    await enterAdminToken(o);

    await expect(o.win.locator('[data-testid="geode-trash-empty"]')).toBeVisible({
      timeout: 30_000,
    });
    const purgedNotice = o.win.locator(".notice").last();
    await expect(purgedNotice).toContainText(purgedOneNotice(NOTE_PATH), { timeout: 10_000 });
    await o.win.screenshot({ path: shotPath("677-03-purged-with-admin.png") });
    expect(await o.eval<number>("(await app.plugins.plugins.geode.trash.list()).length")).toBe(0);

    expect(o.consoleErrors()).toEqual([]);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
