import { expect, test } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import {
  serverVersionCount,
  serverVersionsDump,
  unlockIfLocked,
  waitForServerCount,
} from "../helpers/interrupt";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #493 flow c (desktop, #339): EXPECTED: with the server down, edits pile up as pending commits;
// the app is SIGKILLed while they are pending/retrying; after a relaunch with the server back,
// the pending edits still land EXACTLY ONCE (the reconciler rebuilds them: nothing silently
// lost), and the status bar was honest ("Geode: offline") while the server was unreachable.
const PASSPHRASE = "interrupt-commits-pass";
const N = 5;

const fileName = (i: number) => `docs/n-${i}.md`;
const v1 = (i: number) => `# note ${i}\nversion one\n`;
const v2 = (i: number) => `# note ${i}\nversion two: must survive the kill\n`;

// PRODUCT BUG (repro 3/3): the 5 acked v1 state rows are missing from local-files.json at kill
// time (only 4 .obsidian rows persisted) → after relaunch the reconciler re-commits the notes as
// NEW files (parent 0) → server conflict (head 1) → 5 spurious conflict files, status stuck at
// "5 conflicts", the v2 edits never land. Evidence: tmp/493-commits-state-at-kill.json,
// tmp/493-commits-desktop-evidence.txt, shot 493-commits-desktop-settled.png.
test("issue493: kill with pending commits against a down server → relaunch → edits land exactly once", async () => {
  test.slow();

  const server = await startServer();
  const [deviceA, deviceB] = await Promise.all([
    server.mintToken("interrupt-commits-A"),
    server.mintToken("interrupt-commits-B"),
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

    for (let i = 0; i < N; i++) {
      await upsertVaultFile(a, fileName(i), v1(i));
    }
    await waitForServerCount(server.dataDir, server.vaultId, N, 60_000);
    await waitForStatusBar(a.win, "Geode: synced", 60_000);
    /* The vault count also includes the .obsidian config files Obsidian commits at
       startup, so assert a delta from this post-v1 baseline, not an absolute N*2. */
    const baseline = serverVersionCount(server.dataDir, server.vaultId);

    /* Server goes down; the edits become pending commits that keep retrying. */
    await server.shutdown();
    for (let i = 0; i < N; i++) {
      await upsertVaultFile(a, fileName(i), v2(i));
    }
    const startedAt = Date.now();
    let sawPending = false;
    while (Date.now() - startedAt < 15_000) {
      const pending = await a.eval<number>("app.plugins.plugins.geode.getPendingCount()");
      if (pending >= N) {
        sawPending = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(sawPending, "edits must be pending while the server is down").toBe(true);

    /* Honest status while offline. */
    await waitForStatusBar(a.win, "Geode: offline", 30_000);
    await a.win.screenshot({ path: shotPath("493-commits-desktop-offline.png"), fullPage: true });

    /* Kill the app while ops are pending and the server is still down. */
    await a.hardKill();
    /* Evidence: the persisted state file at kill time (which rows survived). */
    const stateAtKill = await readFile(
      path.join(a.vaultDir, ".obsidian", "plugins", "geode", "local-files.json"),
      "utf8",
    ).catch((e) => `READ FAIL: ${String(e)}`);
    await writeFile("tmp/493-commits-state-at-kill.json", stateAtKill);
    const a2 = await launchObsidian({
      vaultDir: a.vaultDir,
      userDataDir: a.userDataDir,
      prepared: true,
      geodeSettings: a.settings,
      keepVaultDir: true,
      keepUserDataDir: true,
    });
    await server.restart();
    try {
      await unlockIfLocked(a2, PASSPHRASE);
      /* Convergence signal is the server DB ("synced" can flash before the startup
         reconciler re-queues the edits that were pending at kill time). */
      await waitForServerCount(server.dataDir, server.vaultId, baseline + N, 180_000);

      /* Evidence: plugin log + conflict files, captured before the status assertion. */
      const logText = await a2.eval<string>(
        `app.plugins.plugins.geode.getRecentLog().map((e) => e.level + ": " + e.msg + " " + JSON.stringify(e.fields)).join("\\n")`,
      );
      const conflictFiles = await a2.eval<string[]>(
        `app.vault.getMarkdownFiles().map((f) => f.path).filter((p) => p.includes("(conflict "))`,
      );
      const stateRows = await a2.eval<string>(
        `JSON.stringify([...app.plugins.plugins.geode.state.getAllLocalFiles().entries()].filter(([p]) => p.startsWith("docs/")).map(([p, r]) => [p, r.last_seen_version, r.deleted]))`,
      );
      const dbRows = serverVersionsDump(server.dataDir, server.vaultId);
      await mkdir("tmp", { recursive: true });
      await writeFile(
        "tmp/493-commits-desktop-evidence.txt",
        `conflictFiles: ${
          JSON.stringify(conflictFiles)
        }\n\nstateRows (path, last_seen_version, deleted): ${stateRows}\n\nserver file_versions (version, parent, seq, created_at):\n${dbRows}\n\n${logText}`,
      );
      await a2.win.screenshot({
        path: shotPath("493-commits-desktop-settled.png"),
        fullPage: true,
      });

      await waitForStatusBar(a2.win, "Geode: synced", 60_000);

      /* Every pending edit landed exactly once: no loss, no duplicate storm. */
      expect(serverVersionCount(server.dataDir, server.vaultId)).toBe(baseline + N);

      /* A fresh device sees the new content. */
      const b = await launchObsidian({
        geodeSettings: settings(deviceB),
        unlockPassphrase: PASSPHRASE,
      });
      try {
        await waitForUnlocked(b);
        await waitForStatusBar(b.win, "Geode: synced", 120_000);
        for (let i = 0; i < N; i++) {
          const got = await readFile(path.join(b.vaultDir, fileName(i)), "utf8");
          expect(got, `edited file ${i} on the fresh device`).toBe(v2(i));
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
