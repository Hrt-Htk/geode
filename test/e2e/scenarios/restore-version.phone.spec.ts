import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { commitPath, upsertVaultFile } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #465 (phone): Restore this version on the real device: the confirm, the
// Notice, and the history window reloaded onto the restored head.
const PASSPHRASE = "restore-phone-pass";
const NOTE = "restore-phone.md";

const MODAL = ".geode-history-modal";
const CONFIRM = ".geode-confirm-modal";

test("restore (phone): confirm, restore, and the restored head appears", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("restore");
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
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    for (const body of ["first save", "second save"]) {
      await upsertVaultFile(obsidian, NOTE, `# Phone restore\n\n${body}\n`);
      await commitPath(obsidian, NOTE);
    }
    await expect
      .poll(
        async () =>
          await obsidian.eval<number>(
            `app.plugins.plugins.geode.state?.getLocalFile(${
              JSON.stringify(NOTE)
            })?.last_seen_version ?? 0`,
          ),
        { timeout: 60_000 },
      )
      .toBe(2);

    /* ---- Open the window on the active note, then pick the first save ---- */
    await obsidian.eval(`
      const file = app.vault.getFileByPath(${JSON.stringify(NOTE)});
      if (!file) throw new Error("expected " + ${JSON.stringify(NOTE)} + " in the vault");
      await app.workspace.getLeaf(true).openFile(file);
      app.commands.executeCommandById("geode:geode-show-file-history");
      return true;
    `);
    await expect(obsidian.win.locator(MODAL)).toBeVisible({ timeout: 15_000 });
    /* Phone: the list only. Expand the period, then tap its first save (tapping the
       period head would open the newest one). */
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-chevron"]`);
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-save"][data-version="1"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("first save");
    await obsidian.screenshot(shotPath("465-phone-01-version.png"));

    /* ---- The confirm ---- */
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-restore"]`);
    await expect(obsidian.win.locator(CONFIRM)).toBeVisible({ timeout: 10_000 });
    await expect(
      obsidian.win.locator(".modal", { has: obsidian.win.locator(CONFIRM) }),
    ).toContainText("Restore this version?");
    await obsidian.screenshot(shotPath("465-phone-02-confirm.png"));
    await evalClick(obsidian, '[data-testid="geode-confirm-yes"]');

    /* ---- The Notice, and the content back to the restored version ---- */
    await expect
      .poll(
        async () =>
          await obsidian.eval<string>(
            `document.querySelector(".notice")?.textContent ?? ""`,
          ),
        { timeout: 20_000 },
      )
      .toContain("Restored and saved as a new version");
    await obsidian.screenshot(shotPath("465-phone-03-notice.png"));
    await expect
      .poll(
        async () =>
          await obsidian.eval<string>(`await app.vault.adapter.read(${JSON.stringify(NOTE)})`),
        { timeout: 20_000 },
      )
      .toBe("# Phone restore\n\nfirst save\n");

    /* ---- The reloaded window is back on the list, whose head is the restore ---- */
    await expect
      .poll(
        async () =>
          await obsidian.eval<number>(
            `document.querySelectorAll('${MODAL} [data-testid="geode-history-period"]').length`,
          ),
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await obsidian.screenshot(shotPath("465-phone-04-after-restore.png"));
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-period"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("first save", { timeout: 20_000 });
    await dismissModals(obsidian);
    await expect(obsidian.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
