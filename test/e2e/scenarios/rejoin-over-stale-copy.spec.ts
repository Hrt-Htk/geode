import { execSync } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import type { ObsidianInstance } from "../fixtures/obsidian";
import { focusSetupWizard, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";

// #701: rejoin over an old copy, in real Obsidian on the desktop: the device joins again with
// its stale folder, the server has deleted and edited notes in the meantime, and one note was
// written here while it was offline. Asserts the observable outcome (the vault matches the
// server, nothing resurrected, nothing conflicted, the offline note set aside) and captures the
// two UI states the owner asked for: the warning on the join step and the report on the Done step.

const PASSPHRASE = "rejoin-over-stale-pass";
const ADMIN_TOKEN = "e2e";
const NOTES = 8;
const DELETED = 2;
const EDITED = 2;

const notePath = (i: number) => `notes/n${i}.md`;
const seededBody = (i: number) => `# note ${i}\nsummer copy\n`;
const editedBody = (i: number) => `# note ${i}\nwinter copy\n`;

/** Review evidence lives in the main checkout, never in a worktree that gets archived. */
const REVIEW_DIR = (() => {
  const gitCommonDir = execSync("git rev-parse --path-format=absolute --git-common-dir", {
    cwd: __dirname,
    encoding: "utf-8",
  }).trim();
  return path.join(path.dirname(gitCommonDir), "tmp", "review", "701");
})();

function exists(o: ObsidianInstance, vaultPath: string): Promise<boolean> {
  return o.eval<boolean>(`await app.vault.adapter.exists(${JSON.stringify(vaultPath)})`);
}

function read(o: ObsidianInstance, vaultPath: string): Promise<string> {
  return o.eval<string>(`await app.vault.adapter.read(${JSON.stringify(vaultPath)})`);
}

test("rejoin over a stale copy: the server wins and the UI says so", async () => {
  test.slow();
  const server = await startServer();
  const [deviceA, deviceB] = await Promise.all([
    server.mintToken("rejoin-desktop-A"),
    server.mintToken("rejoin-desktop-B"),
  ]);
  const settingsFor = (device: { deviceId: string; token: string }) => ({
    serverUrl: server.url,
    vaultId: server.vaultId,
    deviceId: device.deviceId,
    deviceToken: device.token,
    salt: server.salt,
    // Config sync off: this spec is about notes. With it on, Obsidian's own rewrites of
    // .obsidian/ config are doubtful too and land in the backup folder (correctly, but noise).
    syncObsidianConfig: false,
  });
  const A = await launchObsidian({
    geodeSettings: settingsFor(deviceA),
    unlockPassphrase: PASSPHRASE,
  });
  const B = await launchObsidian({
    geodeSettings: settingsFor(deviceB),
    unlockPassphrase: PASSPHRASE,
    keepVaultDir: true,
    keepUserDataDir: true,
  });
  let B2: ObsidianInstance | null = null;
  try {
    await waitForUnlocked(A);
    await waitForUnlocked(B);
    await waitForStatusBar(A.win, "Geode: synced", 90_000);
    await waitForStatusBar(B.win, "Geode: synced", 90_000);

    for (let i = 0; i < NOTES; i++) await upsertVaultFile(A, notePath(i), seededBody(i));
    for (let i = 0; i < NOTES; i++) {
      await expect.poll(async () => await exists(B, notePath(i)), { timeout: 90_000 }).toBe(true);
    }
    await waitForStatusBar(A.win, "Geode: synced", 90_000);
    await waitForStatusBar(B.win, "Geode: synced", 90_000);

    // Freeze B the way the reported device was frozen: the row table lost, the cursor kept,
    // the folder untouched, and one note written here while the app was closed.
    const bVaultDir = B.vaultDir;
    const pluginDir = path.join(bVaultDir, ".obsidian", "plugins", "geode");
    // The state must be on disk before it is taken away (rows are throttled, the cursor is not).
    await expect.poll(async () =>
      await access(path.join(pluginDir, "local-files.json")).then(
        () => true,
        () => false,
      ), { timeout: 30_000 }).toBe(true);
    await B.close();
    await access(path.join(pluginDir, "sync-cursor.json"));
    await rm(path.join(pluginDir, "local-files.json"), { force: true });
    await writeFile(path.join(bVaultDir, "written offline.md"), "# written here while offline\n");
    const revoke = await fetch(
      `${server.url}/vaults/${server.vaultId}/devices/${deviceB.deviceId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );
    expect(revoke.ok).toBe(true);

    // Meanwhile on A: delete and edit notes, through the vault API so the events fire.
    const aSeqBefore = await A.eval<number>("app.plugins.plugins.geode.transport.getLastSeenSeq()");
    for (let i = 0; i < DELETED; i++) {
      await A.eval(
        `await app.vault.delete(app.vault.getAbstractFileByPath(${
          JSON.stringify(notePath(i))
        })); return true;`,
      );
    }
    for (let i = DELETED; i < DELETED + EDITED; i++) {
      await upsertVaultFile(A, notePath(i), editedBody(i));
    }
    await expect
      .poll(
        async () => await A.eval<number>("app.plugins.plugins.geode.transport.getLastSeenSeq()"),
        { timeout: 120_000 },
      )
      .toBeGreaterThan(aSeqBefore);

    // The device comes back with its old copy and joins again through the real wizard.
    B2 = await launchObsidian({
      geodeSettings: settingsFor(deviceB),
      unlockPassphrase: PASSPHRASE,
      vaultDir: bVaultDir,
      userDataDir: B.userDataDir,
      prepared: true,
      keepVaultDir: true,
      keepUserDataDir: true,
      keepStartupModal: false,
    });
    await waitForUnlocked(B2);
    await B2.eval("app.plugins.plugins.geode.startSetupWizard(); return true;");
    await focusSetupWizard(B2);
    await B2.eval(
      `document.querySelector('[data-testid="geode-wizard-join"]').click(); return true;`,
    );
    await B2.win.locator('[data-testid="geode-join-server"]').waitFor();
    await B2.eval(`
      document.querySelector('[data-testid="geode-join-server"]').value = ${
      JSON.stringify(server.url)
    };
      document.querySelector('[data-testid="geode-join-admin"]').value = ${
      JSON.stringify(ADMIN_TOKEN)
    };
      document.querySelector('[data-testid="geode-join-load"]').click();
      return true;
    `);
    await B2.win.locator('[data-testid="geode-join-vault-select"]').waitFor();
    await B2.eval(`
      const sel = document.querySelector('[data-testid="geode-join-vault-select"]');
      sel.value = ${JSON.stringify(server.vaultId)};
      sel.dispatchEvent(new Event('change'));
      return true;
    `);

    // 1. The join step warns before anything runs.
    const warning = B2.win.locator('[data-testid="geode-join-rejoin-warning"]');
    await expect(warning).toContainText("Geode backup", { timeout: 30_000 });
    const warningLines = await B2.eval<number>(`(() => {
      const el = document.querySelector('[data-testid="geode-join-rejoin-warning"]');
      if (!el) return -1;
      const style = getComputedStyle(el);
      return Math.round(el.getBoundingClientRect().height / parseFloat(style.lineHeight));
    })()`);
    const warningText = (await warning.textContent()) ?? "";
    // #701 review: text alone passes on a hidden element: it must be on screen.
    await expect(warning).toBeVisible();
    expect(warningLines).toBeGreaterThan(0);
    console.log(`[shots] join warning: ${warningLines} line(s) at ${warningText.length} chars`);
    await mkdir(REVIEW_DIR, { recursive: true });
    await B2.win.screenshot({ path: path.join(REVIEW_DIR, "desktop-join-warning.png") });

    // 2. Join: the rejoin rebuild runs, the Done step reports where the doubt went.
    await B2.eval(`
      document.querySelector('[data-testid="geode-join-device-name"]').value = "rejoined-desktop";
      document.querySelector('[data-testid="geode-join-passphrase"]').value = ${
      JSON.stringify(PASSPHRASE)
    };
      document.querySelector('[data-testid="geode-join-submit"]').click();
      return true;
    `);
    await waitForUnlocked(B2, 180_000);
    const result = B2.win.locator('[data-testid="geode-join-rejoin-result"]');
    await expect(result).toContainText("Geode backup", { timeout: 90_000 });
    const resultText = (await result.textContent()) ?? "";
    console.log(`[shots] done step result: ${resultText}`);
    await B2.win.screenshot({ path: path.join(REVIEW_DIR, "desktop-done-result.png") });
    await B2.eval(
      `document.querySelector('[data-testid="geode-done-submit"]')?.click(); return true;`,
    );
    await waitForStatusBar(B2.win, "Geode: synced", 180_000);

    // 3. The observable outcome.
    for (let i = 0; i < DELETED; i++) {
      expect(await exists(B2, notePath(i)), `${notePath(i)} was resurrected`).toBe(false);
    }
    for (let i = DELETED; i < DELETED + EDITED; i++) {
      expect(await read(B2, notePath(i))).toBe(editedBody(i));
    }
    expect(await B2.eval<number>("app.plugins.plugins.geode.getConflictCount()")).toBe(0);
    expect(
      await B2.eval<number>(
        `app.vault.getMarkdownFiles().filter((f) => /conflict/i.test(f.path)).length`,
      ),
    ).toBe(0);
    const backupFiles = await B2.eval<string[]>(
      `(await app.vault.adapter.list("Geode backup")).folders`,
    );
    expect(backupFiles.length).toBe(1);
    const backedUp = await B2.eval<string[]>(`(async () => {
      const out = [];
      const walk = async (dir) => {
        const list = await app.vault.adapter.list(dir);
        for (const f of list.files) out.push(f);
        for (const d of list.folders) await walk(d);
      };
      await walk(${JSON.stringify(backupFiles[0])});
      return out;
    })()`);
    console.log(`[shots] backup contents: ${JSON.stringify(backedUp)}`);
    expect(await read(B2, `${backupFiles[0]}/written offline.md`))
      .toBe("# written here while offline\n");
    expect(await exists(B2, "written offline.md")).toBe(false);
    const log = await B2.eval<string[]>(
      "app.plugins.plugins.geode.getRecentLog().map((e) => JSON.stringify(e))",
    );
    expect(log.some((line) => line.includes("rejoin prepared"))).toBe(true);

    // 4. The folder scope list offers only folders the user can switch: the backup folder is
    // never in scope, so it is not listed. Screenshot it for review.
    await B2.eval(
      `app.setting.open(); app.setting.openTabById("geode"); return true;`,
    );
    await B2.win.locator('[data-testid="geode-settings-folders-manage"]').waitFor({
      timeout: 30_000,
    });
    await B2.eval(
      `document.querySelector('[data-testid="geode-settings-folders-manage"]').click(); return true;`,
    );
    await B2.win.locator('[data-testid="geode-folder-row"]').first().waitFor({ timeout: 30_000 });
    const folderRows = await B2.eval<string[]>(
      `[...document.querySelectorAll('[data-testid="geode-folder-row"]')].map((el) => el.textContent)`,
    );
    console.log(`[shots] folder scope rows: ${JSON.stringify(folderRows)}`);
    expect(folderRows.join("|")).toContain("notes");
    expect(folderRows.join("|")).not.toContain("Geode backup");
    await B2.win.screenshot({ path: path.join(REVIEW_DIR, "desktop-folder-scope.png") });
  } finally {
    await A.close();
    await B2?.close();
    await server.stop();
  }
});
