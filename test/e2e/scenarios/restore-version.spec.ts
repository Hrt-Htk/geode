import { expect, test } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { launchPair, type ObsidianPair } from "../fixtures/pair";
import { commitPath, disconnectSync, reconnectSync, upsertVaultFile } from "../helpers/geode";
import { waitForContent, waitForConvergence, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #465: Restore this version, driven through the real modal on a throwaway
// server: the confirm copy, Cancel, the append-only commit (a NEW head version at
// the file's current name), the Notice, the peer receiving it, the identical
// content no-op, a binary version, a version from before a rename, and a deleted
// file's version restored from trash History.
const PASSPHRASE = "restore-pass";
const NOTE = "Notes/Restore me.md";
const IMAGE = "Attachments/scan.pdf";
const OLD = "Notes/Old name.md";
const NEW = "Notes/New name.md";
const RETIRED = "Notes/Retired.md";

const MODAL = ".geode-history-modal";
const CONFIRM = ".geode-confirm-modal";
const RESTORE = '[data-testid="geode-history-restore"]';

type VersionRow = { version: number; deleted: number; rename_mark: number };

/** The server's chain for one name: the append-only proof, read from the DB. */
function chain(dataDir: string, vaultId: string, pathHash: string): VersionRow[] {
  const db = new DatabaseSync(path.join(dataDir, "geode.db"), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT version, deleted, rename_mark FROM file_versions WHERE vault_id = ? AND path_hash = ? ORDER BY version",
      )
      .all(vaultId, pathHash) as VersionRow[];
  } finally {
    db.close();
  }
}

function trashCount(dataDir: string, vaultId: string): number {
  const db = new DatabaseSync(path.join(dataDir, "geode.db"), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM trashed_heads WHERE vault_id = ?")
      .get(vaultId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

async function pathHash(o: ObsidianPair["A"], filePath: string): Promise<string> {
  return await o.eval<string>(
    `app.plugins.plugins.geode.state.getLocalFile(${JSON.stringify(filePath)})?.path_hash ?? ""`,
  );
}

async function openHistory(o: ObsidianPair["A"], filePath: string): Promise<void> {
  await o.eval(`
    const file = app.vault.getFileByPath(${JSON.stringify(filePath)});
    if (!file) throw new Error("expected " + ${JSON.stringify(filePath)} + " in the vault");
    await app.workspace.getLeaf(true).openFile(file);
    app.commands.executeCommandById("geode:geode-show-file-history");
    return true;
  `);
  await expect(o.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
}

/** Expand every loaded period, then pick one save (the last match: older names
 * come later in the list, so a rename's old name wins). */
async function selectVersion(o: ObsidianPair["A"], version: number): Promise<void> {
  const chevrons = o.win.locator(`${MODAL} [data-testid="geode-history-chevron"]`);
  for (let i = 0; i < await chevrons.count(); i++) {
    const cls = await chevrons.nth(i).getAttribute("class");
    if (!cls?.includes("is-open")) await chevrons.nth(i).click();
  }
  await o.win
    .locator(`${MODAL} [data-testid="geode-history-save"][data-version="${version}"]`)
    .last()
    .click();
}

/** The confirm dialog itself: its title lives outside the `.geode-confirm-modal` div. */
function confirmDialog(o: ObsidianPair["A"]) {
  return o.win.locator(".modal", { has: o.win.locator(CONFIRM) });
}

async function clickRestore(o: ObsidianPair["A"]): Promise<void> {
  await o.win.locator(RESTORE).click();
  await expect(confirmDialog(o)).toBeVisible({ timeout: 10_000 });
}

async function confirmRestore(o: ObsidianPair["A"]): Promise<void> {
  await clickRestore(o);
  await o.win.locator('[data-testid="geode-confirm-yes"]').click();
  await expect(confirmDialog(o)).toHaveCount(0, { timeout: 10_000 });
}

/** Two binary versions, written through Obsidian's binary API. */
async function writeBinary(o: ObsidianPair["A"], filePath: string, text: string): Promise<void> {
  await o.eval(`
    const path = ${JSON.stringify(filePath)};
    const bytes = new TextEncoder().encode(${JSON.stringify(text)}).buffer;
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder && !(await app.vault.adapter.exists(folder))) await app.vault.createFolder(folder);
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing) await app.vault.modifyBinary(existing, bytes);
    else await app.vault.createBinary(path, bytes);
    return true;
  `);
}

async function readBinary(o: ObsidianPair["A"], filePath: string): Promise<string> {
  return await o.eval<string>(
    `new TextDecoder().decode(await app.vault.adapter.readBinary(${JSON.stringify(filePath)}))`,
  );
}

/** An earlier notice is still fading out, so match the first one that says it. */
async function expectNotice(o: ObsidianPair["A"], text: string): Promise<void> {
  await expect(
    o.win.locator(".notice", { hasText: text }).first(),
  ).toBeVisible({ timeout: 20_000 });
}

/** Waits until the server holds `mark` on that name's head (a rename's commits are
 * queued by the event layer, so a content commit must not jump ahead of the note). */
async function waitForMark(o: ObsidianPair["A"], filePath: string, mark: number): Promise<void> {
  await expect
    .poll(
      async () =>
        await o.eval<number>(`
          const row = app.plugins.plugins.geode.state.getLocalFile(${JSON.stringify(filePath)});
          if (!row) return -1;
          const chain = await app.plugins.plugins.geode.transport.getVersionChain(row.path_hash);
          return chain[0] ? chain[0].rename_mark : 0;
        `),
      { timeout: 60_000 },
    )
    .toBe(mark);
}

async function read(o: ObsidianPair["A"], filePath: string): Promise<string | null> {
  return await o.eval<string | null>(
    `(await app.vault.adapter.exists(${JSON.stringify(filePath)})) ? await app.vault.adapter.read(${
      JSON.stringify(filePath)
    }) : null`,
  );
}

test("restore: confirm, append a new version, reach the peer, no-op on identical", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    for (const body of ["first draft", "second draft", "third draft"]) {
      await upsertVaultFile(pair.A, NOTE, `# Restore me\n\n${body}\n`);
      await commitPath(pair.A, NOTE);
    }
    await waitForContent(pair.A, pair.B, NOTE, "# Restore me\n\nthird draft\n");
    const hash = await pathHash(pair.A, NOTE);
    expect(chain(pair.server.dataDir, pair.server.vaultId, hash).length).toBe(3);

    /* ---- The confirm: the design's copy, a neutral Restore, Cancel does nothing ---- */
    await openHistory(pair.A, NOTE);
    await selectVersion(pair.A, 1);
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("first draft");
    await clickRestore(pair.A);
    await expect(confirmDialog(pair.A)).toContainText("Restore this version?");
    await expect(confirmDialog(pair.A)).toContainText(
      "The current content stays in history as a version.",
    );
    await expect(pair.A.win.locator('[data-testid="geode-confirm-yes"]')).toHaveText("Restore");
    await expect(pair.A.win.locator('[data-testid="geode-confirm-yes"]')).not.toHaveClass(
      /mod-warning/,
    );
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.screenshot({ path: shotPath("465-01-confirm.png") });
    await pair.A.win.locator('[data-testid="geode-confirm-cancel"]').click();
    await expect(confirmDialog(pair.A)).toHaveCount(0);
    expect(await read(pair.A, NOTE)).toBe("# Restore me\n\nthird draft\n");
    expect(chain(pair.server.dataDir, pair.server.vaultId, hash).length).toBe(3);

    /* ---- Restore: the old content becomes a NEW head version, both sides ---- */
    await confirmRestore(pair.A);
    await expectNotice(pair.A, "Restored and saved as a new version");
    await pair.A.win.screenshot({ path: shotPath("465-02-notice.png") });
    expect(await read(pair.A, NOTE)).toBe("# Restore me\n\nfirst draft\n");
    const rows = chain(pair.server.dataDir, pair.server.vaultId, hash);
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    expect(rows[3]).toEqual({ version: 4, deleted: 0, rename_mark: 0 });
    await waitForContent(pair.A, pair.B, NOTE, "# Restore me\n\nfirst draft\n");

    /* ---- The window reloads onto the restored head as its own save ---- */
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("first draft");
    await selectVersion(pair.A, 4);
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.screenshot({ path: shotPath("465-03-history-after-restore.png") });

    /* ---- Identical content is a no-op with its own notice ---- */
    await pair.A.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await confirmRestore(pair.A);
    await expectNotice(pair.A, "That version is already the current content.");
    await pair.A.win.screenshot({ path: shotPath("465-04-unchanged.png") });
    expect(chain(pair.server.dataDir, pair.server.vaultId, hash).length).toBe(4);
    expect(await read(pair.A, NOTE)).toBe("# Restore me\n\nfirst draft\n");
  } finally {
    await pair.stop();
  }
});

test("restore: a binary version and a version from before a rename", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    /* ---- A binary (no diff, Restore stays available) ---- */
    for (const body of ["first scan", "second scan, rescanned"]) {
      await writeBinary(pair.A, IMAGE, body);
      await commitPath(pair.A, IMAGE);
    }
    await waitForContent(pair.A, pair.B, IMAGE, "second scan, rescanned");
    await openHistory(pair.A, IMAGE);
    await expect(pair.A.win.locator('[data-testid="geode-history-binary"]')).toContainText(
      "preview not available",
    );
    await expect(pair.A.win.locator('[data-testid="geode-history-diff-toggle"]')).toHaveCount(0);
    await expect(pair.A.win.locator(RESTORE)).toBeVisible();
    await selectVersion(pair.A, 1);
    await expect(pair.A.win.locator('[data-testid="geode-history-binary"]')).toBeVisible();
    await confirmRestore(pair.A);
    await expectNotice(pair.A, "Restored and saved as a new version");
    expect(await readBinary(pair.A, IMAGE)).toBe("first scan");
    await waitForContent(pair.A, pair.B, IMAGE, "first scan");
    await pair.A.win.locator('[data-testid="geode-history-done"]').click();
    await expect(pair.A.win.locator(MODAL)).toHaveCount(0);

    /* ---- A version from before a rename lands at the CURRENT name ---- */
    await upsertVaultFile(pair.A, OLD, "# Old name\n\nold content\n");
    await commitPath(pair.A, OLD);
    await pair.A.eval(`
      const file = app.vault.getFileByPath(${JSON.stringify(OLD)});
      if (!file) throw new Error("expected " + ${JSON.stringify(OLD)});
      await app.vault.rename(file, ${JSON.stringify(NEW)});
      return true;
    `);
    /* The event layer writes the rename's marker + note; a content commit must land
       after them, or the new name starts its own chain with no link back. */
    await waitForMark(pair.A, OLD, 1);
    await waitForMark(pair.A, NEW, 2);
    await upsertVaultFile(pair.A, NEW, "# New name\n\nnew content\n");
    await commitPath(pair.A, NEW);
    await waitForContent(pair.A, pair.B, NEW, "# New name\n\nnew content\n");
    expect(await read(pair.A, OLD)).toBeNull();

    await openHistory(pair.A, NEW);
    /* The walk reads one name at a time: Show older brings the old name in under
       its "Renamed from" marker. */
    await pair.A.win.locator(`${MODAL} [data-testid="geode-history-older"]`).click();
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-marker"]`)).toHaveText(
      "Renamed from Notes/Old name.md",
    );
    await selectVersion(pair.A, 1);
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("old content");
    await confirmRestore(pair.A);
    await expectNotice(pair.A, "Restored and saved as a new version");
    expect(await read(pair.A, NEW)).toBe("# Old name\n\nold content\n");
    expect(await read(pair.A, OLD)).toBeNull();
    const head = chain(pair.server.dataDir, pair.server.vaultId, await pathHash(pair.A, NEW)).at(
      -1,
    );
    expect(head).toEqual({ version: expect.any(Number), deleted: 0, rename_mark: 0 });
    await waitForContent(pair.A, pair.B, NEW, "# Old name\n\nold content\n");
  } finally {
    await pair.stop();
  }
});

test("restore: a deleted file's version comes back from trash History", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    for (const body of ["draft", "final"]) {
      await upsertVaultFile(pair.A, RETIRED, `# Retired\n\n${body}\n`);
      await commitPath(pair.A, RETIRED);
    }
    await waitForContent(pair.A, pair.B, RETIRED, "# Retired\n\nfinal\n");
    await pair.A.eval(`
      const file = app.vault.getFileByPath(${JSON.stringify(RETIRED)});
      if (!file) throw new Error("expected " + ${JSON.stringify(RETIRED)});
      await app.vault.delete(file);
      return true;
    `);
    await commitPath(pair.A, RETIRED, "delete");
    await expect(pair.A.win.locator(`${MODAL}`)).toHaveCount(0);
    expect(trashCount(pair.server.dataDir, pair.server.vaultId)).toBe(1);

    /* ---- The activity row's window shows the deletion as its own row (#691): it
       has no content, so it takes no chevron and never selects itself. ---- */
    await pair.A.win.locator('[data-testid="geode-statusbar"]').click();
    await pair.A.win.locator(".menu").last().locator(".menu-item", { hasText: "Sync activity" })
      .click();
    await expect(pair.A.win.locator(".geode-activity-modal")).toBeVisible({ timeout: 10_000 });
    await pair.A.win
      .locator(`.geode-activity-modal [data-testid="geode-activity-row"][data-path="${RETIRED}"]`)
      .click();
    await expect(pair.A.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
    const deletion = pair.A.win.locator(
      `${MODAL} [data-testid="geode-history-event"][data-event="deleted"]`,
    );
    await expect(deletion).toHaveCount(1);
    await expect(deletion).toContainText("Deleted");
    await expect(deletion.locator('[data-testid="geode-history-event-chevron"]')).toHaveCount(0);
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("final");
    await pair.A.win.locator('[data-testid="geode-history-done"]').click();
    await expect(pair.A.win.locator(MODAL)).toHaveCount(0);
    await pair.A.win.keyboard.press("Escape");
    await expect(pair.A.win.locator(".geode-activity-modal")).toHaveCount(0, { timeout: 10_000 });

    /* ---- Trash row → History → the same file, capped at its newest live version ---- */
    await pair.A.eval(`app.commands.executeCommandById("geode:geode-open-trash"); return true;`);
    const trash = pair.A.win.locator(".geode-trash-modal");
    await expect(trash).toBeVisible({ timeout: 10_000 });
    await expect(trash.locator('[data-testid="geode-trash-history"]')).toBeVisible({
      timeout: 15_000,
    });
    await trash.locator('[data-testid="geode-trash-history"]').click();
    await expect(pair.A.win.locator(`${MODAL} .geode-history-capped`)).toHaveText(
      "History of this file, up to the deleted version.",
      { timeout: 10_000 },
    );

    /* ---- Restoring an older version brings the file back at its last name ---- */
    await selectVersion(pair.A, 1);
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("draft");
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.screenshot({ path: shotPath("465-05-trashed-version.png") });
    await confirmRestore(pair.A);
    await expectNotice(pair.A, "Restored and saved as a new version");
    expect(await read(pair.A, RETIRED)).toBe("# Retired\n\ndraft\n");
    expect(trashCount(pair.server.dataDir, pair.server.vaultId)).toBe(0);
    await waitForContent(pair.A, pair.B, RETIRED, "# Retired\n\ndraft\n");
    /* The file is live again, so the trash row's cap is gone and the restored head
       is what the window shows. */
    await expect(pair.A.win.locator(`${MODAL} .geode-history-capped`)).toHaveCount(0);
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("draft");
    await pair.A.win.screenshot({ path: shotPath("465-06-restored-from-trash.png") });

    /* The name left the trash with the file, so the panel is empty again. */
    await pair.A.win.locator('[data-testid="geode-history-done"]').click();
    await expect(pair.A.win.locator(MODAL)).toHaveCount(0);
    await pair.A.win.keyboard.press("Escape");
    await expect(pair.A.win.locator(".geode-trash-modal")).toHaveCount(0, { timeout: 10_000 });
    await pair.A.eval(`app.commands.executeCommandById("geode:geode-open-trash"); return true;`);
    await expect(pair.A.win.locator(".geode-trash-modal")).toBeVisible({ timeout: 10_000 });
    await expect(pair.A.win.locator('[data-testid="geode-trash-empty"]')).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await pair.stop();
  }
});

test("restore: a restore reaches a peer that is offline during the restore", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    for (const body of ["one", "two"]) {
      await upsertVaultFile(pair.A, NOTE, `# Offline\n\n${body}\n`);
      await commitPath(pair.A, NOTE);
    }
    await waitForContent(pair.A, pair.B, NOTE, "# Offline\n\ntwo\n");

    await disconnectSync(pair.B);
    await openHistory(pair.A, NOTE);
    await selectVersion(pair.A, 1);
    await confirmRestore(pair.A);
    await expectNotice(pair.A, "Restored and saved as a new version");
    await pair.A.win.locator('[data-testid="geode-history-done"]').click();

    await reconnectSync(pair.B);
    await waitForContent(pair.A, pair.B, NOTE, "# Offline\n\none\n");
    expect(await waitForConvergence(pair.A, pair.B, NOTE, 60_000)).toBe("# Offline\n\none\n");
  } finally {
    await pair.stop();
  }
});
