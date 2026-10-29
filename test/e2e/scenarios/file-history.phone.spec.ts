import { expect, test } from "@playwright/test";
import { connectPhone, type PhoneInstance } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #464 (phone): the history modal on the real device keeps the two panes
// stacked: the period list alone, then the selected version's preview with
// Back, never side by side.
const PASSPHRASE = "file-history-phone-pass";
const NOTE = "history-phone.md";

const MODAL = ".geode-history-modal";

async function openHistory(obsidian: PhoneInstance): Promise<void> {
  await obsidian.eval(`
    const file = app.vault.getFileByPath(${JSON.stringify(NOTE)});
    if (!file) throw new Error("expected " + ${JSON.stringify(NOTE)} + " in the vault");
    await app.workspace.getLeaf(true).openFile(file);
    app.commands.executeCommandById("geode:geode-show-file-history");
    return true;
  `);
  await expect(obsidian.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
}

test("file history (phone): list, tap a period, preview with Back", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("file-history");
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
    /* The reset vault starts locked: unlock with the test passphrase first. */
    await expect
      .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 30_000 })
      .toBe("Geode: locked");
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* ---- One editing period with two saves ---- */
    await upsertVaultFile(obsidian, NOTE, "# Phone history\n\nfirst save\n");
    await commitPath(obsidian, NOTE);
    await upsertVaultFile(obsidian, NOTE, "# Phone history\n\nsecond save\n");
    await commitPath(obsidian, NOTE);
    await expect
      .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 60_000 })
      .toContain("Geode: synced");

    /* ---- The list comes first, full width, with no preview beside it ---- */
    await openHistory(obsidian);
    await expect(obsidian.win.locator(`${MODAL} .modal-title`)).toHaveText(
      "History · history-phone.md",
    );
    const period = obsidian.win.locator(`${MODAL} [data-testid="geode-history-period"]`);
    await expect(period).toHaveCount(1);
    await expect(period).toContainText("2 saves");
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toHaveCount(0);
    await obsidian.screenshot(shotPath("464-phone-01-list.png"));

    /* ---- Tapping the period opens the preview with Back ---- */
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-period"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-back"]`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText(
        "second save",
      );
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-period"]`)).toHaveCount(
      0,
    );
    await obsidian.screenshot(shotPath("464-phone-02-preview.png"));

    /* ---- Back returns to the list ---- */
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-back"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-period"]`)).toHaveCount(
      1,
    );
    await dismissModals(obsidian);
    await expect(obsidian.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});

/** Delete the note and commit the deletion, so it lands in the trash. */
async function deleteNote(obsidian: PhoneInstance): Promise<void> {
  await obsidian.eval(`
    const file = app.vault.getFileByPath(${JSON.stringify(NOTE)});
    if (!file) throw new Error("expected " + ${JSON.stringify(NOTE)});
    await app.vault.delete(file);
    return true;
  `);
  await commitPath(obsidian, NOTE, "delete");
}

/** The trash row's Restore: the server appends the restored head version (#687). */
async function restoreFromTrash(obsidian: PhoneInstance, content: string): Promise<void> {
  await obsidian.eval(`app.commands.executeCommandById("geode:geode-open-trash"); return true;`);
  await expect(obsidian.win.locator('.geode-trash-modal [data-testid="geode-trash-restore"]'))
    .toHaveCount(1, { timeout: 15_000 });
  await evalClick(obsidian, '[data-testid="geode-trash-restore"]');
  await dismissModals(obsidian);
  await expect(obsidian.win.locator(".geode-trash-modal")).toHaveCount(0, { timeout: 10_000 });
  await expect
    .poll(async () => await readVaultFile(obsidian), { timeout: 60_000 })
    .toBe(content);
}

async function readVaultFile(obsidian: PhoneInstance): Promise<string | null> {
  return await obsidian.eval<string | null>(
    `(await app.vault.adapter.exists(${JSON.stringify(NOTE)}))
      ? await app.vault.adapter.read(${JSON.stringify(NOTE)}) : null`,
  );
}

/** Notices from the restore fade over the modal: clear them so the shot shows it alone. */
async function clearNotices(obsidian: PhoneInstance): Promise<void> {
  await obsidian.eval(
    `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
  );
}

// #691 (phone): a deletion and a restore from the trash are rows of their own. The phone
// has no hover, so the restore row carries the chevron that says it opens a preview, and a
// tap on the deletion row only shows the text the phone width cut off.
test("file history (phone): a deletion and a restore row, and only the restore previews", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  /* A device name long enough to cut a row on a phone screen, as a real one is. */
  const device = await server.mintToken("Pixel 9 Pro XL of Alex");
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
    await expect
      .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 30_000 })
      .toBe("Geode: locked");
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* ---- Two saves, a deletion, then a restore from the trash ---- */
    await upsertVaultFile(obsidian, NOTE, "# Phone history\n\nfirst draft\n");
    await commitPath(obsidian, NOTE);
    await upsertVaultFile(obsidian, NOTE, "# Phone history\n\nsecond draft\n");
    await commitPath(obsidian, NOTE);
    await expect.poll(async () => await readVaultFile(obsidian), { timeout: 30_000 })
      .toBe("# Phone history\n\nsecond draft\n");
    await deleteNote(obsidian);
    await restoreFromTrash(obsidian, "# Phone history\n\nsecond draft\n");

    /* ---- The two event rows, collapsed, above the period ---- */
    const events = `${MODAL} [data-testid="geode-history-event"]`;
    const restored = `${events}[data-event="restored"]`;
    const deleted = `${events}[data-event="deleted"]`;
    await openHistory(obsidian);
    await expect(obsidian.win.locator(events)).toHaveCount(2);
    await expect(obsidian.win.locator(restored)).toHaveCount(1);
    await expect(obsidian.win.locator(restored)).toContainText("Restored from trash");
    await expect(obsidian.win.locator(deleted)).toHaveCount(1);
    await expect(obsidian.win.locator(deleted)).toContainText("Deleted");
    /* A phone has no hover: the chevron is the only mark saying a row opens something,
       and only the restore row carries it (#691). */
    const chevron = '[data-testid="geode-history-event-chevron"]';
    await expect(obsidian.win.locator(`${restored} ${chevron}`)).toHaveCount(1);
    await expect(obsidian.win.locator(`${deleted} ${chevron}`)).toHaveCount(0);
    await clearNotices(obsidian);
    await obsidian.screenshot(shotPath("691-phone-01-events-list.png"));

    /* ---- Tapping the restore row previews the content it brought back ---- */
    await evalClick(obsidian, restored);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("second draft", { timeout: 20_000 });
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-back"]`)).toBeVisible();
    /* The row's own words, since the preview screen has one version and its clock time
       alone would not say what it is (#691). */
    await expect(obsidian.win.locator(`${MODAL} .geode-history-meta`))
      .toHaveText(/^Restored from trash on Pixel 9 Pro XL of Alex · \d{2}:\d{2}$/);
    await clearNotices(obsidian);
    await obsidian.screenshot(shotPath("691-phone-02-restore-preview.png"));

    /* ---- Back, then the deletion row: it holds no content, so a tap only shows the
       text the phone width cut off (#691) ---- */
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-back"]`);
    await expect(obsidian.win.locator(events)).toHaveCount(2);
    const deletedLabel = obsidian.win.locator(`${deleted} .geode-history-event-label`);
    /* One line, cut with an ellipsis: the label is wider than the box it sits in. */
    await expect(deletedLabel).toHaveCSS("white-space", "nowrap");
    const cut = await deletedLabel.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(cut, "the deletion row is cut at phone width").toBeGreaterThan(0);
    await evalClick(obsidian, deleted);
    await expect(obsidian.win.locator(deleted)).toHaveClass(/is-expanded/);
    await expect(deletedLabel).toHaveCSS("white-space", "normal");
    /* The rest of the text is on the next line now: nothing left hidden. */
    const stillCut = await deletedLabel.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(stillCut, "the expanded row hides nothing").toBeLessThanOrEqual(0);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-back"]`)).toHaveCount(
      0,
    );
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toHaveCount(0);
    await expect(obsidian.win.locator(events)).toHaveCount(2);
    await clearNotices(obsidian);
    await obsidian.screenshot(shotPath("691-phone-03-deletion-row-expanded.png"));
    await evalClick(obsidian, deleted);
    await expect(obsidian.win.locator(deleted)).not.toHaveClass(/is-expanded/);

    /* ---- With an older save selected, neither row is the active one ---- */
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-chevron"]`);
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-save"][data-version="1"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("first draft", { timeout: 20_000 });
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-back"]`);
    await expect(obsidian.win.locator(restored)).not.toHaveClass(/is-active/);
    await obsidian.screenshot(shotPath("691-phone-04-events-unselected.png"));

    await dismissModals(obsidian);
    await expect(obsidian.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
