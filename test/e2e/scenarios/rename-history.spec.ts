import { expect, type Page, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #583: the history window follows the notes a rename wrote: one generation per
// name with a "Renamed from" row between them, the oldest content still
// previewable through Show older, and a trash row's History capped at the version
// it was deleted at (decision 6). A file recreated at the trashed name clears the
// row instead (#465), so the reuse is asserted as an empty trash, not as a row.
const PASSPHRASE = "rename-history-pass";
const FIRST = "Notes/Rename me.md";
const SECOND = "Notes/Second name.md";
const THIRD = "Notes/Third name.md";

const MODAL = ".geode-history-modal";
const TRASH = ".geode-trash-modal";
const ACTIVITY = ".geode-activity-modal";

/** Rename through the real vault API, so the plugin's own event writes the link. */
async function rename(
  o: { eval: <T>(jsExpr: string) => Promise<T> },
  from: string,
  to: string,
): Promise<void> {
  await o.eval(`
    const entry = app.vault.getAbstractFileByPath(${JSON.stringify(from)});
    if (!entry) throw new Error("expected the entry to rename: " + ${JSON.stringify(from)});
    await app.vault.rename(entry, ${JSON.stringify(to)});
    return true;
  `);
}

/** Waits until the server holds `mark` on that name's head (a rename's commit is queued). */
async function waitForMark(
  o: { eval: <T>(jsExpr: string) => Promise<T> },
  vaultPath: string,
  mark: number,
): Promise<void> {
  await expect
    .poll(
      async () =>
        await o.eval<number>(`
          const row = app.plugins.plugins.geode.state.getLocalFile(${JSON.stringify(vaultPath)});
          if (!row) return -1;
          const chain = await app.plugins.plugins.geode.transport.getVersionChain(row.path_hash);
          return chain[0] ? chain[0].rename_mark : 0;
        `),
      { timeout: 60_000 },
    )
    .toBe(mark);
}

async function openHistory(
  o: { win: Page; eval: <T>(jsExpr: string) => Promise<T> },
  vaultPath: string,
): Promise<void> {
  await o.eval(`
    const file = app.vault.getFileByPath(${JSON.stringify(vaultPath)});
    if (!file) throw new Error("expected " + ${JSON.stringify(vaultPath)} + " in the vault");
    await app.workspace.getLeaf(true).openFile(file);
    app.commands.executeCommandById("geode:geode-show-file-history");
    return true;
  `);
  await expect(o.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
}

test("rename history: marker rows across two renames, trash History capped", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("history");
  const o = await launchObsidian({
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
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    /* ---- Three generations: three saves, a rename, two saves, a rename ---- */
    for (const body of ["first draft", "second draft", "third draft"]) {
      await upsertVaultFile(o, FIRST, `# Rename me\n\n${body}\n`);
      await commitPath(o, FIRST);
    }
    await rename(o, FIRST, SECOND);
    await waitForMark(o, FIRST, 1);
    await waitForMark(o, SECOND, 2);
    for (const body of ["after the first rename", "second save at the new name"]) {
      await upsertVaultFile(o, SECOND, `# Second name\n\n${body}\n`);
      await commitPath(o, SECOND);
    }
    await rename(o, SECOND, THIRD);
    await waitForMark(o, SECOND, 1);
    await waitForMark(o, THIRD, 2);

    /* ---- The newest name has one save, but one name of history behind it ---- */
    await openHistory(o, THIRD);
    await expect(o.win.locator(`${MODAL} .modal-title`)).toHaveText("History · Third name.md");
    const periods = o.win.locator(`${MODAL} [data-testid="geode-history-period"]`);
    const markers = o.win.locator(`${MODAL} [data-testid="geode-history-marker"]`);
    await expect(periods).toHaveCount(1);
    await expect(markers).toHaveCount(0);
    const older = o.win.locator(`${MODAL} [data-testid="geode-history-older"]`);
    await expect(older).toBeVisible();
    await o.win.locator(MODAL).screenshot({ path: shotPath("583-01-one-name.png") });

    /* ---- Show older crosses the first rename: a marker row, then its saves ---- */
    await older.click();
    await expect(periods).toHaveCount(2);
    await expect(markers).toHaveCount(1);
    await expect(markers.first()).toHaveText("Renamed from Notes/Second name.md");
    await o.win.mouse.move(5, 5);
    await o.win.locator(MODAL).screenshot({ path: shotPath("583-02-first-marker.png") });

    /* ---- Show older again reaches the oldest name; its content previews ---- */
    await older.click();
    await expect(periods).toHaveCount(3);
    await expect(markers).toHaveCount(2);
    await expect(markers.last()).toHaveText("Renamed from Notes/Rename me.md");
    /* Expand the oldest name's period, then pick its first save. */
    await o.win.locator(`${MODAL} [data-testid="geode-history-chevron"]`).last().click();
    await o.win.locator(`${MODAL} [data-testid="geode-history-save"][data-version="1"]`).last()
      .click();
    await expect(o.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`)).toContainText(
      "first draft",
    );
    await o.win.mouse.move(5, 5);
    await o.win.locator(MODAL).screenshot({ path: shotPath("583-03-history-markers.png") });
    await o.win.locator('[data-testid="geode-history-done"]').click();
    await expect(o.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });

    /* ---- The renamed-away name opened from its activity row (uncapped) lists its
       own saves: its head row is the marker that renamed it away. ---- */
    await o.win.locator('[data-testid="geode-statusbar"]').click();
    await expect(o.win.locator(".menu")).toBeVisible({ timeout: 10_000 });
    await o.win.locator(".menu").last().locator(".menu-item", { hasText: "Sync activity" }).click();
    await expect(o.win.locator(ACTIVITY)).toBeVisible({ timeout: 10_000 });
    await o.win.locator(`${ACTIVITY} [data-testid="geode-activity-row"][data-path="${FIRST}"]`)
      .click();
    await expect(o.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
    await expect(o.win.locator(`${MODAL} [data-testid="geode-history-empty"]`)).toHaveCount(0);
    await expect(periods).toHaveCount(1);
    await o.win.locator(`${MODAL} [data-testid="geode-history-chevron"]`).first().click();
    await expect(o.win.locator(`${MODAL} [data-testid="geode-history-save"]`)).toHaveCount(3);
    await o.win.mouse.move(5, 5);
    await o.win.locator(MODAL).screenshot({ path: shotPath("583-06-renamed-away-name.png") });
    await o.win.locator('[data-testid="geode-history-done"]').click();
    await expect(o.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });
    await o.win.locator('[data-testid="geode-activity-done"]').click();
    await expect(o.win.locator(ACTIVITY)).toHaveCount(0, { timeout: 10_000 });

    /* ---- Delete the newest name: the trash row's History is capped at the version
       it was deleted at (decision 6), so it never runs past the deletion. ---- */
    await o.eval(`
      const file = app.vault.getFileByPath(${JSON.stringify(THIRD)});
      if (!file) throw new Error("expected " + ${JSON.stringify(THIRD)});
      await app.vault.delete(file);
      return true;
    `);
    await commitPath(o, THIRD, "delete");

    await o.win.locator('[data-testid="geode-statusbar"]').click();
    await expect(o.win.locator(".menu")).toBeVisible({ timeout: 10_000 });
    await o.win.locator(".menu").last().locator(".menu-item", { hasText: "Deleted files" }).click();
    await expect(o.win.locator(TRASH)).toBeVisible({ timeout: 10_000 });
    const history = o.win.locator(`${TRASH} [data-testid="geode-trash-history"]`);
    await expect(history).toHaveCount(1);
    await o.win.locator(TRASH).screenshot({ path: shotPath("583-04-trash-history-button.png") });

    /* ---- The capped window: this name up to its deleted version, then its past ---- */
    await history.click();
    await expect(o.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
    await expect(o.win.locator(`${MODAL} .geode-history-capped`)).toHaveText(
      "History of this file, up to the deleted version.",
    );
    /* Show older walks back into the deleted file's own past, across its renames. */
    await older.click();
    await expect(periods).toHaveCount(2);
    await expect(o.win.locator(`${MODAL} [data-testid="geode-history-marker"]`).first()).toHaveText(
      "Renamed from Notes/Second name.md",
    );
    /* The name before it in the window is the same file, one rename back. */
    await o.win.locator(`${MODAL} [data-testid="geode-history-chevron"]`).last().click();
    await o.win.locator(`${MODAL} [data-testid="geode-history-save"][data-version="2"]`).last()
      .click();
    await expect(o.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`)).toContainText(
      "after the first rename",
    );
    await o.win.mouse.move(5, 5);
    await o.win.locator(MODAL).screenshot({ path: shotPath("583-05-trash-history-capped.png") });
    await o.win.locator('[data-testid="geode-history-done"]').click();
    await expect(o.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });

    /* ---- Recreating a file at the trashed name clears the row (#465): a live name
       never stays in the trash, so its History is reachable from the live file. ---- */
    await o.win.keyboard.press("Escape");
    await expect(o.win.locator(TRASH)).toHaveCount(0, { timeout: 10_000 });
    await upsertVaultFile(o, THIRD, "# Third name\n\na later file at the reused name\n");
    await commitPath(o, THIRD);
    await o.eval(`app.commands.executeCommandById("geode:geode-open-trash"); return true;`);
    await expect(o.win.locator(TRASH)).toBeVisible({ timeout: 10_000 });
    await expect(o.win.locator(`${TRASH} [data-testid="geode-trash-empty"]`)).toBeVisible({
      timeout: 15_000,
    });
    await o.win.keyboard.press("Escape");
    await expect(o.win.locator(TRASH)).toHaveCount(0, { timeout: 10_000 });

    /* The debug ring has no errors after the whole walk. */
    const errors = await o.eval<string[]>(
      `app.plugins.plugins.geode.getRecentLog()
        .filter((entry) => entry.level === "error")
        .map((entry) => entry.msg + " " + JSON.stringify(entry.fields ?? {}))`,
    );
    expect(errors).toEqual([]);
  } finally {
    await o.close();
    await server.stop();
  }
});
