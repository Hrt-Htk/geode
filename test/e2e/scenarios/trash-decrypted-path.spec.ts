import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

const PASSPHRASE = "trash-panel-pass";
const FILE_PATH = "notes/quarterly-report.md";
const CONTENT = "# Quarterly report\nDeleted, then shown by name in the trash modal.\n";

// #98: the trash modal lists deleted files by their DECRYPTED path (path_ciphertext
// round-trip), not an opaque hash. This spec creates → commits → deletes a file, opens
// the modal from Settings, asserts the entry resolves to its real name, and screenshots it.
test("trash modal shows decrypted file name", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("trash-panel");

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

    // Create + commit, then delete + commit the deletion → one trash entry.
    await upsertVaultFile(o, FILE_PATH, CONTENT);
    await commitPath(o, FILE_PATH, "commit");
    await o.eval(`
      const p = ${JSON.stringify(FILE_PATH)};
      const file = app.vault.getAbstractFileByPath(p);
      if (!file) throw new Error("expected file to delete: " + p);
      await app.vault.delete(file);
      return !(await app.vault.adapter.exists(p));
    `);
    await commitPath(o, FILE_PATH, "delete");

    // The decrypted path must round-trip through path_ciphertext.
    await expect
      .poll(
        async () => {
          const trash = await o.eval<Array<{ path?: string }>>(
            "await app.plugins.plugins.geode.trash.list()",
          );
          return trash.length === 1 ? (trash[0].path ?? null) : null;
        },
        { timeout: 30_000 },
      )
      .toBe(FILE_PATH);

    // Open the modal from Settings → Trash → Deleted files [View].
    await o.eval(`
      if (app.setting && typeof app.setting.close === "function") app.setting.close();
      app.setting.open();
      app.setting.openTabById("geode");
      return true;
    `);
    await o.win.locator('[data-testid="geode-settings-open-trash"]').click();
    const modal = o.win.locator(".geode-trash-modal");
    await expect.poll(async () => await modal.isVisible().catch(() => false), { timeout: 30_000 })
      .toBe(true);

    // The modal renders the decrypted name as the row label.
    await expect.poll(async () => (await modal.textContent().catch(() => "")) ?? "", {
      timeout: 30_000,
    }).toContain(FILE_PATH);

    // Clear transient notices, then screenshot the modal.
    await o.eval(`document.querySelectorAll('.notice').forEach(n=>n.remove()); return true;`);
    await modal.screenshot({ path: shotPath("trash-panel.png") }).catch(async () => {
      await o.win.screenshot({ path: shotPath("trash-panel.png") });
    });

    // Log-ring oracle: no error lines after the flow.
    expect(o.consoleErrors()).toEqual([]);
  } finally {
    await o.close();
    await server.stop?.();
  }
});
