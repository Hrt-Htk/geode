import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import type { SyncDevice } from "../helpers/device-abstraction";
import { commitPath, upsertVaultFile } from "../helpers/geode";
import { waitForContent, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #465: a restore on one device is one NEW version the other device receives:
// run both directions (desktop restores, phone receives; phone restores, desktop
// receives) against a real Obsidian on each side.
const PASSPHRASE = "restore-hybrid-pass";
const NOTE = "notes/restore-hybrid.md";

const MODAL = ".geode-history-modal";
const CONFIRM = ".geode-confirm-modal";

/** Drive the real modal in-page: both devices run the same renderer DOM. */
async function restoreVersionOn(device: SyncDevice, note: string, version: number): Promise<void> {
  await device.eval(`
    const file = app.vault.getFileByPath(${JSON.stringify(note)});
    if (!file) throw new Error("expected " + ${JSON.stringify(note)} + " in the vault");
    await app.workspace.getLeaf(true).openFile(file);
    app.commands.executeCommandById("geode:geode-show-file-history");
    return true;
  `);
  await expect
    .poll(() => device.eval<boolean>(`!!document.querySelector("${MODAL}")`), { timeout: 20_000 })
    .toBe(true);
  /* Expand every period so its saves are on screen. */
  await device.eval(
    `document.querySelectorAll('[data-testid="geode-history-chevron"]').forEach((c) => c.click()); return true;`,
  );
  const save = `[data-testid="geode-history-save"][data-version="${version}"]`;
  await expect
    .poll(() => device.eval<number>(`document.querySelectorAll('${save}').length`), {
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  await device.eval(`[...document.querySelectorAll('${save}')].at(-1).click(); return true;`);
  await expect
    .poll(
      () =>
        device.eval<boolean>(`!!document.querySelector('[data-testid="geode-history-restore"]')`),
      { timeout: 20_000 },
    )
    .toBe(true);
  await device.eval(
    `document.querySelector('[data-testid="geode-history-restore"]').click(); return true;`,
  );
  await expect
    .poll(() => device.eval<boolean>(`!!document.querySelector("${CONFIRM}")`), { timeout: 20_000 })
    .toBe(true);
  await device.eval(
    `document.querySelector('[data-testid="geode-confirm-yes"]').click(); return true;`,
  );
}

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone restores" : "desktop restores";
  test(`restore is one new version the peer receives (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.slow();

    const pair = await launchHybridPair({ passphrase: PASSPHRASE, phoneAsA });

    try {
      await expect
        .poll(async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
        .toBe(true);
      await expect
        .poll(async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
        .toBe(true);
      await waitForStatusBar(pair.A, "Geode: synced", 60_000);
      await waitForStatusBar(pair.B, "Geode: synced", 60_000);

      for (const body of ["first version", "second version"]) {
        await upsertVaultFile(pair.A, NOTE, `# Hybrid restore\n\n${body}\n`);
        await commitPath(pair.A, NOTE);
      }
      await waitForContent(pair.A, pair.B, NOTE, "# Hybrid restore\n\nsecond version\n");

      await restoreVersionOn(pair.A, NOTE, 1);
      await expect
        .poll(
          async () =>
            await pair.A.eval<string>(`document.querySelector(".notice")?.textContent ?? ""`),
          { timeout: 30_000 },
        )
        .toContain("Restored and saved as a new version");
      await pair.A.screenshot(shotPath(`465-hybrid-${role.replace(/ /g, "-")}-notice.png`));

      await waitForContent(pair.A, pair.B, NOTE, "# Hybrid restore\n\nfirst version\n");
      /* The receiving device applied it as one more version of the same name. */
      await expect
        .poll(
          async () =>
            await pair.B.eval<number>(
              `app.plugins.plugins.geode.state?.getLocalFile(${
                JSON.stringify(NOTE)
              })?.last_seen_version ?? 0`,
            ),
          { timeout: 60_000 },
        )
        .toBe(3);
      await pair.B.screenshot(shotPath(`465-hybrid-${role.replace(/ /g, "-")}-received.png`));
    } finally {
      await pair.stop();
    }
  });
}
