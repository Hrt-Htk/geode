import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { upsertVaultFile, waitForUnlocked } from "../helpers/geode";

const PASSPHRASE = "pendcorr-passphrase";
const DEVICE = "pendcorr";
const FILE = "notes/pendcorr.md";

// #434: phone mirror of pending-ops: pending ops surface
// via the plugin's getPendingOps(), with no error controls.

test("getPendingOps shows the queued edit with no error controls", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");

  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken(DEVICE);

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
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`,
    );
    /* Wait for vault unlocked and synced */
    await waitForUnlocked(obsidian);

    await expect
      .poll(
        async () =>
          await obsidian.eval<boolean>(`
            const el = document.querySelector('[data-testid="geode-statusbar"]');
            return el ? el.classList.contains("geode-statusbar-ok") : false;
          `),
        { timeout: 60_000 },
      )
      .toBe(true);

    /* Make a real local edit (queues an op in VaultEventHandler). */
    await upsertVaultFile(obsidian, FILE, "# pendcorr\ninitial\n");

    /* CORRELATION ASSERTION: within the debounce window, getPendingOps() must
       include the edited file. */
    await expect
      .poll(
        async () =>
          await obsidian.eval<boolean>(`
            const ops = app.plugins.plugins.geode.getPendingOps();
            return ops.some((op) => op.path.includes("pendcorr.md"));
          `),
        { timeout: 4000 },
      )
      .toBe(true);

    /* NO-ERROR-CONTROLS ASSERTION: pending ops are plain { path, kind, stage }
       rows: no retry/skip/error controls on them. */
    const ops = await obsidian.eval<Array<Record<string, unknown>>>(
      `app.plugins.plugins.geode.getPendingOps()`,
    );
    for (const op of ops) {
      expect(Object.keys(op).sort(), "pending op shape").toEqual(["kind", "path", "stage"]);
    }
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
