import { expect, test } from "@playwright/test";
import { connectPhone, type PhoneInstance } from "../fixtures/phone-obsidian";
import { requireDataDir, useRemoteServer } from "../fixtures/phone-server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { serverTrashCount, unlockIfLocked, waitForServerState } from "../helpers/interrupt";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";
import { enterAdminToken } from "../helpers/admin-token";

// #493 flow c (phone): EXPECTED: the phone is force-stopped mid trash restore (server restore
// committed, file not yet applied locally) → a relaunch converges the file back with its
// exact content and the trash is empty (restore is idempotent: nothing left to retry).
// Force-stop mid trash purge (server row gone) → a relaunch keeps the file deleted and the
// trash lists clean (empty, no error state): purge never half-deletes in a way that breaks
// listing.
const PASSPHRASE = "interrupt-trash-phone-pass";
const NOTE_PATH = "trash/phone-interrupt-me.md";
const NOTE_CONTENT = "# Phone interrupt me\nThis content must survive the kill.\n";
const MOBILE = '[data-testid="geode-mobile-status"]';

async function unlockAndSync(obsidian: PhoneInstance): Promise<void> {
  await expect
    .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 30_000 })
    .toBe("Geode: locked");
  await obsidian.eval(
    `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
  );
  await waitForUnlocked(obsidian);
  await waitForStatusBar(obsidian.win, "Geode: synced", 120_000);
  await dismissModals(obsidian);
}

async function trashOneNote(obsidian: PhoneInstance): Promise<void> {
  /* commitPath waits for this specific file to land (the .obsidian config files commit
     first, so a bare version-count wait would return before it). */
  await upsertVaultFile(obsidian, NOTE_PATH, NOTE_CONTENT);
  await commitPath(obsidian, NOTE_PATH, "commit");
  await obsidian.eval(`
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
    if (!file) throw new Error("expected file to delete");
    await app.vault.delete(file);
    return true;
  `);
  await commitPath(obsidian, NOTE_PATH, "delete");
  await expect
    .poll(() => obsidian.eval<number>("(await app.plugins.plugins.geode.trash.list()).length"), {
      timeout: 60_000,
    })
    .toBe(1);
}

async function openTrashFromMenu(obsidian: PhoneInstance): Promise<void> {
  await obsidian.eval(`document.querySelector(${JSON.stringify(MOBILE)}).click(); return true;`);
  await expect(obsidian.win.locator(".menu .menu-item-title").first()).toBeVisible({
    timeout: 10_000,
  });
  await obsidian.eval(`
    (() => {
      const items = Array.from(document.querySelectorAll(".menu .menu-item"));
      const target = items.find(
        (i) => (i.querySelector(".menu-item-title")?.textContent || "").trim() === "Deleted files",
      );
      if (!target) throw new Error("menu item not found: Deleted files");
      target.click();
      return true;
    })()
  `);
  await expect(obsidian.win.locator(".menu")).toHaveCount(0, { timeout: 10_000 });
  await expect(obsidian.win.locator(".geode-trash-modal")).toBeVisible({ timeout: 15_000 });
}

test("issue493 (phone): force-stop mid trash restore → relaunch → file converges back, trash empty", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(600_000);

  const server = await useRemoteServer();
  const dataDir = requireDataDir(server);
  const device = await server.mintToken("interrupt-trash-phone");

  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
  });

  try {
    await unlockAndSync(obsidian);
    await trashOneNote(obsidian);

    /* Restore from the real trash modal UI. */
    await openTrashFromMenu(obsidian);
    await evalClick(obsidian, '[data-testid="geode-trash-restore"]');

    /* Deterministic mid-restore signal: the server committed the restore (trash row gone,
       new version in). The kill lands somewhere around the broadcast → apply; the file may or
       may not be on disk yet: either way it converges back after the relaunch. */
    await waitForServerState(
      () => serverTrashCount(dataDir, server.vaultId),
      (n) => n === 0,
      30_000,
      "trash row gone (restore committed)",
    );

    const obsidian2 = await obsidian.relaunch();
    try {
      await unlockIfLocked(obsidian2, PASSPHRASE);
      await waitForStatusBar(obsidian2.win, "Geode: synced", 120_000);

      /* No data loss: the file converges back with its exact content. */
      await expect
        .poll(
          () =>
            obsidian2.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(NOTE_PATH)})`),
          {
            timeout: 120_000,
          },
        )
        .toBe(true);
      const got = await obsidian2.eval<string>(
        `await app.vault.adapter.read(${JSON.stringify(NOTE_PATH)})`,
      );
      expect(got, "restored file content after relaunch").toBe(NOTE_CONTENT);

      /* Trash is empty: restore is idempotent, nothing left to retry. */
      expect(await obsidian2.eval<number>("(await app.plugins.plugins.geode.trash.list()).length"))
        .toBe(0);
      await obsidian2.screenshot(shotPath("493-trash-restore-phone-settled.png"));
    } finally {
      await obsidian2.close();
    }
  } finally {
    await obsidian.close().catch(() => {});
    await server.stop().catch(() => {});
  }
});

test("issue493 (phone): force-stop mid trash purge → relaunch → file stays gone, trash lists clean", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(600_000);

  const server = await useRemoteServer();
  const dataDir = requireDataDir(server);
  const device = await server.mintToken("interrupt-trash-purge-phone");

  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
  });

  try {
    await unlockAndSync(obsidian);
    await trashOneNote(obsidian);

    /* Purge from the real trash modal UI (with its confirm). */
    await openTrashFromMenu(obsidian);
    await evalClick(obsidian, '[data-testid="geode-trash-purge"]');
    await expect(obsidian.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await evalClick(obsidian, '[data-testid="geode-confirm-yes"]');
    // #677: inside the retention floor the purge asks for the server's admin token
    // (the loopback fixture's default, shared with the other purge specs).
    await enterAdminToken(obsidian);

    /* Deterministic mid-purge signal: the server row (and blobs) are gone. */
    await waitForServerState(
      () => serverTrashCount(dataDir, server.vaultId),
      (n) => n === 0,
      30_000,
      "trash row gone (purged)",
    );

    const obsidian2 = await obsidian.relaunch();
    try {
      await unlockIfLocked(obsidian2, PASSPHRASE);
      await waitForStatusBar(obsidian2.win, "Geode: synced", 120_000);

      /* The file stays deleted. */
      expect(
        await obsidian2.eval<boolean>(
          `!(await app.vault.adapter.exists(${JSON.stringify(NOTE_PATH)}))`,
        ),
      ).toBe(true);

      /* The trash lists clean: the real modal shows the empty state, no error state. */
      await openTrashFromMenu(obsidian2);
      await expect(obsidian2.win.locator('[data-testid="geode-trash-empty"]')).toBeVisible({
        timeout: 15_000,
      });
      expect(await obsidian2.eval<number>("(await app.plugins.plugins.geode.trash.list()).length"))
        .toBe(0);
      await obsidian2.screenshot(shotPath("493-trash-purge-phone-settled.png"));
    } finally {
      await obsidian2.close();
    }
  } finally {
    await obsidian.close().catch(() => {});
    await server.stop().catch(() => {});
  }
});
