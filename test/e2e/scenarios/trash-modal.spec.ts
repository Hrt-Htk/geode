import { expect, test } from "@playwright/test";
import { launchPair } from "../fixtures/pair";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForContent, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";
import { enterAdminToken } from "../helpers/admin-token";

// #461: trash as a modal (mockup 446): opened from Settings → Trash → [View]
// and the status-menu "Deleted files"; per-file rows with device + retention,
// live search with a selection that survives filtering, Restore/Purge with the
// #445 confirm family, the settings live count, and per-file preview (#455).
const PASSPHRASE = "trash-pass";
const NOTE_PATH = "notes/preview.md";
const IMG_PATH = "attachments/pic.png";
const PDF_PATH = "attachments/scan.pdf";
const NOTE_CONTENT = "# Note\nPreview me **bold**.\n";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// A "large" binary (1 MB): a naive preview would download all of it just to show
// the not-available line. The size guard must render the line with no fetch.
const PDF_BYTES = "%PDF-1.4\n" + "x".repeat(1 << 20) + "\n%%EOF";

type TrashEntry = { path_hash: string; path?: string };

async function writeBinary(
  instance: { eval: <T>(jsExpr: string) => Promise<T> },
  vaultPath: string,
  b64: string,
): Promise<void> {
  await instance.eval(`
    const path = ${JSON.stringify(vaultPath)};
    const b64 = ${JSON.stringify(b64)};
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder && !(await app.vault.adapter.exists(folder))) await app.vault.createFolder(folder);
    await app.vault.adapter.writeBinary(path, bytes);
    return true;
  `);
}

async function deleteFile(
  instance: { eval: <T>(jsExpr: string) => Promise<T> },
  vaultPath: string,
): Promise<void> {
  await instance.eval(`
    const path = ${JSON.stringify(vaultPath)};
    const file = app.vault.getAbstractFileByPath(path);
    if (!file) throw new Error("expected file to delete: " + path);
    await app.vault.delete(file);
    return !(await app.vault.adapter.exists(path));
  `);
}

async function waitAbsent(
  instance: { eval: <T>(jsExpr: string) => Promise<T> },
  vaultPath: string,
): Promise<void> {
  await expect
    .poll(
      async () =>
        await instance.eval<boolean>(
          `!(await app.vault.adapter.exists(${JSON.stringify(vaultPath)}))`,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
}

async function waitPresent(
  instance: { eval: <T>(jsExpr: string) => Promise<T> },
  vaultPath: string,
): Promise<void> {
  await expect
    .poll(
      async () =>
        await instance.eval<boolean>(
          `await app.vault.adapter.exists(${JSON.stringify(vaultPath)})`,
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
}

/** Topmost confirm modal: title lives on .modal-title (sibling), body inside .geode-confirm-modal. */
async function confirmText(o: {
  eval: <T>(jsExpr: string) => Promise<T>;
}): Promise<{ title: string; msg: string; yes: string }> {
  return await o.eval(`(() => {
    const containers = document.querySelectorAll(".modal-container");
    const c = containers[containers.length - 1];
    return {
      title: c?.querySelector(".modal-title")?.textContent ?? "",
      msg: c?.querySelector(".geode-confirm-modal p")?.textContent ?? "",
      yes: c?.querySelector('[data-testid="geode-confirm-yes"]')?.textContent ?? "",
    };
  })()`);
}

async function openTrashFromSettings(
  o: { win: import("@playwright/test").Page; eval: <T>(jsExpr: string) => Promise<T> },
): Promise<void> {
  await o.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    app.setting.open();
    app.setting.openTabById("geode");
    return true;
  `);
  await o.win.locator('[data-testid="geode-settings-open-trash"]').click();
}

async function openTrashFromMenu(
  o: { win: import("@playwright/test").Page; eval: <T>(jsExpr: string) => Promise<T> },
): Promise<void> {
  await o.win.locator('[data-testid="geode-statusbar"]').click();
  await expect(o.win.locator(".menu")).toBeVisible({ timeout: 10_000 });
  await o.win.locator(".menu").last().locator(".menu-item", { hasText: "Deleted files" }).click();
  await expect(o.win.locator(".menu")).toHaveCount(0, { timeout: 10_000 });
}

test("trash modal: preview, search + selection, bulk purge and restore, live count", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    /* ---- A creates a note, an image and a pdf, all commit and sync to B ---- */
    await upsertVaultFile(pair.A, NOTE_PATH, NOTE_CONTENT);
    await writeBinary(pair.A, IMG_PATH, TINY_PNG);
    await writeBinary(pair.A, PDF_PATH, btoa(PDF_BYTES));
    await commitPath(pair.A, NOTE_PATH, "commit");
    await commitPath(pair.A, IMG_PATH, "commit");
    await commitPath(pair.A, PDF_PATH, "commit");
    await waitForContent(pair.A, pair.B, NOTE_PATH, NOTE_CONTENT);
    await waitPresent(pair.B, IMG_PATH);
    await waitPresent(pair.B, PDF_PATH);

    /* ---- A deletes all three; both converge to absent ---- */
    for (const p of [NOTE_PATH, IMG_PATH, PDF_PATH]) {
      await deleteFile(pair.A, p);
      await commitPath(pair.A, p, "delete");
    }
    for (const p of [NOTE_PATH, IMG_PATH, PDF_PATH]) {
      await waitAbsent(pair.A, p);
      await waitAbsent(pair.B, p);
    }

    const trash = await pair.A.eval<TrashEntry[]>(
      "await app.plugins.plugins.geode.trash.list()",
    );
    expect(trash.length).toBe(3);
    const hashOf = (path: string): string =>
      (trash.find((e) => e.path === path) ?? { path_hash: "missing" }).path_hash;

    /* ---- Open the modal from Settings → Trash → [View] ---- */
    await openTrashFromSettings(pair.A);
    const modal = pair.A.win.locator(".geode-trash-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(pair.A.win.locator('[data-testid="geode-trash-restore"]')).toHaveCount(3, {
      timeout: 15_000,
    });

    // Rows show the deleting device name and the retention line (not expired).
    const deviceLabel = "device-A";
    await expect(modal).toContainText(`from ${deviceLabel}`);
    await expect(pair.A.win.locator(".geode-trash-modal .geode-trash-purges")).toHaveCount(3);
    await expect(pair.A.win.locator(".geode-trash-modal .geode-trash-expired")).toHaveCount(0);

    await pair.A.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await modal.screenshot({ path: shotPath("461-01-loaded.png") });

    /* ---- Preview a text note: rendered markdown (fetches content) ---- */
    const fetchesBeforeText = await pair.A.eval<number>(
      "app.plugins.plugins.geode.trash.contentFetchCount()",
    );
    await pair.A.win
      .locator(`[data-testid="geode-trash-view"][data-path-hash="${hashOf(NOTE_PATH)}"]`)
      .click();
    const mdPreview = pair.A.win.locator('[data-testid="geode-preview-markdown"]');
    await expect(mdPreview).toBeVisible({ timeout: 15_000 });
    await expect(mdPreview).toContainText("Preview me");
    expect(
      await pair.A.eval<number>("app.plugins.plugins.geode.trash.contentFetchCount()"),
    ).toBe(fetchesBeforeText + 1);
    await pair.A.win.locator('[data-testid="geode-preview-close"]').click();
    await expect(mdPreview).not.toBeVisible({ timeout: 10_000 });

    /* ---- Preview an image: the real attachment renders ---- */
    await pair.A.win
      .locator(`[data-testid="geode-trash-view"][data-path-hash="${hashOf(IMG_PATH)}"]`)
      .click();
    const img = pair.A.win.locator('[data-testid="geode-preview-image"] img');
    await expect(img).toBeVisible({ timeout: 15_000 });
    expect(await img.getAttribute("src")).toMatch(/^blob:/);
    await pair.A.win.locator('[data-testid="geode-preview-close"]').click();

    /* ---- Preview a binary: type · size · preview not available + Restore to open. The
       size guard (#455) must render this line WITHOUT fetching any content. ---- */
    const fetchesBeforeBinary = await pair.A.eval<number>(
      "app.plugins.plugins.geode.trash.contentFetchCount()",
    );
    await pair.A.win
      .locator(`[data-testid="geode-trash-view"][data-path-hash="${hashOf(PDF_PATH)}"]`)
      .click();
    const binLine = pair.A.win.locator('[data-testid="geode-preview-binary"]');
    await expect(binLine).toBeVisible({ timeout: 15_000 });
    await expect(binLine).toContainText("PDF");
    await expect(binLine).toContainText("preview not available");
    await expect(pair.A.win.locator('[data-testid="geode-preview-restore"]')).toHaveText(
      "Restore to open",
    );
    expect(
      await pair.A.eval<number>("app.plugins.plugins.geode.trash.contentFetchCount()"),
    ).toBe(fetchesBeforeBinary);
    await pair.A.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await pair.A.win.locator(".modal-container").last().screenshot({
      path: shotPath("461-02-preview-binary.png"),
    });
    await pair.A.win.locator('[data-testid="geode-preview-close"]').click();

    /* ---- Search filters rows; No matches.; selection survives filtering ---- */
    const search = pair.A.win.locator('[data-testid="geode-trash-search"]');
    await search.fill("scan");
    await expect(pair.A.win.locator('[data-testid="geode-trash-restore"]')).toHaveCount(1);
    await search.fill("zzz-nope");
    await expect(pair.A.win.locator('[data-testid="geode-trash-no-matches"]')).toBeVisible();
    await search.fill("");
    await expect(pair.A.win.locator('[data-testid="geode-trash-restore"]')).toHaveCount(3);

    // Select the note row, then filter it out: the count label survives.
    await pair.A.win.locator(`[data-testid="geode-trash-check-${NOTE_PATH}"]`).check();
    await expect(pair.A.win.locator('[data-testid="geode-trash-count"]')).toHaveText("1 selected");
    await search.fill("scan");
    await expect(pair.A.win.locator('[data-testid="geode-trash-restore"]')).toHaveCount(1);
    await expect(pair.A.win.locator('[data-testid="geode-trash-count"]')).toHaveText("1 selected");
    // Select all toggles the visible (filtered) rows only → pdf joins the selection.
    await pair.A.win.locator('[data-testid="geode-trash-select-all"]').check();
    await expect(pair.A.win.locator('[data-testid="geode-trash-count"]')).toHaveText("2 selected");
    await search.fill("");
    await expect(pair.A.win.locator(`[data-testid="geode-trash-check-${NOTE_PATH}"]`))
      .toBeChecked();
    await expect(pair.A.win.locator(`[data-testid="geode-trash-check-${IMG_PATH}"]`)).not
      .toBeChecked();
    // Drop the note: keep only the pdf selected for the purge step.
    await pair.A.win.locator(`[data-testid="geode-trash-check-${NOTE_PATH}"]`).uncheck();
    await expect(pair.A.win.locator('[data-testid="geode-trash-count"]')).toHaveText("1 selected");

    /* ---- Purge selected (pdf): confirms, Cancel first, then purges ---- */
    await pair.A.win.locator('[data-testid="geode-trash-purge-selected"]').click();
    const confirm = pair.A.win.locator(".geode-confirm-modal");
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    const spec = await confirmText(pair.A);
    expect(spec.title).toBe("Purge selected files?");
    expect(spec.msg).toBe("Permanently deletes 1 selected file and its past versions.");
    expect(spec.yes).toBe("Purge 1 file");
    await pair.A.win.locator('[data-testid="geode-confirm-cancel"]').click();
    await expect(confirm).not.toBeVisible({ timeout: 10_000 });
    await expect(pair.A.win.locator('[data-testid="geode-trash-restore"]')).toHaveCount(3);

    await pair.A.win.locator('[data-testid="geode-trash-purge-selected"]').click();
    await pair.A.win.locator('[data-testid="geode-confirm-yes"]').click();
    // #677: the row is inside the server's retention floor, so the purge needs the admin
    // token before the server accepts it.
    await enterAdminToken(pair.A);
    await expect(pair.A.win.locator('[data-testid="geode-trash-restore"]')).toHaveCount(2, {
      timeout: 30_000,
    });
    // Purged means gone for good: the pdf stays deleted on B.
    await expect
      .poll(
        async () =>
          await pair.B.eval<boolean>(
            `!(await app.vault.adapter.exists(${JSON.stringify(PDF_PATH)}))`,
          ),
        {
          timeout: 60_000,
        },
      )
      .toBe(true);

    /* ---- Settings live count updates in place (behind the modal) ---- */
    const countRow = pair.A.win.locator(
      '[data-testid="geode-settings-trash-count"] .setting-item-description',
    );
    await expect
      .poll(async () => await countRow.textContent(), { timeout: 15_000 })
      .toBe("2 files in trash");

    /* ---- Restore selected (note): no confirm, converges back on device B ---- */
    await pair.A.win.locator(`[data-testid="geode-trash-check-${NOTE_PATH}"]`).check();
    await expect(pair.A.win.locator('[data-testid="geode-trash-count"]')).toHaveText("1 selected");
    await pair.A.win.locator('[data-testid="geode-trash-restore-selected"]').click();
    // No confirm dialog: the note comes back on both devices with its content.
    await expect(pair.A.win.locator(".geode-confirm-modal")).toHaveCount(0, { timeout: 5_000 });
    await waitForContent(pair.A, pair.B, NOTE_PATH, NOTE_CONTENT);

    await pair.A.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await modal.screenshot({ path: shotPath("461-03-after-actions.png") });

    expect(pair.A.consoleErrors()).toEqual([]);
    expect(pair.B.consoleErrors()).toEqual([]);
  } finally {
    await pair.stop();
  }
});

test("trash modal: empty, expired + purge count, error + retry", async () => {
  test.slow();

  // Server floor 0: the in-memory retention-0 below is honest against the
  // server (with the default 30-day floor the server would keep the entry).
  const server = await startServer({ env: { GEODE_TRASH_RETENTION_DAYS: "0" } });
  const device = await server.mintToken("empty");

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

    /* ---- Empty state: message + disabled actions ---- */
    await openTrashFromMenu(o);
    const modal = o.win.locator(".geode-trash-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(o.win.locator('[data-testid="geode-trash-empty"]')).toBeVisible({
      timeout: 15_000,
    });
    await expect(o.win.locator('[data-testid="geode-trash-empty"]')).toHaveText("Trash is empty.");
    await expect(o.win.locator('[data-testid="geode-trash-restore-all"]')).toBeDisabled();
    await expect(o.win.locator('[data-testid="geode-trash-purge-expired"]')).toBeDisabled();
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await modal.screenshot({ path: shotPath("461-04-empty.png") });
    await closeModal(o);
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    /* ---- Expired row (retention 0 in memory) + Purge expired confirm ---- */
    await upsertVaultFile(o, "notes/expired.md", "expired content");
    await commitPath(o, "notes/expired.md", "commit");
    await deleteFile(o, "notes/expired.md");
    await commitPath(o, "notes/expired.md", "delete");
    await expect
      .poll(
        async () => await o.eval<number>("(await app.plugins.plugins.geode.trash.list()).length"),
        {
          timeout: 30_000,
        },
      )
      .toBe(1);
    // Retention 0 counts trashed_at < now (strict); a file trashed in this same
    // second would read as not yet expired. Wait out the second boundary.
    await new Promise((r) => setTimeout(r, 1500));
    await o.eval(`app.plugins.plugins.geode.settings.trashRetentionDays = 0; return true;`);

    await openTrashFromMenu(o);
    await expect(modal).toBeVisible({ timeout: 15_000 });
    // Retention 0 in memory: the row shows the warning "expired" line, not "purges in N days".
    await expect(o.win.locator(".geode-trash-modal .geode-trash-expired")).toHaveCount(1);
    await expect(o.win.locator(".geode-trash-modal .geode-trash-purges")).toHaveCount(0);
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await modal.screenshot({ path: shotPath("461-05-expired.png") });

    await o.win.locator('[data-testid="geode-trash-purge-expired"]').click();
    const confirm = o.win.locator(".geode-confirm-modal");
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    const expiredSpec = await confirmText(o);
    expect(expiredSpec.title).toBe("Purge expired files?");
    expect(expiredSpec.msg).toBe(
      "Permanently deletes 1 file past the retention period and the versions kept for it.",
    );
    expect(expiredSpec.yes).toBe("Purge 1 file");
    await o.win.locator('[data-testid="geode-confirm-cancel"]').click();
    await expect(confirm).not.toBeVisible({ timeout: 10_000 });
    await expect(o.win.locator('[data-testid="geode-trash-restore"]')).toHaveCount(1);

    await o.win.locator('[data-testid="geode-trash-purge-expired"]').click();
    await o.win.locator('[data-testid="geode-confirm-yes"]').click();
    await expect(o.win.locator('[data-testid="geode-trash-empty"]')).toBeVisible({
      timeout: 30_000,
    });
    await closeModal(o);
    await expect(modal).not.toBeVisible({ timeout: 10_000 });

    /* ---- Error + Retry: stop the server, open, then restart + Retry ---- */
    await server.shutdown();
    await openTrashFromMenu(o);
    await expect(o.win.locator('[data-testid="geode-trash-error"]')).toBeVisible({
      timeout: 20_000,
    });
    await expect(o.win.locator('[data-testid="geode-trash-error"]')).toHaveText(
      "Couldn't load the trash. The server didn't answer.",
    );
    await expect(o.win.locator('[data-testid="geode-trash-retry"]')).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-trash-restore-all"]')).toBeDisabled();
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await modal.screenshot({ path: shotPath("461-06-error.png") });

    await server.restart();
    await o.win.locator('[data-testid="geode-trash-retry"]').click();
    await expect(o.win.locator('[data-testid="geode-trash-empty"]')).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("trash modal: retention below the server floor shows the server's 30 days (#532)", async () => {
  test.slow();

  const server = await startServer(); // default 30-day floor
  const device = await server.mintToken("floor");

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

    await upsertVaultFile(o, "notes/floored.md", "floored content");
    await commitPath(o, "notes/floored.md", "commit");
    await deleteFile(o, "notes/floored.md");
    await commitPath(o, "notes/floored.md", "delete");
    await expect
      .poll(
        async () => await o.eval<number>("(await app.plugins.plugins.geode.trash.list()).length"),
        {
          timeout: 30_000,
        },
      )
      .toBe(1);

    // The user's "keep deleted files" setting is below the server floor.
    await o.eval(`app.plugins.plugins.geode.settings.trashRetentionDays = 7; return true;`);

    await openTrashFromMenu(o);
    const modal = o.win.locator(".geode-trash-modal");
    await expect(modal).toBeVisible({ timeout: 15_000 });
    // The row and toolbar must show the server's real 30-day cutoff, not 7.
    await expect(o.win.locator(".geode-trash-modal .geode-trash-purges")).toHaveText(
      "purges in 30 days",
      { timeout: 15_000 },
    );
    await expect(o.win.locator(".geode-trash-modal .geode-trash-retention")).toHaveText(
      "Kept 30 days",
    );
    await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await modal.screenshot({ path: shotPath("461-07-floor.png") });

    // And "Purge expired" must not destroy the fresh entry: the server floor
    // protects it, so the row survives a confirmed purge.
    await o.win.locator('[data-testid="geode-trash-purge-expired"]').click();
    const confirm = o.win.locator(".geode-confirm-modal");
    await expect(confirm).toBeVisible({ timeout: 10_000 });
    await o.win.locator('[data-testid="geode-confirm-yes"]').click();
    await expect(o.win.locator('[data-testid="geode-trash-restore"]')).toHaveCount(1, {
      timeout: 30_000,
    });

    expect(o.consoleErrors()).toEqual([]);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

async function closeModal(o: { eval: <T>(jsExpr: string) => Promise<T> }): Promise<void> {
  // This Obsidian build renders the modal close control as .modal-header-button.
  await o.eval(`(() => {
    const btn = document.querySelector(".geode-trash-modal .modal-header-button");
    if (btn) btn.click();
    return true;
  })()`);
}
