import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { connectPhone } from "../fixtures/phone-obsidian";
import { requireDataDir, useRemoteServer } from "../fixtures/phone-server";
import { upsertVaultFile } from "../helpers/geode";
import {
  chunkHashesFor,
  serverChunkHashSets,
  serverVersionCount,
  unlockIfLocked,
  waitForServerCount,
} from "../helpers/interrupt";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #493 flow c (phone, #339): EXPECTED: with the server down, edits pile up as pending commits;
// the phone is force-stopped while they are pending/retrying; after a relaunch with the server
// back, the pending edits still land EXACTLY ONCE with correct content (the reconciler rebuilds
// them: nothing silently lost), and the status bar was honest ("Geode: offline") meanwhile.
const PASSPHRASE = "interrupt-commits-phone-pass";
const N = 5;

const fileName = (i: number) => `pn/${i}.md`;
const v1 = (i: number) => `# phone note ${i}\nversion one\n`;
const v2 = (i: number) => `# phone note ${i}\nversion two: must survive the kill\n`;

// PRODUCT BUG (same as desktop #493-commits): acked commit state rows are lost from
// local-files.json across the force-stop → after relaunch the device re-commits an already-
// synced file as NEW → server conflict → spurious conflict file, status stuck at "N conflicts".
// Evidence: tmp/493-commits-phone-evidence.txt, shot 493-commits-phone-settled.png.
test("issue493 (phone): force-stop with pending commits against a down server → relaunch → edits land exactly once", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(600_000);

  const server = await useRemoteServer();
  const dataDir = requireDataDir(server);
  const device = await server.mintToken("interrupt-commits-phone");

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

    for (let i = 0; i < N; i++) {
      await upsertVaultFile(obsidian, fileName(i), v1(i));
    }
    await waitForServerCount(dataDir, server.vaultId, N, 120_000);
    await waitForStatusBar(obsidian.win, "Geode: synced", 120_000);
    /* The vault count also includes the .obsidian config files Obsidian commits at
       startup, so assert a delta from this post-v1 baseline, not an absolute N*2. */
    const baseline = serverVersionCount(dataDir, server.vaultId);

    /* Server goes down; the edits become pending commits that keep retrying. */
    await server.shutdown();
    for (let i = 0; i < N; i++) {
      await upsertVaultFile(obsidian, fileName(i), v2(i));
    }
    const startedAt = Date.now();
    let sawPending = false;
    while (Date.now() - startedAt < 15_000) {
      const pending = await obsidian.eval<number>("app.plugins.plugins.geode.getPendingCount()");
      if (pending >= N) {
        sawPending = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sawPending, "edits must be pending while the server is down").toBe(true);

    /* Honest status while offline. */
    await waitForStatusBar(obsidian.win, "Geode: offline", 30_000);
    await obsidian.screenshot(shotPath("493-commits-phone-offline.png"));

    /* Force-stop while ops are pending and the server is still down. */
    await obsidian.forceStop();
    await server.restart();
    const obsidian2 = await obsidian.relaunch();
    try {
      await unlockIfLocked(obsidian2, PASSPHRASE);
      /* Convergence signal is the server DB ("synced" can flash before the startup
         reconciler re-queues the edits that were pending at kill time). */
      await waitForServerCount(dataDir, server.vaultId, baseline + N, 300_000);

      /* Evidence: conflict files + plugin log, captured before the status assertion. */
      const logText = await obsidian2.eval<string>(
        `app.plugins.plugins.geode.getRecentLog().map((e) => e.level + ": " + e.msg + " " + JSON.stringify(e.fields)).join("\\n")`,
      );
      const conflictFiles = await obsidian2.eval<string[]>(
        `app.vault.getMarkdownFiles().map((f) => f.path).filter((p) => p.includes("(conflict "))`,
      );
      await mkdir("tmp", { recursive: true });
      await writeFile(
        "tmp/493-commits-phone-evidence.txt",
        `conflictFiles: ${JSON.stringify(conflictFiles)}\n\n${logText}`,
      );
      await obsidian2.screenshot(shotPath("493-commits-phone-settled.png"));

      await waitForStatusBar(obsidian2.win, "Geode: synced", 120_000);

      /* Every pending edit landed exactly once: no loss, no duplicate storm. */
      expect(serverVersionCount(dataDir, server.vaultId)).toBe(baseline + N);

      /* Server-side content proof: stored chunk hashes == real chunker output for the NEW bytes. */
      const expected = await chunkHashesFor(
        Array.from({ length: N }, (_, i) => ({ path: fileName(i), content: v2(i) })),
      );
      const sets = serverChunkHashSets(dataDir, server.vaultId);
      for (let i = 0; i < N; i++) {
        const want = expected[fileName(i)];
        expect(
          sets.some((s) => JSON.stringify(s) === JSON.stringify(want)),
          `server must hold the edited bytes of file ${i}`,
        ).toBe(true);
      }

      /* The phone's own disk agrees. */
      for (let i = 0; i < N; i++) {
        const got = await obsidian2.eval<string>(
          `await app.vault.adapter.read(${JSON.stringify(fileName(i))})`,
        );
        expect(got, `phone disk file ${i} after relaunch`).toBe(v2(i));
      }
    } finally {
      await obsidian2.close();
    }
  } finally {
    await server.stop().catch(() => {});
  }
});
