import { expect, test } from "@playwright/test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEMO_LAUNCH_ARGS,
  DEMO_PASSPHRASE,
  DEMO_VAULT_DIR,
  demoServer,
  launchDemo,
  readDemoNotes,
} from "../fixtures/demo-vault";
import { launchUnconfigured } from "../fixtures/fresh";
import type { ObsidianInstance } from "../fixtures/obsidian";
import type { E2EServer } from "../fixtures/server";
import { fixWindow, shoot, useDarkTheme } from "../helpers/docs-shots";
import {
  commitPath,
  focusSetupWizard,
  upsertVaultFile,
  waitForPluginLoaded,
  waitForUnlocked,
} from "../helpers/geode";
import { openSettingsTab } from "../helpers/logs";
import { restartHeld } from "../helpers/mass-delete-seed";
import { waitForStatusBar } from "../helpers/waits";

// #8: the desktop half of the docs images; `deno task docs:screenshots` runs it.

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

/** The settings Devices row snapshots the server once when the tab renders, so wait until the
 * Laptop has reported its position before opening it: a never-synced device is not "behind", and
 * a fetch that raced the ack would leave a different number in the image. */
async function settledSettings(o: ObsidianInstance, server: E2EServer, token: string) {
  await expect.poll(async () => {
    const res = await fetch(`${server.url}/vaults/${server.vaultId}/devices/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await res.json() as {
      head_seq: number;
      devices: Array<{ name: string; applied_seq: number | null }>;
    };
    const laptop = body.devices.find((d) => d.name === "Laptop");
    return (laptop?.applied_seq ?? -1) - body.head_seq;
  }, { timeout: 60_000 }).toBeGreaterThanOrEqual(0);
  await openSettingsTab(o);
  await expect(
    o.win.locator('[data-testid="geode-settings-devices-summary"] .setting-item-description'),
  ).toHaveText("2 devices · 0 behind", { timeout: 20_000 });
}

async function closeTop(o: ObsidianInstance): Promise<void> {
  await o.win.keyboard.press("Escape");
  await expect(o.win.locator(".modal-container")).toHaveCount(1, { timeout: 10_000 });
}

test("demo vault: settings, sync scope, devices, passphrase, history, activity, trash", async () => {
  test.skip(process.env.GEODE_DOCS_SHOTS !== "1", "reshoot with deno task docs:screenshots");
  test.setTimeout(12 * 60_000);
  const { server, laptop } = await demoServer();
  const o = await launchDemo(server, laptop);

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 180_000);
    await fixWindow(o);
    await useDarkTheme(o);

    /* ---- Settings tab (a taller window, so the sections below Status fit) ---- */
    await fixWindow(o, 1100);
    await settledSettings(o, server, laptop.token);
    await shoot(o, "settings", SETTINGS);
    await fixWindow(o);

    /* ---- Selective sync: folders, one folder switched off ---- */
    await o.win.locator('[data-testid="geode-settings-folders-manage"]').click();
    await expect(o.win.locator(".geode-folders-modal")).toBeVisible({ timeout: 15_000 });
    await expect(o.win.locator('[data-testid="geode-folder-row"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await o.win.locator('[data-testid="geode-folder-toggle"][data-path="99 - System"]').click();
    await expect(o.win.locator('[data-testid="geode-folder-toggle"][data-path="99 - System"]'))
      .not.toHaveClass(/is-enabled/);
    await shoot(o, "sync-folders", ".geode-folders-modal");
    await closeTop(o);

    /* ---- Devices ---- */
    await o.win.locator('[data-testid="geode-settings-devices-manage"]').click();
    await expect(o.win.locator('[data-testid="geode-device-row"]').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(o.win.locator('[data-testid="geode-device-row"]')).toHaveCount(2);
    await expect(
      o.win.locator('[data-testid="geode-device-row"]', { hasText: "Laptop" })
        .locator(".geode-device-desc"),
    ).toContainText("Up to date", { timeout: 60_000 });
    await shoot(o, "devices", ".geode-devices-modal");
    await closeTop(o);

    /* ---- Change passphrase ---- */
    await o.win.locator('[data-testid="geode-settings-passphrase-change"]').click();
    await expect(o.win.locator('[data-testid="geode-rekey-continue"]')).toBeVisible({
      timeout: 15_000,
    });
    await o.win.mouse.move(5, 5);
    await shoot(o, "change-passphrase", '[data-testid="geode-rekey-modal"]');
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
    await o.win.mouse.move(5, 5);
    await shoot(o, "history-restore", ".geode-history-modal");
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
    await shoot(o, "sync-activity", ".geode-activity-modal");
    await o.win.keyboard.press("Escape");
    await expect(o.win.locator(".geode-activity-modal")).toHaveCount(0, { timeout: 10_000 });

    /* ---- Deleted files ---- */
    await o.eval(`app.commands.executeCommandById("geode:geode-open-trash"); return true;`);
    await expect(o.win.locator(".geode-trash-modal")).toBeVisible({ timeout: 20_000 });
    await expect(o.win.locator('[data-testid="geode-trash-restore"]').first()).toBeVisible({
      timeout: 20_000,
    });
    await shoot(o, "deleted-files", ".geode-trash-modal");
    await o.win.keyboard.press("Escape");

    /* ---- Selective sync: which Obsidian config follows the vault ---- */
    // Last of the settings images: the demo vault keeps config sync off (notes only), so the
    // master toggle is switched on through the real row first, and that is what adds the Config
    // to sync row. A taller window so the whole list, plugins included, fits in the image.
    await openSettingsTab(o);
    await fixWindow(o, 1000);
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
      .toBeVisible({ timeout: 15_000 });
    await o.win.mouse.move(5, 5);
    await shoot(o, "config-to-sync", ".geode-config-modal");
    await closeTop(o);
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("demo vault: a real conflict, listed and reviewed side by side", async () => {
  test.skip(process.env.GEODE_DOCS_SHOTS !== "1", "reshoot with deno task docs:screenshots");
  test.setTimeout(10 * 60_000);
  const { server, laptop, phone } = await demoServer();
  const A = await launchDemo(server, laptop);
  // The demo vault's second device. A desktop window standing in for the phone keeps this spec in
  // the `docs` project: the same conflict either way, and only one window is ever photographed.
  const B = await launchDemo(server, phone, { seed: false, deviceName: "Phone" });

  try {
    for (const o of [A, B]) {
      await fixWindow(o);
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
    await shoot(B, "conflicts-list", ".geode-conflicts-modal");
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
    await shoot(B, "conflict-review", ".geode-conflict-review-modal");
  } finally {
    await Promise.allSettled([A.close(), B.close(), server.stop()]);
  }
});

test("demo vault: a mass delete held for review", async () => {
  test.skip(process.env.GEODE_DOCS_SHOTS !== "1", "reshoot with deno task docs:screenshots");
  test.setTimeout(15 * 60_000);
  const { server, laptop } = await demoServer();
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
    o = await restartHeld(o, held, held.length, DEMO_PASSPHRASE, DEMO_LAUNCH_ARGS);
    await fixWindow(o);
    await useDarkTheme(o);
    const notice = o.win.locator(".notice").last();
    await expect(notice).toContainText("files missing", { timeout: 120_000 });
    await notice.click();
    await expect(o.win.locator(".geode-missing-modal")).toBeVisible({ timeout: 15_000 });
    await expect(o.win.locator(".geode-missing-modal")).toContainText("Review missing files");
    await shoot(o, "mass-delete-review", ".geode-missing-modal");
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});

test("setup wizard: the create form", async () => {
  test.skip(process.env.GEODE_DOCS_SHOTS !== "1", "reshoot with deno task docs:screenshots");
  test.setTimeout(5 * 60_000);
  const { server } = await demoServer();
  const o = await launchUnconfigured(server);
  try {
    await waitForPluginLoaded(o);
    await focusSetupWizard(o);
    await fixWindow(o);
    await useDarkTheme(o);
    await o.win.locator('[data-testid="geode-wizard-create"]').click();
    await o.win.locator('[data-testid="geode-create-server"]').fill("geode.example.com");
    await o.win.mouse.move(5, 5);
    await shoot(o, "setup-wizard", ".modal-container .modal");
  } finally {
    await o.close();
    await server.stop().catch(() => {});
  }
});
