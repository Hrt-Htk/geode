import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchPair, type ObsidianPair } from "../fixtures/pair";
import {
  commitPath,
  disconnectSync,
  getLocalVersion,
  reconnectSync,
  upsertVaultFile,
  waitForUnlocked,
} from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #84: when a received version fails to apply for a file new to the device
// (no local row), the failure must appear as an Activity error with the
// decrypted plaintext path while leaving the persisted sync cursor behind.
const PASSPHRASE = "apply-failure-activity-pass";
const STATUSBAR = '[data-testid="geode-statusbar"]';
const MODAL = ".geode-activity-modal";

const row = (o: ObsidianPair["B"], filePath: string) =>
  o.win.locator(`${MODAL} [data-testid="geode-activity-row"][data-path="${filePath}"]`);

async function openActivityErrors(o: ObsidianPair["B"]): Promise<void> {
  await o.win.locator(STATUSBAR).click();
  await expect(o.win.locator(".menu")).toBeVisible({ timeout: 10_000 });
  await o.win.locator(".menu").last().locator(".menu-item", { hasText: "Sync activity" }).click();
  await expect(o.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
  await o.win.locator('[data-testid="geode-activity-filter-error"]').click();
}

async function closeActivity(o: ObsidianPair["B"]): Promise<void> {
  await o.win.keyboard.press("Escape");
  await expect(o.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });
}

test("apply failure for a new file surfaces in Activity without advancing cursor", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    const cursorBefore = await pair.B.eval<number>(
      `app.plugins.plugins.geode.state.getSyncCursor()`,
    );

    /* ---- Replay flush failure: A uploads new file, server blob removed before B reconnects ---- */
    await disconnectSync(pair.B);

    const replayPath = "notes/missing-blob.md";
    await upsertVaultFile(pair.A, replayPath, "# Missing blob\nonly on A\n");
    await commitPath(pair.A, replayPath);
    await expect.poll(() => getLocalVersion(pair.A, replayPath), { timeout: 30_000 }).toBe(1);

    await rm(path.join(pair.server.dataDir, "blobs", pair.server.vaultId), {
      recursive: true,
      force: true,
    });

    await reconnectSync(pair.B);

    await expect
      .poll(
        () =>
          pair.B.eval<{ kind: string; cause: string | null } | null>(
            `(() => {
              const e = app.plugins.plugins.geode?.activity?.entries.get(${
              JSON.stringify(replayPath)
            });
              return e ? { kind: e.kind, cause: e.cause } : null;
            })()`,
          ),
        { timeout: 30_000 },
      )
      .toEqual({
        kind: "error",
        cause: expect.stringMatching(/blob GET .*: 404/),
      });

    expect(
      await pair.B.eval<boolean>(
        `app.plugins.plugins.geode.state.getLocalFile(${JSON.stringify(replayPath)}) === null`,
      ),
    ).toBe(true);
    expect(
      await pair.B.eval<number>(`app.plugins.plugins.geode.state.getSyncCursor()`),
    ).toBe(cursorBefore);

    /* ---- Live apply failure: B is live and disk path collides with a directory ---- */
    const livePath = "notes/live-dir-collision.md";
    await mkdir(path.join(pair.B.vaultDir, livePath), { recursive: true });

    await upsertVaultFile(pair.A, livePath, "# Live collision\ncannot write over dir\n");
    await commitPath(pair.A, livePath);
    await expect.poll(() => getLocalVersion(pair.A, livePath), { timeout: 30_000 }).toBe(1);

    await expect
      .poll(
        () =>
          pair.B.eval<{ kind: string; cause: string | null } | null>(
            `(() => {
              const e = app.plugins.plugins.geode?.activity?.entries.get(${
              JSON.stringify(livePath)
            });
              return e ? { kind: e.kind, cause: e.cause } : null;
            })()`,
          ),
        { timeout: 30_000 },
      )
      .toEqual({
        kind: "error",
        cause: expect.any(String),
      });

    expect(
      await pair.B.eval<number>(`app.plugins.plugins.geode.state.getSyncCursor()`),
    ).toBe(cursorBefore);

    /* ---- Real Activity modal Errors tab shows both files with plaintext names ---- */
    await openActivityErrors(pair.B);
    await expect(row(pair.B, replayPath)).toBeVisible();
    expect(await row(pair.B, replayPath).getAttribute("data-kind")).toBe("error");
    expect(await row(pair.B, replayPath).locator(".geode-activity-name").textContent()).toBe(
      "missing-blob.md",
    );
    expect(await row(pair.B, replayPath).locator(".geode-activity-desc").textContent()).toMatch(
      /^Error · blob GET .*: 404$/,
    );

    await expect(row(pair.B, livePath)).toBeVisible();
    expect(await row(pair.B, livePath).getAttribute("data-kind")).toBe("error");
    expect(await row(pair.B, livePath).locator(".geode-activity-name").textContent()).toBe(
      "live-dir-collision.md",
    );

    await pair.B.win.locator(MODAL).screenshot({
      path: shotPath("apply-failure-activity-modal.png"),
    });
    await closeActivity(pair.B);

    expect(await pair.A.consoleErrors()).toEqual([]);
    expect(await pair.B.consoleErrors()).toEqual([]);
  } finally {
    await pair.stop();
  }
});
