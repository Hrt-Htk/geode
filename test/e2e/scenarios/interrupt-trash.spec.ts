import { expect, test } from "@playwright/test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { launchObsidian } from "../fixtures/obsidian";
import { type E2EServer, startServer } from "../fixtures/server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import {
  relaunchDesktop,
  serverTrashCount,
  unlockIfLocked,
  waitForServerState,
} from "../helpers/interrupt";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { enterAdminToken } from "../helpers/admin-token";

// #493 flow c (desktop): EXPECTED: the app is SIGKILLed mid trash restore (server restore
// committed, file not yet applied locally) → a relaunch converges the file back with its
// exact content and the trash is empty (restore is idempotent: nothing left to retry).
// Kill mid trash purge (server row gone) → a relaunch keeps the file deleted and the trash
// lists clean (empty, no error state): purge never half-deletes in a way that breaks listing.
const PASSPHRASE = "interrupt-trash-pass";
const NOTE_PATH = "trash/interrupt-me.md";
const NOTE_CONTENT = "# Interrupt me\nThis content must survive the kill.\n";

async function launchConfigured(server: E2EServer) {
  const device = await server.mintToken("interrupt-trash");
  return await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
    keepVaultDir: true,
    keepUserDataDir: true,
  });
}

async function trashOneNote(o: Awaited<ReturnType<typeof launchConfigured>>): Promise<void> {
  /* commitPath waits for this specific file to land (the .obsidian config files commit
     first, so a bare version-count wait would return before it). */
  await upsertVaultFile(o, NOTE_PATH, NOTE_CONTENT);
  await commitPath(o, NOTE_PATH, "commit");
  await o.eval(`
    const file = app.vault.getAbstractFileByPath(${JSON.stringify(NOTE_PATH)});
    if (!file) throw new Error("expected file to delete");
    await app.vault.delete(file);
    return true;
  `);
  await commitPath(o, NOTE_PATH, "delete");
  await expect
    .poll(() => o.eval<number>("(await app.plugins.plugins.geode.trash.list()).length"), {
      timeout: 30_000,
    })
    .toBe(1);
}

async function openTrashModal(o: Awaited<ReturnType<typeof launchConfigured>>): Promise<void> {
  await o.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    app.setting.open();
    app.setting.openTabById("geode");
    return true;
  `);
  await o.win.locator('[data-testid="geode-settings-open-trash"]').click();
  await expect(o.win.locator(".geode-trash-modal")).toBeVisible({ timeout: 15_000 });
}

test("issue493: kill mid trash restore → relaunch → file converges back, trash empty", async () => {
  test.slow();

  const server = await startServer();
  const a = await launchConfigured(server);

  try {
    await waitForUnlocked(a);
    await waitForStatusBar(a.win, "Geode: synced", 60_000);
    await trashOneNote(a);

    /* Restore from the real trash modal UI. */
    await openTrashModal(a);
    await a.win.locator('[data-testid="geode-trash-restore"]').click();

    /* Deterministic mid-restore signal: the server committed the restore (trash row gone,
       new version in). The kill lands somewhere around the broadcast → apply; the file may or
       may not be on disk yet: either way it converges back after the relaunch. */
    await waitForServerState(
      () => serverTrashCount(server.dataDir, server.vaultId),
      (n) => n === 0,
      30_000,
      "trash row gone (restore committed)",
    );

    const a2 = await relaunchDesktop(a);
    try {
      await unlockIfLocked(a2, PASSPHRASE);
      await waitForStatusBar(a2.win, "Geode: synced", 60_000);

      /* No data loss: the file converges back with its exact content. */
      await expect
        .poll(
          () => a2.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(NOTE_PATH)})`),
          {
            timeout: 60_000,
          },
        )
        .toBe(true);
      const got = await readFile(path.join(a2.vaultDir, NOTE_PATH), "utf8");
      expect(got, "restored file content after relaunch").toBe(NOTE_CONTENT);

      /* Trash is empty: restore is idempotent, nothing left to retry. */
      expect(await a2.eval<number>("(await app.plugins.plugins.geode.trash.list()).length")).toBe(
        0,
      );
      await a2.win.screenshot({ path: shotPath("493-trash-restore-settled.png"), fullPage: true });
    } finally {
      await a2.close();
    }
  } finally {
    await a.close();
    await rm(a.vaultDir, { recursive: true, force: true });
    await rm(a.userDataDir, { recursive: true, force: true });
    await server.stop().catch(() => {});
  }
});

test("issue493: kill mid trash purge → relaunch → file stays gone, trash lists clean", async () => {
  test.slow();

  const server = await startServer();
  const a = await launchConfigured(server);

  try {
    await waitForUnlocked(a);
    await waitForStatusBar(a.win, "Geode: synced", 60_000);
    await trashOneNote(a);

    /* Purge from the real trash modal UI (with its confirm). */
    await openTrashModal(a);
    await a.win.locator('[data-testid="geode-trash-purge"]').click();
    await expect(a.win.locator(".geode-confirm-modal")).toBeVisible({ timeout: 10_000 });
    await a.win.locator('[data-testid="geode-confirm-yes"]').click();
    // #677: the row is inside the server's retention floor: the purge asks for the admin
    // token before the device token is allowed to erase it.
    await enterAdminToken(a);

    /* Deterministic mid-purge signal: the server row (and blobs) are gone. */
    await waitForServerState(
      () => serverTrashCount(server.dataDir, server.vaultId),
      (n) => n === 0,
      30_000,
      "trash row gone (purged)",
    );

    const a2 = await relaunchDesktop(a);
    try {
      await unlockIfLocked(a2, PASSPHRASE);
      await waitForStatusBar(a2.win, "Geode: synced", 60_000);

      /* The file stays deleted. */
      expect(
        await a2.eval<boolean>(`!(await app.vault.adapter.exists(${JSON.stringify(NOTE_PATH)}))`),
      ).toBe(true);

      /* The trash lists clean: the real modal shows the empty state, no error state. */
      await openTrashModal(a2);
      await expect(a2.win.locator('[data-testid="geode-trash-empty"]')).toBeVisible({
        timeout: 15_000,
      });
      await expect(a2.win.locator('[data-testid="geode-trash-empty"]')).toHaveText(
        "Trash is empty.",
      );
      expect(await a2.eval<number>("(await app.plugins.plugins.geode.trash.list()).length")).toBe(
        0,
      );
      await a2.win.screenshot({ path: shotPath("493-trash-purge-settled.png"), fullPage: true });
    } finally {
      await a2.close();
    }
  } finally {
    await a.close();
    await rm(a.vaultDir, { recursive: true, force: true });
    await rm(a.userDataDir, { recursive: true, force: true });
    await server.stop().catch(() => {});
  }
});
