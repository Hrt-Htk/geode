import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate5-conflict-explorer-passphrase";
const CONFLICT_PATH = "merge.conflict-2026-07-07T10-00-00.md";
const DECOY_PATH = "other.md";
const CONFLICT_CONTENT = "line 1\nB edited line 2\nline 3";

test("gate5 conflict files exist, are resolvable, and can be opened on phone", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("gate5-conflict-explorer");

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
    /* Wait for locked state, then unlock via eval. */
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    await obsidian.eval(`
      await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)});
      return true;
    `);

    /* Wait for synced baseline so the sync loop isn't racing us. */
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* Seed both files: top-level paths need no folder pre-creation. */
    await obsidian.eval(`
      await app.vault.create(${JSON.stringify(DECOY_PATH)}, "decoy");
      return true;
    `);
    await obsidian.eval(`
      await app.vault.create(${JSON.stringify(CONFLICT_PATH)}, ${JSON.stringify(CONFLICT_CONTENT)});
      return true;
    `);

    /* Assert the conflict file exists on disk. */
    expect(
      await obsidian.eval<boolean>(
        `await app.vault.adapter.exists(${JSON.stringify(CONFLICT_PATH)})`,
      ),
    ).toBe(true);

    /* Assert the conflict file is resolvable via the vault API. */
    expect(
      await obsidian.eval<boolean>(
        `app.vault.getAbstractFileByPath(${JSON.stringify(CONFLICT_PATH)}) != null`,
      ),
    ).toBe(true);

    /* Open the decoy first so the active file is NOT the conflict file. */
    await obsidian.eval(`
      const f = app.vault.getAbstractFileByPath(${JSON.stringify(DECOY_PATH)});
      await app.workspace.getLeaf(false).openFile(f);
      return true;
    `);
    await expect.poll(
      async () => await obsidian.eval<string>("app.workspace.getActiveFile()?.path ?? ''"),
      { timeout: 15_000 },
    ).toBe(DECOY_PATH);

    /* Open the conflict file in a new leaf. */
    await obsidian.eval(`
      const f = app.vault.getAbstractFileByPath(${JSON.stringify(CONFLICT_PATH)});
      await app.workspace.getLeaf(true).openFile(f);
      return true;
    `);
    await expect.poll(
      async () => await obsidian.eval<string>("app.workspace.getActiveFile()?.path ?? ''"),
      { timeout: 30_000 },
    ).toBe(CONFLICT_PATH);

    /* Assert the opened file's content matches what we seeded. */
    expect(
      await obsidian.eval<string>(`await app.vault.adapter.read(${JSON.stringify(CONFLICT_PATH)})`),
    ).toBe(CONFLICT_CONTENT);
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
