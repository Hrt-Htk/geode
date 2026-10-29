import { expect, test } from "@playwright/test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { launchPair } from "../fixtures/pair";
import { waitForUnlocked } from "../helpers/geode";
import {
  relaunchDesktop,
  serverMaxSeq,
  serverVersionCount,
  unlockIfLocked,
  waitForServerCount,
} from "../helpers/interrupt";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #493 flow b (desktop): EXPECTED: a device catching up on a server backlog is SIGKILLed mid
// catch-up; after a relaunch on the same vault it converges to the FULL backlog with correct
// content, its cursor reaches the server head (no skipped versions), and it commits nothing.
const PASSPHRASE = "interrupt-catchup-pass";
const N = 150;

const fileName = (i: number) => `backlog/c-${String(i).padStart(3, "0")}.md`;
const makeContent = (i: number) =>
  `# backlog file ${i}\n` + `line ${i} of the interrupt-catchup backlog\n`.repeat(1200);

test("issue493: kill mid cold catch-up → relaunch → full backlog, correct bytes, cursor at head", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE, keepVaultB: true });

  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    /* B stays locked while A builds the backlog, so B's catch-up starts on a known trigger. */
    await pair.B.eval("app.plugins.plugins.geode.lockVault()");

    await pair.A.eval(`
      (async () => {
        if (!(await app.vault.adapter.exists("backlog"))) await app.vault.createFolder("backlog");
        for (let i = 0; i < ${N}; i++) {
          const name = \`backlog/c-\${String(i).padStart(3, "0")}.md\`;
          const content = \`# backlog file \${i}\\n\` + \`line \${i} of the interrupt-catchup backlog\\n\`.repeat(1200);
          await app.vault.create(name, content);
        }
        return true;
      })()
    `);
    await waitForServerCount(pair.server.dataDir, pair.server.vaultId, N, 180_000);

    /* Trigger B's catch-up, then kill it once half the backlog is applied. */
    await pair.B.eval(`app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`);
    const startedAt = Date.now();
    let applied = 0;
    while (Date.now() - startedAt < 120_000) {
      applied = await pair.B.eval<number>(
        "app.plugins.plugins.geode.state.getAllLocalFiles().size",
      );
      if (applied >= N / 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(applied, "kill must land MID catch-up, not after it").toBeGreaterThanOrEqual(N / 2);
    expect(applied, "kill must land MID catch-up, not after it").toBeLessThan(N);

    const b2 = await relaunchDesktop(pair.B);
    try {
      await unlockIfLocked(b2, PASSPHRASE);
      /* Convergence signal: the full backlog applied to disk ("synced" can flash earlier). */
      const startedAt = Date.now();
      while (Date.now() - startedAt < 180_000) {
        const applied = await b2.eval<number>(
          "app.plugins.plugins.geode.state.getAllLocalFiles().size",
        );
        if (applied >= N) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(
        await b2.eval<number>("app.plugins.plugins.geode.state.getAllLocalFiles().size"),
        "full backlog must be applied after relaunch",
      ).toBeGreaterThanOrEqual(N);
      await waitForStatusBar(b2.win, "Geode: synced", 60_000);
      await b2.win.screenshot({
        path: shotPath("493-catchup-desktop-settled.png"),
        fullPage: true,
      });

      /* Full backlog on disk with correct bytes. */
      for (let i = 0; i < N; i++) {
        const got = await readFile(path.join(b2.vaultDir, fileName(i)), "utf8");
        expect(got, `backlog file ${i} bytes after relaunch`).toBe(makeContent(i));
      }

      /* No duplicate-version storm. A hard kill in the 2 s state-persist debounce window
         re-commits the applied-but-unpersisted files as identical duplicate versions: bounded,
         never a storm. */
      const count = serverVersionCount(pair.server.dataDir, pair.server.vaultId);
      expect(count, "full backlog must be on the server").toBeGreaterThanOrEqual(N);
      expect(count, "no duplicate-version storm").toBeLessThanOrEqual(N * 1.2);

      /* Its cursor reached the server head (including any re-commits). */
      const lastSeen = await b2.eval<number>("app.plugins.plugins.geode.getLastSeenSeq()");
      expect(lastSeen, "cursor must not skip versions").toBe(
        serverMaxSeq(pair.server.dataDir, pair.server.vaultId),
      );
    } finally {
      await b2.close();
    }
  } finally {
    /* hardKill made B.close() a no-op for the dirs: remove them explicitly. */
    await pair.stop();
    await rm(pair.B.vaultDir, { recursive: true, force: true });
    await rm(pair.B.userDataDir, { recursive: true, force: true });
  }
});
