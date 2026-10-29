import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { openLogsSection } from "../helpers/logs";

const PASSPHRASE = "logs-seq-advance-passphrase";

// #434: the debug pane is gone; the Logs section's details line shows the
// live "Connected · seq N · N pending". This gate keeps the seq-advance
// assertion: after this device's own commit, the details-line seq grows.

test("log details seq advances on this device's own commit ack", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("logs-seq-advance");

  const obsidian = await launchObsidian({
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
    /* Wait for vault unlocked and synced */
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* 1. Open the Logs section. */
    await openLogsSection(obsidian);

    /* 2. Read seqBefore from the plugin's cursor. */
    const seqBefore = await obsidian.eval<number>(
      "app.plugins.plugins.geode.getLastSeenSeq()",
    );

    /* Screenshot before: the Logs section scrolled into view. */
    await obsidian.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await obsidian.win.waitForTimeout(300);
    await obsidian.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("lastseq-before.png"),
    });

    /* 3. Create a file to trigger a commit. */
    await obsidian.eval(`
      await app.vault.create("owncommit-test.md", "hello from this device");
      return true;
    `);

    /* 4. Poll getLastSeenSeq() until it is strictly greater than seqBefore. */
    await expect
      .poll(
        async () => await obsidian.eval<number>("app.plugins.plugins.geode.getLastSeenSeq()"),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(seqBefore);

    /* 5. Assert the Logs details line shows seq > seqBefore. */
    await expect
      .poll(
        async () => {
          const m = (await obsidian.eval<string>(
            `document.querySelector('[data-testid="geode-log-details"]')?.textContent ?? ""`,
          )).match(/^Connected · seq (\d+) · \d+ pending$/);
          return m ? parseInt(m[1], 10) : -1;
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(seqBefore);

    /* Screenshot after: the Logs section scrolled into view. */
    await obsidian.eval(`
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await obsidian.win.waitForTimeout(300);
    await obsidian.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("lastseq-after.png"),
    });
  } finally {
    await obsidian.close();
    await server.stop().catch(() => {});
  }
});
