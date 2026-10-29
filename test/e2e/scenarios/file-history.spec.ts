import { expect, test } from "@playwright/test";
import { launchPair, type ObsidianPair } from "../fixtures/pair";
import {
  commitPath,
  revealFileInExplorer,
  upsertVaultFile,
  waitForUnlocked,
} from "../helpers/geode";
import { waitForContent, waitForConvergence, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #464: the file history modal, driven through all three entry points on a
// throwaway server: six editing periods (one per device switch, so "Show older"
// has a second page), an image with two versions, a PDF, a deleted note (whose
// head is a tombstone), and a note with a single version (the empty state).
// Asserts the period rows and save times, the rendered preview, the Changes diff
// against the newest live version, the image/PDF branches with no diff toggle,
// the deletion line, the empty copy, and that a lock closes the modal.
const PASSPHRASE = "file-history-pass";
const NOTE = "Notes/Meeting notes.md";
const IMAGE = "Attachments/vault-map.png";
const PDF = "Attachments/scan.pdf";
const IDEA = "Notes/Ideas.md";
const RETIRED = "Notes/Retired.md";
const CYCLED = "Notes/Cycled.md";
const MANY = "Notes/Many.md";
const FOLDED = "Notes/Folded.md";

const MODAL = ".geode-history-modal";
const period = (o: ObsidianPair["A"], n: number) =>
  o.win.locator(`${MODAL} [data-testid="geode-history-period"]`).nth(n);

/** Open a file, then run the real command through Obsidian's command registry. */
async function openHistoryViaCommand(o: ObsidianPair["A"], path: string): Promise<void> {
  await o.eval(`
    const file = app.vault.getFileByPath(${JSON.stringify(path)});
    if (!file) throw new Error("expected " + ${JSON.stringify(path)} + " in the vault");
    await app.workspace.getLeaf(true).openFile(file);
    app.commands.executeCommandById("geode:geode-show-file-history");
    return true;
  `);
  await expect(o.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
}

async function closeHistory(o: ObsidianPair["A"]): Promise<void> {
  await o.win.locator('[data-testid="geode-history-done"]').click();
  await expect(o.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });
}

/** Notices from a restore fade over the modal: clear them so the shot shows it alone. */
async function clearNotices(o: ObsidianPair["A"]): Promise<void> {
  await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
}

/** A deleted file's own entry point: its Sync activity row. */
async function openHistoryFromActivity(o: ObsidianPair["A"], path: string): Promise<void> {
  await o.win.locator('[data-testid="geode-statusbar"]').click();
  await o.win.locator(".menu").last().locator(".menu-item", { hasText: "Sync activity" }).click();
  await expect(o.win.locator(".geode-activity-modal")).toBeVisible({ timeout: 10_000 });
  await o.win
    .locator(`.geode-activity-modal [data-testid="geode-activity-row"][data-path="${path}"]`)
    .click();
  await expect(o.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
}

/** Delete the vault file, then commit the deletion, so it lands in the trash. */
async function deleteVaultFile(o: ObsidianPair["A"], path: string): Promise<void> {
  await o.eval(`
    const file = app.vault.getFileByPath(${JSON.stringify(path)});
    if (!file) throw new Error("expected " + ${JSON.stringify(path)});
    await app.vault.delete(file);
    return true;
  `);
  await commitPath(o, path, "delete");
}

/** The trash row's Restore: the server appends the restored head version (#687). */
async function restoreFromTrash(o: ObsidianPair["A"]): Promise<void> {
  await o.eval(`app.commands.executeCommandById("geode:geode-open-trash"); return true;`);
  const row = o.win.locator('.geode-trash-modal [data-testid="geode-trash-restore"]');
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await row.click();
  await o.win.keyboard.press("Escape");
  await expect(o.win.locator(".geode-trash-modal")).toHaveCount(0, { timeout: 10_000 });
}

/** A visible PNG (a canvas toBlob in the renderer), so the preview is a real image. */
async function writePng(o: ObsidianPair["A"], path: string, colour: string): Promise<void> {
  await o.eval(`
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 240;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = ${JSON.stringify(colour)};
    ctx.fillRect(0, 0, 480, 240);
    ctx.fillStyle = "#ffffff";
    ctx.font = "28px sans-serif";
    ctx.fillText("vault map", 170, 130);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const bytes = await blob.arrayBuffer();
    const folder = ${JSON.stringify(path)}.split("/").slice(0, -1).join("/");
    if (folder && !(await app.vault.adapter.exists(folder))) await app.vault.createFolder(folder);
    const existing = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
    if (existing) await app.vault.modifyBinary(existing, bytes);
    else await app.vault.createBinary(${JSON.stringify(path)}, bytes);
    return true;
  `);
}

/** One commit per device, back and forth: every switch splits an editing period. */
async function alternateSaves(pair: ObsidianPair, rounds: number): Promise<void> {
  for (let i = 1; i <= rounds; i++) {
    for (const o of [pair.A, pair.B]) {
      const who = o === pair.A ? "device-A" : "device-B";
      await upsertVaultFile(o, NOTE, `# Meeting notes\n\n${who} save ${i}\n`);
      await commitPath(o, NOTE);
      await waitForConvergence(pair.A, pair.B, NOTE, 60_000);
    }
  }
}

test("file history: periods, preview, Changes diff, image, empty state", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);
    await pair.A.eval(`
      app.plugins.plugins.geode.settings.deviceName = "device-A";
      await app.plugins.plugins.geode.saveSettings();
      return true;
    `);
    await pair.B.eval(`
      app.plugins.plugins.geode.settings.deviceName = "device-B";
      await app.plugins.plugins.geode.saveSettings();
      return true;
    `);

    /* ---- Six versions across six device switches: six periods, two pages ---- */
    await upsertVaultFile(pair.A, NOTE, "# Meeting notes\n\nfirst draft\n");
    await commitPath(pair.A, NOTE);
    await waitForConvergence(pair.A, pair.B, NOTE, 60_000);
    await alternateSaves(pair, 3);

    /* ---- An image with two versions, and a note with only its first ---- */
    await writePng(pair.A, IMAGE, "#6f5bd6");
    await commitPath(pair.A, IMAGE);
    await writePng(pair.A, IMAGE, "#2f8f5b");
    await commitPath(pair.A, IMAGE);
    await upsertVaultFile(pair.A, IDEA, "# Ideas\n\nfirst version\n");
    await commitPath(pair.A, IDEA);
    await waitForConvergence(pair.A, pair.B, NOTE, 60_000);

    /* ---- Entry point 1: the command, on the active file ---- */
    await openHistoryViaCommand(pair.A, NOTE);
    await expect(pair.A.win.locator(`${MODAL} .modal-title`)).toHaveText(
      "History · Meeting notes.md",
    );
    /* The subtitle names the head version's device (B committed last). */
    await expect(pair.A.win.locator(".geode-history-sub")).toHaveText("Notes/ · device-B");
    /* Six periods page four at a time, so only 4 rows and one "Show older". */
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-period"]`)).toHaveCount(
      4,
    );
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-older"]`)).toBeVisible();
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText(
        "device-B save 3",
      );
    await expect(pair.A.win.locator(`${MODAL} .geode-history-meta`)).toHaveText(
      /^\d{2}:\d{2} · device-\w$/,
    );
    await pair.A.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("464-01-history-list.png") });

    /* ---- Show older pages the second half of the chain in ---- */
    await pair.A.win.locator(`${MODAL} [data-testid="geode-history-older"]`).click();
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-period"]`)).toHaveCount(
      6,
    );
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-older"]`)).toHaveCount(0);
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("464-02-show-older.png") });

    /* ---- The oldest period expands into its two save times ---- */
    await expect(period(pair.A, 5)).toContainText("device-A");
    await expect(period(pair.A, 5)).toContainText("2 saves");
    await pair.A.win.locator(`${MODAL} [data-testid="geode-history-chevron"]`).last().click();
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("464-03-expanded-period.png") });

    /* ---- Selecting its oldest save previews that version ---- */
    await pair.A.win.locator(`${MODAL} [data-testid="geode-history-save"][data-version="1"]`)
      .click();
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText(
        "first draft",
      );
    await expect(pair.A.win.locator(`${MODAL} .geode-history-meta`)).toContainText("device-A");

    /* ---- Changes diffs that version against the current one ---- */
    await pair.A.win.locator('[data-testid="geode-history-diff-toggle"]').click();
    const diff = pair.A.win.locator('[data-testid="geode-history-diff"]');
    await expect(diff).toBeVisible();
    await expect(diff.locator('[data-kind="remove"]').first()).toContainText("first draft");
    await expect(diff.locator('[data-kind="add"]').first()).toContainText("device-B save 3");
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("464-04-changes-diff.png") });

    /* ---- Show version goes back to the rendered note ---- */
    await pair.A.win.locator('[data-testid="geode-history-diff-toggle"]').click();
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toBeVisible();
    await closeHistory(pair.A);

    /* ---- Entry point 2: the file menu on an image ---- */
    await revealFileInExplorer(pair.A, IMAGE);
    await pair.A.win
      .locator(`.nav-file-title[data-path="${IMAGE}"]`)
      .click({ button: "right" });
    await pair.A.win
      .locator(".menu .menu-item", { hasText: "Geode: Show file history" })
      .click();
    await expect(pair.A.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
    await expect(pair.A.win.locator(`${MODAL} .modal-title`)).toHaveText(
      "History · vault-map.png",
    );
    const image = pair.A.win.locator('[data-testid="geode-history-image"] img');
    await expect(image).toBeVisible({ timeout: 10_000 });
    expect((await image.getAttribute("src")) ?? "").toMatch(/^blob:/);
    /* Binaries offer no diff: the toolbar is empty for an image version. */
    await expect(pair.A.win.locator('[data-testid="geode-history-diff-toggle"]')).toHaveCount(0);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("464-05-image-version.png") });
    await closeHistory(pair.A);

    /* ---- A PDF version shows a type and size line, and offers no diff either ---- */
    for (const body of ["first scan", "second scan, rescanned"]) {
      await pair.A.eval(`
        const existing = app.vault.getAbstractFileByPath(${JSON.stringify(PDF)});
        const bytes = new TextEncoder().encode(${JSON.stringify(body)}).buffer;
        if (existing) await app.vault.modifyBinary(existing, bytes);
        else await app.vault.createBinary(${JSON.stringify(PDF)}, bytes);
        return true;
      `);
      await commitPath(pair.A, PDF);
    }
    await openHistoryViaCommand(pair.A, PDF);
    const binary = pair.A.win.locator('[data-testid="geode-history-binary"]');
    await expect(binary).toContainText("PDF ·");
    await expect(binary).toContainText("preview not available");
    await expect(pair.A.win.locator('[data-testid="geode-history-diff-toggle"]')).toHaveCount(0);
    await closeHistory(pair.A);

    /* ---- A deleted file opens from its activity row on the newest live version ---- */
    for (const body of ["retired draft", "retired final"]) {
      await upsertVaultFile(pair.A, RETIRED, `# Retired\n\n${body}\n`);
      await commitPath(pair.A, RETIRED);
    }
    await pair.A.eval(`
      const file = app.vault.getFileByPath(${JSON.stringify(RETIRED)});
      if (!file) throw new Error("expected " + ${JSON.stringify(RETIRED)});
      await app.vault.delete(file);
      return true;
    `);
    await commitPath(pair.A, RETIRED, "delete");
    await pair.A.win.locator('[data-testid="geode-statusbar"]').click();
    await pair.A.win.locator(".menu").last().locator(".menu-item", { hasText: "Sync activity" })
      .click();
    await expect(pair.A.win.locator(".geode-activity-modal")).toBeVisible({ timeout: 10_000 });
    await pair.A.win
      .locator(`.geode-activity-modal [data-testid="geode-activity-row"][data-path="${RETIRED}"]`)
      .click();
    await expect(pair.A.win.locator(`${MODAL} .modal-title`)).toHaveText("History · Retired.md");
    /* The tombstone head has no content: the modal opens on the last live save, and
       the deletion is its own row above the period (#691). */
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("retired final");
    const deletion = pair.A.win.locator(
      `${MODAL} [data-testid="geode-history-event"][data-event="deleted"]`,
    );
    await expect(deletion).toHaveCount(1);
    await expect(deletion).toContainText("· Deleted on device-A");
    /* A deletion has no content: no chevron, and a tap only shows the text its line cut
       off (#691). */
    await expect(deletion.locator('[data-testid="geode-history-event-chevron"]')).toHaveCount(0);
    await deletion.click();
    await expect(deletion).toHaveClass(/is-expanded/);
    await expect(deletion.locator(".geode-history-event-label")).toHaveCSS("white-space", "normal");
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("retired final");
    await clearNotices(pair.A);
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({
      path: shotPath("691-07-deletion-row-expanded.png"),
    });
    await deletion.click();
    await expect(deletion).not.toHaveClass(/is-expanded/);
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win
      .locator(MODAL)
      .screenshot({ path: shotPath("464-07-deletion-row-above-live-save.png") });

    /* ---- A lock closes the modal: history cannot decrypt without keys ---- */
    await pair.A.eval(`app.commands.executeCommandById("geode:geode-lock"); return true;`);
    await expect(pair.A.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });
    await pair.A.win.keyboard.press("Escape");
    await expect(pair.A.win.locator(".geode-activity-modal")).toHaveCount(0, { timeout: 10_000 });
    await pair.A.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(pair.A);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);

    /* ---- Entry point 3: the Sync activity row. A note with one version has no
       history, and the modal must not fetch a preview for it. ---- */
    await pair.A.eval(`
      const transport = app.plugins.plugins.geode.transport;
      window.__geodeBlobCalls = 0;
      const realGetBlob = transport.getBlob.bind(transport);
      transport.getBlob = (hash) => {
        window.__geodeBlobCalls += 1;
        return realGetBlob(hash);
      };
      return true;
    `);
    await pair.A.win.locator('[data-testid="geode-statusbar"]').click();
    await pair.A.win.locator(".menu").last().locator(".menu-item", { hasText: "Sync activity" })
      .click();
    await expect(pair.A.win.locator(".geode-activity-modal")).toBeVisible({ timeout: 10_000 });
    await pair.A.win
      .locator(`.geode-activity-modal [data-testid="geode-activity-row"][data-path="${IDEA}"]`)
      .click();
    await expect(pair.A.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
    await expect(pair.A.win.locator(`${MODAL} .modal-title`)).toHaveText("History · Ideas.md");
    const empty = pair.A.win.locator('[data-testid="geode-history-empty"]');
    await expect(empty).toContainText("No earlier versions yet.");
    await expect(empty).toContainText("Saved versions appear here as you edit.");
    expect(await pair.A.eval<number>(`window.__geodeBlobCalls`)).toBe(0);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("464-06-empty.png") });
    await closeHistory(pair.A);
  } finally {
    await pair.stop();
  }
});

/** Waits for the compaction pass (armed off the commit path) to fold the chain. */
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("file history: Show older pages the chain and survives a failed page", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await waitForUnlocked(pair.A);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);

    /* ---- 105 saves: the newest server page is full, so Show older must fetch ---- */
    for (let i = 1; i <= 105; i++) {
      await upsertVaultFile(pair.A, MANY, `# Many\n\nsave ${i}\n`);
      await commitPath(pair.A, MANY);
    }

    /* One transport shim drives both failure phases: "all" fails the first page,
       "older" only a Show older fetch. */
    await pair.A.eval(`
      const transport = app.plugins.plugins.geode.transport;
      window.__geodeFailPage = "all";
      const realGetChain = transport.getVersionChain.bind(transport);
      transport.getVersionChain = (pathHash, upTo) => {
        const mode = window.__geodeFailPage;
        const fail = mode === "all" || (mode === "older" && upTo !== undefined);
        return fail
          ? Promise.reject(new Error("E2E injected page failure"))
          : realGetChain(pathHash, upTo);
      };
      return true;
    `);

    /* ---- A failed first page is an inline error with a working retry ---- */
    await openHistoryViaCommand(pair.A, MANY);
    await expect(pair.A.win.locator(`${MODAL} .geode-history-body > .geode-history-note`))
      .toContainText("Couldn't load this history.");
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("464-10-initial-load-error.png") });
    await pair.A.eval(`window.__geodeFailPage = null; return true;`);
    await pair.A.win.locator('[data-testid="geode-history-retry"]').click();

    const periods = pair.A.win.locator(`${MODAL} [data-testid="geode-history-period"]`);
    await expect(periods).toHaveCount(1);
    await expect(periods.first()).toContainText("100 saves");

    /* ---- Selecting a save re-renders without moving the list ---- */
    await pair.A.win.locator(`${MODAL} [data-testid="geode-history-chevron"]`).first().click();
    const list = pair.A.win.locator(`${MODAL} .geode-history-list`);
    const scrolled = await list.evaluate((el) => {
      el.scrollTop = 300;
      return el.scrollTop;
    });
    expect(scrolled).toBe(300);
    /* Version 30 sits inside the scrolled viewport, so the click itself cannot
       scroll the list; the modal's re-render must keep the position. */
    await pair.A.win.locator(`${MODAL} [data-testid="geode-history-save"][data-version="30"]`)
      .click();
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("save 30");
    expect(await list.evaluate((el) => el.scrollTop)).toBe(scrolled);

    /* ---- A failed older page keeps the list and the preview, and retries ---- */
    await pair.A.eval(`window.__geodeFailPage = "older"; return true;`);
    await pair.A.win.locator('[data-testid="geode-history-older"]').click();
    await expect(pair.A.win.locator(`${MODAL} .geode-history-list .geode-history-note`))
      .toContainText("Couldn't load older versions.");
    await expect(periods).toHaveCount(1);
    await expect(pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("save 30");
    /* The failed page reports where Show older sits: at the end of the list. */
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("464-08-older-page-error.png") });

    await pair.A.eval(`window.__geodeFailPage = null; return true;`);
    await pair.A.win.locator('[data-testid="geode-history-older-retry"]').click();
    await expect(pair.A.win.locator('[data-testid="geode-history-older"]')).toHaveCount(0);
    await expect(pair.A.win.locator(`${MODAL} .geode-history-list .geode-history-note`))
      .toHaveCount(0);
    await expect(periods.first()).toContainText("105 saves");
    await closeHistory(pair.A);
  } finally {
    await pair.stop();
  }
});

test("file history: a compacted chain ends in the older-versions gap", async () => {
  test.slow();

  /* GEODE_COMPACT_FLOOR_DAYS=0 folds every pre-now version, so the chain really
     carries a compacted_range and the retention gap row renders. */
  const pair = await launchPair({
    passphrase: PASSPHRASE,
    serverEnv: { GEODE_COMPACT_FLOOR_DAYS: "0", GEODE_COMPACT_THROTTLE_MS: "0" },
  });

  try {
    await waitForUnlocked(pair.A);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    for (let v = 1; v <= 5; v++) {
      await upsertVaultFile(pair.A, FOLDED, `# Folded\n\nv${v}\n`);
      await commitPath(pair.A, FOLDED);
      if (v < 5) await settle(2500);
    }
    await settle(2500);

    await openHistoryViaCommand(pair.A, FOLDED);
    const gap = pair.A.win.locator(`${MODAL} .geode-history-list .geode-history-note.is-faint`);
    await expect(gap).toHaveText("Older versions were merged after 30 days", { timeout: 30_000 });
    /* Every surviving period is on screen, so there is nothing left to page in. */
    await expect(pair.A.win.locator('[data-testid="geode-history-older"]')).toHaveCount(0);
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("464-09-compacted-gap.png") });
    await closeHistory(pair.A);
  } finally {
    await pair.stop();
  }
});

// #691: a deletion and a restore from the trash are rows of their own: each one splits
// the editing periods, reads without expanding, and only the restore row previews.
test("file history: a deletion and a restore are their own rows", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await pair.A.eval(`
      app.plugins.plugins.geode.settings.deviceName = "device-A";
      await app.plugins.plugins.geode.saveSettings();
      return true;
    `);

    const events = () => pair.A.win.locator(`${MODAL} [data-testid="geode-history-event"]`);
    const periods = () => pair.A.win.locator(`${MODAL} [data-testid="geode-history-period"]`);
    const preview = () => pair.A.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`);

    /* ---- Create, then edit: one period of two saves and no event rows (#691) ---- */
    await upsertVaultFile(pair.A, CYCLED, "# Cycled\n\nfirst draft\n");
    await commitPath(pair.A, CYCLED);
    await upsertVaultFile(pair.A, CYCLED, "# Cycled\n\nsecond draft\n");
    await commitPath(pair.A, CYCLED);
    await waitForConvergence(pair.A, pair.B, CYCLED, 60_000);
    await openHistoryViaCommand(pair.A, CYCLED);
    await expect(periods()).toHaveCount(1);
    await expect(periods().first()).toContainText("2 saves");
    await expect(events()).toHaveCount(0);
    await clearNotices(pair.A);
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("691-01-created-and-edited.png") });
    await closeHistory(pair.A);

    /* ---- The deletion is its own row above the period, and takes no click ---- */
    await deleteVaultFile(pair.A, CYCLED);
    await openHistoryFromActivity(pair.A, CYCLED);
    await expect(events()).toHaveCount(1);
    await expect(events().first()).toHaveAttribute("data-event", "deleted");
    await expect(events().first()).toContainText("Deleted on device-A");
    /* Only the row that opens a preview carries the chevron (#691). */
    await expect(events().first().locator('[data-testid="geode-history-event-chevron"]'))
      .toHaveCount(0);
    await expect(periods()).toHaveCount(1);
    await clearNotices(pair.A);
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("691-02-after-delete.png") });
    await closeHistory(pair.A);
    await pair.A.win.keyboard.press("Escape");
    await expect(pair.A.win.locator(".geode-activity-modal")).toHaveCount(0, { timeout: 10_000 });

    /* ---- A restore from the trash is a row of its own, above the deletion ---- */
    await restoreFromTrash(pair.A);
    await waitForContent(pair.A, pair.B, CYCLED, "# Cycled\n\nsecond draft\n", 60_000);
    await openHistoryViaCommand(pair.A, CYCLED);
    await expect(events()).toHaveCount(2);
    await expect(events().nth(0)).toHaveAttribute("data-event", "restored");
    await expect(events().nth(0)).toContainText("Restored from trash on device-A");
    await expect(events().nth(0).locator('[data-testid="geode-history-event-chevron"]'))
      .toHaveCount(1);
    await expect(events().nth(1)).toHaveAttribute("data-event", "deleted");
    await expect(events().nth(1).locator('[data-testid="geode-history-event-chevron"]'))
      .toHaveCount(0);
    await clearNotices(pair.A);
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("691-03-after-restore.png") });
    await closeHistory(pair.A);

    /* ---- Delete and restore again: four rows, newest first ---- */
    await deleteVaultFile(pair.A, CYCLED);
    await openHistoryFromActivity(pair.A, CYCLED);
    await expect(events()).toHaveCount(3);
    await expect(events().nth(0)).toHaveAttribute("data-event", "deleted");
    await expect(events().nth(1)).toHaveAttribute("data-event", "restored");
    await expect(events().nth(2)).toHaveAttribute("data-event", "deleted");
    await clearNotices(pair.A);
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({
      path: shotPath("691-04-after-second-delete.png"),
    });
    await closeHistory(pair.A);
    await pair.A.win.keyboard.press("Escape");
    await expect(pair.A.win.locator(".geode-activity-modal")).toHaveCount(0, { timeout: 10_000 });

    await restoreFromTrash(pair.A);
    await waitForContent(pair.A, pair.B, CYCLED, "# Cycled\n\nsecond draft\n", 60_000);
    await openHistoryViaCommand(pair.A, CYCLED);
    await expect(events()).toHaveCount(4);
    for (const [n, mark] of ["restored", "deleted", "restored", "deleted"].entries()) {
      await expect(events().nth(n)).toHaveAttribute("data-event", mark);
    }
    await expect(periods()).toHaveCount(1);
    await expect(periods().first()).toContainText("2 saves");
    /* A row that is not the selected one is a single line, cut with an ellipsis (#691). */
    await expect(events().nth(1).locator(".geode-history-event-label"))
      .toHaveCSS("white-space", "nowrap");
    await clearNotices(pair.A);
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({ path: shotPath("691-05-four-event-rows.png") });

    /* ---- A restore row previews the content it brought back ---- */
    await pair.A.win.locator(`${MODAL} [data-testid="geode-history-chevron"]`).click();
    await pair.A.win.locator(`${MODAL} [data-testid="geode-history-save"][data-version="1"]`)
      .click();
    await expect(preview()).toContainText("first draft");
    await events().first().click();
    await expect(events().first()).toHaveClass(/is-active/);
    await expect(preview()).toContainText("second draft");
    /* #691: the caption names the restore, not just its clock time, and the selected
       row stops cutting its own line. */
    await expect(pair.A.win.locator(`${MODAL} .geode-history-meta`)).toHaveText(
      /^Restored from trash on device-A · \d{2}:\d{2}$/,
    );
    await expect(events().first().locator(".geode-history-event-label"))
      .toHaveCSS("white-space", "normal");
    await clearNotices(pair.A);
    await pair.A.win.mouse.move(5, 5);
    await pair.A.win.locator(MODAL).screenshot({
      path: shotPath("691-06-restore-row-selected.png"),
    });
    await closeHistory(pair.A);
  } finally {
    await pair.stop();
  }
});
