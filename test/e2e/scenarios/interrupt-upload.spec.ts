import { expect, test } from "@playwright/test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import {
  relaunchDesktop,
  serverVersionCount,
  unlockIfLocked,
  waitForServerCount,
} from "../helpers/interrupt";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #493 flow a (desktop): EXPECTED: the app is SIGKILLed mid-upload of a large batch; after a
// relaunch on the same vault, every file ends up on the server with correct content (a fresh
// second device receives identical bytes), with no loss and no duplicate-version storm (a hard
// kill in the 2 s state-persist window yields a few identical duplicate versions, at most), and
// the status bar settles back to "Geode: synced".
const PASSPHRASE = "interrupt-upload-pass";
const N = 100;

const fileName = (i: number) => `batch/f-${String(i).padStart(3, "0")}.md`;
const makeContent = (i: number) =>
  `# batch file ${i}\n` + `line ${i} of the interrupt-upload batch\n`.repeat(1200);

test("issue493: kill mid large-batch upload → relaunch → no loss, no duplicate storm, correct bytes", async () => {
  test.slow();

  const server = await startServer();
  const [deviceA, deviceB] = await Promise.all([
    server.mintToken("interrupt-upload-A"),
    server.mintToken("interrupt-upload-B"),
  ]);
  const settings = (device: { deviceId: string; token: string }) => ({
    serverUrl: server.url,
    vaultId: server.vaultId,
    deviceId: device.deviceId,
    deviceToken: device.token,
    salt: server.salt,
  });

  const a = await launchObsidian({
    geodeSettings: settings(deviceA),
    unlockPassphrase: PASSPHRASE,
    keepVaultDir: true,
    keepUserDataDir: true,
  });

  try {
    await waitForUnlocked(a);
    await waitForStatusBar(a.win, "Geode: synced", 60_000);

    /* Create the batch; the reconciler chunks/encrypts/uploads it in the background. */
    await a.eval(`
      (async () => {
        if (!(await app.vault.adapter.exists("batch"))) await app.vault.createFolder("batch");
        for (let i = 0; i < ${N}; i++) {
          const name = \`batch/f-\${String(i).padStart(3, "0")}.md\`;
          const content = \`# batch file \${i}\\n\` + \`line \${i} of the interrupt-upload batch\\n\`.repeat(1200);
          await app.vault.create(name, content);
        }
        return true;
      })()
    `);

    /* Deterministic mid-upload signal: the server DB shows half the batch committed. */
    const atKill = await waitForServerCount(server.dataDir, server.vaultId, N / 2, 180_000);
    expect(atKill, "kill must land MID-upload, not after it").toBeLessThan(N);

    /* SIGKILL (no graceful close), relaunch on the same vault + user-data dirs. */
    const a2 = await relaunchDesktop(a);
    try {
      await unlockIfLocked(a2, PASSPHRASE);
      /* Convergence signal is the server DB ("synced" can flash before the startup
         reconciler queues the uncommitted files). */
      await waitForServerCount(server.dataDir, server.vaultId, N, 180_000);
      await waitForStatusBar(a2.win, "Geode: synced", 60_000);
      await a2.win.screenshot({ path: shotPath("493-upload-desktop-settled.png"), fullPage: true });

      /* No loss, no duplicate-version storm. A hard kill in the 2 s state-persist debounce
         window re-commits the acked-but-unpersisted files as identical duplicate versions,
         bounded (a few), never a storm. */
      const count = serverVersionCount(server.dataDir, server.vaultId);
      expect(count, "every file must be on the server").toBeGreaterThanOrEqual(N);
      expect(count, "no duplicate-version storm").toBeLessThanOrEqual(N * 1.2);

      /* A fresh device cold-syncs from the server and must receive identical bytes. */
      const b = await launchObsidian({
        geodeSettings: settings(deviceB),
        unlockPassphrase: PASSPHRASE,
      });
      try {
        await waitForUnlocked(b);
        await waitForStatusBar(b.win, "Geode: synced", 180_000);
        for (let i = 0; i < N; i++) {
          const got = await readFile(path.join(b.vaultDir, fileName(i)), "utf8");
          expect(got, `file ${i} bytes on the fresh device`).toBe(makeContent(i));
        }
      } finally {
        await b.close();
      }
    } finally {
      await a2.close();
    }
  } finally {
    /* hardKill made close() a no-op for the dirs: remove them explicitly. */
    await a.close();
    await rm(a.vaultDir, { recursive: true, force: true });
    await rm(a.userDataDir, { recursive: true, force: true });
    await server.stop().catch(() => {});
  }
});
