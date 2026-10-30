import { expect, test } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEMO_PASSPHRASE,
  DEMO_VAULT_DIR,
  DEMO_VAULT_NAME,
  launchDemo,
  readDemoNotes,
} from "../fixtures/demo-vault";
import { launchUnconfigured } from "../fixtures/fresh";
import { TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { focusSetupWizard, waitForPluginLoaded } from "../helpers/geode";
import { restartHeld } from "../helpers/mass-delete-seed";
import { startServer } from "../fixtures/server";
import { fixWindow, shoot, useDarkTheme } from "../helpers/docs-shots";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";

// #8: the committed images the README's Features section and `docs/screenshots` show. Real
// Obsidian on the demo vault of invented notes (`fixtures/demo-vault`), driven through the real
// UI. Run with `deno task docs:screenshots`, which reshoots them all and stamps the plugin
// version into `docs/screenshots/README.md`. The `docs` Playwright project only: never a normal
// default/phone/hybrid run.

const SETTINGS = ".modal.mod-settings";
const CONFLICT_NOTE = "2 - Projects/Balcony garden.md";
const CONFLICT_FILE =
  /(\(conflict .+? \d{4}-\d{2}-\d{2} \d{4,6}\)|\.conflict-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.\w+$/;
const NOTE = "5 - Notes/Sourdough schedule.md";
const NOTE_EDIT_1 = `---
tags: [To-process]
Topics: ["[[Seasonal cooking]]"]
Created: 2026-08-30
Updated: 2026-10-04
Projects: []
Areas: ["[[Health]]"]
---
# Notes
Friday evening: feed the starter. Saturday morning: mix, three folds, shape at six, bake at seven.

The loaf is better when the kitchen is cold, so the winter schedule is easier than the summer one.
This winter I moved the first fold later and the crumb opened up.

# Related
- [[Health]]
- [[Seasonal cooking]]
`;
const NOTE_EDIT_2 = NOTE_EDIT_1.replace(
  "This winter I moved the first fold later and the crumb opened up.",
  `This winter I moved the first fold later, and the crumb opened up.

Bake at 240 for twenty minutes with the lid on, then 220 with the lid off. The lid is the whole
trick.`,
);

async function openSettings(o: { eval: <T>(s: string) => Promise<T> }): Promise<void> {
  await o.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    app.setting.open();
    app.setting.openTabById("geode");
    return true;
  `);
}

async function closeTop(o: { win: import("@playwright/test").Page }): Promise<void> {
  await o.win.keyboard.press("Escape");
  await expect(o.win.locator(".modal-container")).toHaveCount(1, { timeout: 10_000 });
}

test("demo vault: settings, sync scope, devices, passphrase, history, activity, trash", async () => {
  test.setTimeout(12 * 60_000);
  const server = await startServer({ vaultName: DEMO_VAULT_NAME });
  const laptop = await server.mintToken("Laptop");
  // The vault's second device, so the Devices view and the activity rows name two real devices.
  await server.mintToken("Phone");
  await server.registerAuthHash(laptop.token, DEMO_PASSPHRASE, TEST_ARGON2_PARAMS);
  const o = await launchDemo(server, laptop);

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 180_000);
    await fixWindow(o.win);
    await useDarkTheme(o);

    /* ---- Settings tab (a taller window, so the sections below Status fit) ---- */
    await fixWindow(o.win, 1280, 1100);
    await openSettings(o);
    await expect(o.win.locator('[data-testid="geode-settings-sync-status"]')).toBeVisible();
    await expect(o.win.locator('[data-testid="geode-settings-sync-status"]')).toContainText(
      "Up to date.",
      { timeout: 60_000 },
    );
    await shoot(o, SETTINGS, "settings");
    await fixWindow(o.win);

    /* ---- Selective sync: folders, one folder switched off ---- */
    await o.win.locator('[data-testid="geode-settings-folders-manage"]').click();
    await expect(o.win.locator(".geode-folders-modal")).toBeVisible({ timeout: 15_000 });
    await expect(o.win.locator('[data-testid="geode-folder-row"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await o.win.locator('[data-testid="geode-folder-toggle"][data-path="99 - System"]').click();
    await expect(o.win.locator('[data-testid="geode-folder-toggle"][data-path="99 - System"]'))
      .not.toHaveClass(/is-enabled/);
    await shoot(o, ".geode-folders-modal", "sync-folders");
    await closeTop(o);

    /* ---- Devices ---- */
    await o.win.locator('[data-testid="geode-settings-devices-manage"]').click();
    await expect(o.win.locator('[data-testid="geode-device-row"]').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(o.win.locator('[data-testid="geode-device-row"]')).toHaveCount(2);
    // Wait for the applied position to land, so the row reads "Up to date" and not a transient
    // "N changes behind".
    await expect(
      o.win.locator('[data-testid="geode-device-row"]', { hasText: "Laptop" })
        .locator(".geode-device-desc"),
    ).toContainText("Up to date", { timeout: 60_000 });
    await shoot(o, ".geode-devices-modal", "devices");
    await closeTop(o);

    /* ---- Change passphrase ---- */
    await o.win.locator('[data-testid="geode-settings-passphrase-change"]').click();
    await expect(o.win.locator('[data-testid="geode-rekey-continue"]')).toBeVisible({
      timeout: 15_000,
    });
    await o.win.mouse.move(5, 5);
    await shoot(o, '[data-testid="geode-rekey-modal"]', "change-passphrase");
    await closeTop(o);
    await o.eval(`app.setting?.close?.(); return true;`);

    /* ---- History: three versions of one note, one of them diffed ---- */
    await upsertVaultFile(o, NOTE, NOTE_EDIT_1);
    await commitPath(o, NOTE);
    await upsertVaultFile(o, NOTE, NOTE_EDIT_2);
    await commitPath(o, NOTE);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    await o.eval(`
      const file = app.vault.getFileByPath(${JSON.stringify(NOTE)});
      if (!file) throw new Error("expected the demo note to exist");
      await app.workspace.getLeaf(true).openFile(file);
      app.commands.executeCommandById("geode:geode-show-file-history");
      return true;
    `);
    await expect(o.win.locator(".geode-history-modal")).toBeVisible({ timeout: 15_000 });
    await expect(o.win.locator('[data-testid="geode-history-period"]').first()).toBeVisible();
    const saves = o.win.locator('[data-testid="geode-history-save"]');
    if ((await saves.count()) === 0) {
      await o.win.locator('[data-testid="geode-history-chevron"]').last().click();
    }
    // The middle save, diffed against the current version: the second edit reworded a line and
    // added a paragraph, so the diff shows a removal and additions.
    await o.win.locator('[data-testid="geode-history-save"][data-version="2"]').click();
    await o.win.locator('[data-testid="geode-history-diff-toggle"]').click();
    const diff = o.win.locator('[data-testid="geode-history-diff"]');
    await expect(diff).toBeVisible({ timeout: 15_000 });
    await expect(diff.locator('[data-kind="remove"]')).toContainText(
      "first fold later and the crumb",
    );
    await expect(diff.locator('[data-kind="add"]').filter({ hasText: "Bake at 240" })).toHaveCount(
      1,
    );
    // The save the image shows is a Laptop one; a reshoot that lands elsewhere fails here.
    await expect(o.win.locator(".geode-history-meta")).toContainText("Laptop");
    await o.win.mouse.move(5, 5);
    await shoot(o, ".geode-history-modal", "history-restore");
    await o.win.locator('[data-testid="geode-history-done"]').click();

    /* ---- One note jotted, two notes deleted: the feed shows every kind of row ---- */
    const NEW_NOTE = "1 - Inbox/Frost warning.md";
    await upsertVaultFile(
      o,
      NEW_NOTE,
      `---
tags: [To-process]
Topics: []
Created: 2026-10-07
Updated: 2026-10-07
Projects: ["[[Balcony garden]]"]
Areas: ["[[Home]]"]
---
# Notes
Frost on Thursday night. Bring the fig in and cover the trough with the old sheet.

# Related
- [[Balcony garden]]
`,
    );
    await commitPath(o, NEW_NOTE);
    for (const path of ["5 - Notes/Bookshop order.md", "5 - Notes/Train times to the coast.md"]) {
      await o.eval(`
        const file = app.vault.getFileByPath(${JSON.stringify(path)});
        if (!file) throw new Error("expected " + ${JSON.stringify(path)});
        await app.vault.delete(file);
        return true;
      `);
      await commitPath(o, path, "delete");
    }
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    /* ---- Sync activity ---- */
    await o.win.locator('[data-testid="geode-statusbar"]').click();
    await o.win.locator(".menu").last().locator(".menu-item", { hasText: "Sync activity" }).click();
    await expect(o.win.locator(".geode-activity-modal")).toBeVisible({ timeout: 15_000 });
    await expect(o.win.locator('[data-testid="geode-activity-row"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await shoot(o, ".geode-activity-modal", "sync-activity");
    await o.win.keyboard.press("Escape");
    await expect(o.win.locator(".geode-activity-modal")).toHaveCount(0, { timeout: 10_000 });

    /* ---- Deleted files ---- */
    await o.eval(`app.commands.executeCommandById("geode:geode-open-trash"); return true;`);
    await expect(o.win.locator(".geode-trash-modal")).toBeVisible({ timeout: 20_000 });
    await expect(o.win.locator('[data-testid="geode-trash-restore"]').first()).toBeVisible({
      timeout: 20_000,
    });
    await shoot(o, ".geode-trash-modal", "deleted-files");
    await o.win.keyboard.press("Escape");

    /* ---- Selective sync: which Obsidian config follows the vault ---- */
    // Last of the settings images: the demo vault keeps config sync off (notes only), so the
    // master toggle is switched on through the real row first, and that is what adds the Config
    // to sync row. A taller window so the whole list, plugins included, fits in the image.
    await openSettings(o);
    await fixWindow(o.win, 1280, 1000);
    await o.win.locator('[data-testid="geode-settings-toggle-sync-obsidian"]').click();
    // The modal lists installed community plugins; the demo vault ships with Geode alone, so two
    // manifests stand in for the plugins a real vault would have (as config-to-sync-plugins.spec.ts
    // does), and the shot shows both halves of the list.
    await o.eval(`
      const stub = (id, name) => ({
        id, name, version: "1.0.0", minAppVersion: "1.0.0", author: name, description: "",
      });
      app.plugins.manifests["dataview"] = stub("dataview", "Dataview");
      app.plugins.manifests["templater-obsidian"] = stub("templater-obsidian", "Templater");
      return true;
    `);
    await o.win.locator('[data-testid="geode-settings-config-manage"]').click();
    await expect(o.win.locator(".geode-config-modal")).toBeVisible({ timeout: 15_000 });
    await expect(o.win.locator('[data-testid="geode-config-plugin-templater-obsidian"]'))
      .toBeVisible(
        { timeout: 15_000 },
      );
    await o.win.mouse.move(5, 5);
    await shoot(o, ".geode-config-modal", "config-to-sync");
    await closeTop(o);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("demo vault: a real conflict, listed and reviewed side by side", async () => {
  test.setTimeout(10 * 60_000);
  const server = await startServer({ vaultName: DEMO_VAULT_NAME });
  const laptop = await server.mintToken("Laptop");
  const phone = await server.mintToken("Phone");
  await server.registerAuthHash(laptop.token, DEMO_PASSPHRASE, TEST_ARGON2_PARAMS);
  const A = await launchDemo(server, laptop);
  // The demo vault's second device. A desktop window standing in for the phone keeps this spec in
  // the `docs` project: the same conflict either way, and only one window is ever photographed.
  const B = await launchDemo(server, phone, { seed: false, deviceName: "Phone" });

  try {
    for (const o of [A, B]) {
      await fixWindow(o.win);
      await useDarkTheme(o);
      await waitForStatusBar(o.win, "Geode: synced", 180_000);
    }
    const base = await readFile(path.join(DEMO_VAULT_DIR, CONFLICT_NOTE), "utf8");
    await expect.poll(
      () => B.eval<boolean>(`app.vault.adapter.exists(${JSON.stringify(CONFLICT_NOTE)})`),
      { timeout: 120_000 },
    ).toBe(true);

    /* ---- A real conflict: B holds off, A's edit lands, B edits the same line, B resumes ---- */
    await B.eval(`app.plugins.plugins.geode.pauseSync(); return true;`);
    const laptopEdit = base.replace(
      "- [ ] Order the trough and two brackets",
      "- [ ] Order the long trough and two brackets",
    );
    await upsertVaultFile(A, CONFLICT_NOTE, laptopEdit);
    await commitPath(A, CONFLICT_NOTE);
    await expect.poll(
      () =>
        A.eval<number>(
          `app.plugins.plugins.geode.state.getLocalFile(${
            JSON.stringify(CONFLICT_NOTE)
          })?.last_seen_version ?? 0`,
        ),
      { timeout: 60_000 },
    ).toBeGreaterThan(1);
    await upsertVaultFile(
      B,
      CONFLICT_NOTE,
      base.replace(
        "- [ ] Order the trough and two brackets",
        "- [ ] Order the trough, brackets included, before the frost",
      ),
    );
    await B.eval(`app.plugins.plugins.geode.resumeSync(); return true;`);
    await expect.poll(
      () =>
        B.eval<string[]>(
          `app.vault.getFiles().map((f) => f.path).filter((p) => ${CONFLICT_FILE.toString()}.test(p))`,
        ),
      { timeout: 120_000 },
    ).toHaveLength(1);

    /* ---- The Conflicts list, then the review window ---- */
    await B.eval(`app.plugins.plugins.geode.openConflictsModal(); return true;`);
    await expect(B.win.locator(".geode-conflicts-modal")).toBeVisible({ timeout: 15_000 });
    await expect(B.win.locator('[data-testid="geode-conflict-row"]')).toHaveCount(1);
    await shoot(B, ".geode-conflicts-modal", "conflicts-list");
    await B.win.locator('[data-testid="geode-conflict-review"]').click();
    const review = B.win.locator(".geode-conflict-review-modal");
    await expect(review).toBeVisible({ timeout: 15_000 });
    await expect(
      review.locator('[data-testid="geode-conflict-diff-line"][data-kind="original"]'),
    ).toContainText("Order the long trough");
    await expect(
      review.locator('[data-testid="geode-conflict-diff-line"][data-kind="conflict"]'),
    ).toContainText("brackets included");
    await B.win.mouse.move(5, 5);
    await shoot(B, ".geode-conflict-review-modal", "conflict-review");
  } finally {
    await Promise.allSettled([A.close(), B.close(), server.stop()]);
  }
});

test("demo vault: a mass delete held for review", async () => {
  test.setTimeout(15 * 60_000);
  const server = await startServer({ vaultName: DEMO_VAULT_NAME });
  const laptop = await server.mintToken("Laptop");
  await server.mintToken("Phone");
  const notes = await readDemoNotes();
  const held = notes.filter((n) => !n.path.startsWith("99 - System")).map((n) => ({
    path: n.path,
  }));
  // Every note but the templates: more than the guard's 20 files and 25 percent, in one go.
  expect(held.length).toBeGreaterThanOrEqual(20);
  const vaultDir = await mkdtemp(path.join(tmpdir(), "geode-docs-mass-delete-"));

  let o = await launchDemo(server, laptop, { vaultDir, keepVaultDir: true });
  try {
    await waitForUnlocked(o);
    await expect.poll(
      () =>
        o.eval<number>(
          "app.plugins.plugins.geode.syncManager?.state?.getAllLocalFiles().size ?? 0",
        ),
      { timeout: 5 * 60_000 },
    ).toBeGreaterThanOrEqual(held.length);
    await waitForStatusBar(o.win, "Geode: synced", 180_000);

    // Closed app, files deleted behind its back, relaunch: the reconciler trips the guard.
    o = await restartHeld(o, held, held.length, DEMO_PASSPHRASE);
    await fixWindow(o.win);
    await useDarkTheme(o);
    const notice = o.win.locator(".notice").last();
    await expect(notice).toContainText("files missing", { timeout: 120_000 });
    await notice.click();
    await expect(o.win.locator(".geode-missing-modal")).toBeVisible({ timeout: 15_000 });
    await expect(o.win.locator(".geode-missing-modal")).toContainText("Review missing files");
    await shoot(o, ".geode-missing-modal", "mass-delete-review");
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("setup wizard: the create form", async () => {
  test.setTimeout(5 * 60_000);
  const server = await startServer({ vaultName: DEMO_VAULT_NAME });
  const o = await launchUnconfigured(server);
  try {
    await waitForPluginLoaded(o);
    await focusSetupWizard(o);
    await fixWindow(o.win);
    await useDarkTheme(o);
    await o.win.locator('[data-testid="geode-wizard-create"]').click();
    await o.win.locator('[data-testid="geode-create-server"]').fill("geode.example.com");
    await expect(o.win.locator('[data-testid="geode-create-server"]')).toHaveValue(
      "geode.example.com",
    );
    await o.win.mouse.move(5, 5);
    await shoot(o, ".modal-container .modal", "setup-wizard");
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
