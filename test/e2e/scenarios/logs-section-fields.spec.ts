import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { openLogsSection } from "../helpers/logs";

const PASSPHRASE = "logs-fields-passphrase";

// #107: the Logs section must render each log entry's `fields` (e.g. the real
// error), not just "[ts] [level] msg". This spec generates fielded client logs,
// screenshots the section, and asserts at least one rendered line shows a
// "· key=value" field summary.
test("logs section renders log fields (· key=value)", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("logs-fields");

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
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    // Generate fielded client logs: creating notes drives commit → sync-manager
    // logs "handlePendingOps completed" { count }, etc.
    await obsidian.eval(`
      await app.vault.create("note-alpha.md", "# Alpha\\nhello world\\n");
      await app.vault.create("note-beta.md", "# Beta\\nsecond note\\n");
      return true;
    `);

    // Open the Logs section.
    await openLogsSection(obsidian);

    // Dismiss any notices before the shot.
    await obsidian.eval(
      `document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`,
    );

    // Wait for log lines to render.
    await expect
      .poll(
        async () =>
          await obsidian.eval<number>(
            `document.querySelectorAll('[data-testid="geode-log-box"] .geode-log-line').length`,
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    // Dump the rendered log-line texts so we can see exactly what #107 produces.
    const lines = await obsidian.eval<string[]>(
      `Array.from(document.querySelectorAll('[data-testid="geode-log-box"] .geode-log-line')).map((n) => n.textContent ?? "")`,
    );
    console.log("=== LOGS SECTION LOG LINES ===");
    for (const l of lines) console.log(l);
    console.log("=== END ===");

    // Assert at least one line shows a "· key=value" field summary (the #107 behavior).
    const hasFieldLine = lines.some((l) => / · .+=/.test(l));
    expect(hasFieldLine, "expected a log line with a · key=value field summary").toBe(true);

    // Screenshot the Logs section scrolled into view.
    await obsidian.eval(`
      document.querySelectorAll('.notice').forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await obsidian.win.waitForTimeout(300);
    await obsidian.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("logs-section-fields.png"),
    }).catch(async () => {
      await obsidian.win.screenshot({ path: shotPath("logs-section-fields.png") });
    });
    console.log("SCREENSHOT:", "logs-section-fields.png");
  } finally {
    await obsidian.close();
    await server.stop?.();
  }
});
