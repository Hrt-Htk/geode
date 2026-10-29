import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { requireDataDir, useRemoteServer } from "../fixtures/phone-server";
import {
  chunkHashesFor,
  serverChunkHashSets,
  serverVersionCount,
  unlockIfLocked,
  waitForServerCount,
} from "../helpers/interrupt";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #493 flow a (phone): EXPECTED: the phone is force-stopped mid-upload of a large batch; after a
// relaunch, every file ends up on the server with correct content (the server's stored chunk
// hashes match the real chunker's output for the expected bytes), with no loss and no
// duplicate-version storm, and the status bar settles back to "Geode: synced".
const PASSPHRASE = "interrupt-upload-phone-pass";
const N = 60;

const fileName = (i: number) => `pbatch/p-${String(i).padStart(2, "0")}.md`;
const makeContent = (i: number) =>
  `# phone batch file ${i}\n` + `line ${i} of the phone interrupt batch\n`.repeat(800);

test("issue493 (phone): force-stop mid large-batch upload → relaunch → no loss, no duplicate storm, correct bytes", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(600_000);

  const server = await useRemoteServer();
  const dataDir = requireDataDir(server);
  const device = await server.mintToken("interrupt-upload-phone");

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
    await expect.poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 30_000 }).toBe(
      "Geode: locked",
    );
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 120_000);

    /* Create the batch; the reconciler chunks/encrypts/uploads it in the background. */
    await obsidian.eval(`
      (async () => {
        if (!(await app.vault.adapter.exists("pbatch"))) await app.vault.createFolder("pbatch");
        for (let i = 0; i < ${N}; i++) {
          const name = \`pbatch/p-\${String(i).padStart(2, "0")}.md\`;
          const content = \`# phone batch file \${i}\\n\` + \`line \${i} of the phone interrupt batch\\n\`.repeat(800);
          await app.vault.create(name, content);
        }
        return true;
      })()
    `);

    /* Deterministic mid-upload signal: the server DB shows half the batch committed. */
    const atKill = await waitForServerCount(dataDir, server.vaultId, N / 2, 300_000);
    expect(atKill, "kill must land MID-upload, not after it").toBeLessThan(N);

    /* Force-stop (no graceful close), relaunch, re-attach. */
    const obsidian2 = await obsidian.relaunch();
    try {
      await unlockIfLocked(obsidian2, PASSPHRASE);
      /* Convergence signal is the server DB ("synced" can flash before the startup
         reconciler queues the uncommitted files). */
      await waitForServerCount(dataDir, server.vaultId, N, 300_000);
      await waitForStatusBar(obsidian2.win, "Geode: synced", 120_000);
      await obsidian2.screenshot(shotPath("493-upload-phone-settled.png"));

      /* No loss, no duplicate-version storm. A hard kill in the 2 s state-persist debounce
         window re-commits the acked-but-unpersisted files as identical duplicate versions,
         bounded (a few), never a storm. */
      const count = serverVersionCount(dataDir, server.vaultId);
      expect(count, "every file must be on the server").toBeGreaterThanOrEqual(N);
      expect(count, "no duplicate-version storm").toBeLessThanOrEqual(N * 1.2);

      /* Server-side content proof: stored chunk hashes == real chunker output for expected bytes. */
      const expected = await chunkHashesFor(
        Array.from({ length: N }, (_, i) => ({ path: fileName(i), content: makeContent(i) })),
      );
      const sets = serverChunkHashSets(dataDir, server.vaultId);
      for (let i = 0; i < N; i++) {
        const want = expected[fileName(i)];
        expect(
          sets.some((s) => JSON.stringify(s) === JSON.stringify(want)),
          `server must hold the exact bytes of file ${i}`,
        ).toBe(true);
      }
    } finally {
      await obsidian2.close();
    }
  } finally {
    await server.stop().catch(() => {});
  }
});
