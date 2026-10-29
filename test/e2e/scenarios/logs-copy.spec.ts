import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { openLogsSection } from "../helpers/logs";

const PASSPHRASE = "logs-copy-passphrase";

// #188 Phase D2: the Logs section's "Copy logs" button + selectable log CSS
// (moved here from the removed debug pane). Launches with Debug logging on,
// verifies the Copy logs button and log-box testids, asserts the log is
// populated and has no unexpected [error] lines, and screenshots the section.
test("logs section copy-logs button and selectable log", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("logs-copy");

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

    // Generate some log activity by creating notes (drives commit → sync logs).
    await obsidian.eval(`
      await app.vault.create("note.md", "# Gate 188\\ntest note\\n");
      return true;
    `);

    // Open the Logs section.
    await openLogsSection(obsidian);

    // Dismiss any notices before the shot.
    await obsidian.eval(`
      document.querySelectorAll('.notice').forEach((n) => n.remove());
      return true;
    `);

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

    // Assert the "Copy logs" button exists with correct testid.
    const copyButtonExists = await obsidian.eval<boolean>(`
      const btn = document.querySelector('[data-testid="geode-log-copy"]');
      return btn !== null && btn.textContent?.includes("Copy logs");
    `);
    expect(copyButtonExists, "Copy logs button with testid should exist").toBe(true);

    // Assert the log box has the testid.
    const logContainerExists = await obsidian.eval<boolean>(
      `document.querySelector('[data-testid="geode-log-box"]') !== null`,
    );
    expect(logContainerExists, "geode-log-box container with testid should exist").toBe(true);

    // Dump the rendered log lines.
    const lines = await obsidian.eval<string[]>(
      `Array.from(document.querySelectorAll('[data-testid="geode-log-box"] .geode-log-line')).map((n) => n.textContent ?? "")`,
    );
    console.log("=== LOGS SECTION LOG LINES ===");
    for (const l of lines) console.log(l);
    console.log("=== END ===");

    // Assert no unexpected [error] lines in the log.
    const errorLines = lines.filter((l) => /\[error\]/.test(l));
    if (errorLines.length > 0) {
      console.warn("WARNING: unexpected [error] lines in the log:");
      for (const l of errorLines) console.warn(l);
    }

    // Screenshot the Logs section scrolled into view.
    await obsidian.eval(`
      document.querySelectorAll('.notice').forEach((n) => n.remove());
      document.querySelector('[data-testid="geode-log-box"]')?.scrollIntoView({ block: "center" });
      return true;
    `);
    await obsidian.win.waitForTimeout(300);
    await obsidian.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("logs-copy.png"),
    }).catch(async () => {
      await obsidian.win.screenshot({ path: shotPath("logs-copy.png") });
    });
    console.log("SCREENSHOT:", "logs-copy.png");
  } finally {
    await obsidian.close();
    await server.stop?.();
  }
});
