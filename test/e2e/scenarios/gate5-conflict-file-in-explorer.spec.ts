import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { revealFileInExplorer, waitForUnlocked } from "../helpers/geode";
import { waitForFileInExplorer, waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate5-conflict-explorer-passphrase";
const CONFLICT_PATH = "merge.conflict-2026-07-07T10-00-00.md";
const DECOY_PATH = "other.md";
const CONFLICT_CONTENT = "line 1\nB edited line 2\nline 3";

test("gate5 conflict files appear in the real file explorer and can be opened", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("gate5-conflict-explorer");

  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Seed both files: top-level paths need no folder pre-creation */
    await obsidian.eval(
      `await app.vault.create(${JSON.stringify(DECOY_PATH)}, "decoy"); return true;`,
    );
    await obsidian.eval(
      `await app.vault.create(${JSON.stringify(CONFLICT_PATH)}, ${
        JSON.stringify(CONFLICT_CONTENT)
      }); return true;`,
    );

    /* Reveal the conflict file so the explorer pane is open and its entry is rendered */
    await revealFileInExplorer(obsidian, CONFLICT_PATH);
    await waitForFileInExplorer(obsidian.win, CONFLICT_PATH, 60_000);

    /* Switch active file away from the conflict file (open the decoy) so the
     * subsequent click is a meaningful "opens on click" assertion */
    await obsidian.eval(`
      const f = app.vault.getFileByPath(${JSON.stringify(DECOY_PATH)});
      await app.workspace.getLeaf(false).openFile(f);
      return true;
    `);
    await expect.poll(
      async () => await obsidian.eval<string>("app.workspace.getActiveFile()?.path ?? ''"),
      { timeout: 15_000 },
    ).toBe(DECOY_PATH);

    /* Dismiss any open modals (Obsidian auto-opens a Settings dialog whose mod-dim
     * backdrop overlays the explorer and intercepts the click). */
    await obsidian.eval("app.setting?.close?.(); return true;");
    for (let i = 0; i < 6; i++) {
      if ((await obsidian.win.locator(".modal-container").count()) === 0) break;
      await obsidian.win.keyboard.press("Escape");
      await obsidian.win.waitForTimeout(300);
    }

    /* Assert the explorer entry is visible and click it */
    const entry = obsidian.win.locator(
      `.nav-file-title[data-path=${JSON.stringify(CONFLICT_PATH)}]`,
    );
    await expect(entry).toBeVisible({ timeout: 15_000 });
    await entry.click();
    await expect.poll(
      async () => await obsidian.eval<string>("app.workspace.getActiveFile()?.path ?? ''"),
      { timeout: 30_000 },
    ).toBe(CONFLICT_PATH);

    /* Assert the opened file's content matches what we seeded */
    expect(await readVaultDisk(obsidian.vaultDir, CONFLICT_PATH)).toBe(CONFLICT_CONTENT);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});

async function readVaultDisk(vaultDir: string, vaultPath: string): Promise<string> {
  return await readFile(path.join(vaultDir, ...vaultPath.split("/")), "utf8");
}
