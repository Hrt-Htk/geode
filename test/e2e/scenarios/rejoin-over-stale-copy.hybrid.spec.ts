import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { PhoneDevice, type SyncDevice } from "../helpers/device-abstraction";
import {
  focusSetupWizard,
  upsertVaultFile,
  waitForPluginLoaded,
  waitForUnlocked,
} from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";

// #701: the reported bug, in real Obsidian on a real device: a phone that was revoked while its
// vault folder still held an old copy joins again through the wizard. The server had deleted, edited
// and moved notes in the meantime. Expected: the server wins for every note the phone did not change,
// the notes it did change merge, the files the server cannot vouch for leave the vault for `Geode
// backup/`, and nothing is resurrected or conflicted.
//
// The reported device had lost `local-files.json` while `sync-cursor.json` survived (the split
// test/unit/plugin/state-persistence.test.ts pins). Deleting the row table with the app stopped is
// the only way to reproduce it in a real vault: the in-memory rows would otherwise be written back
// on the way out.
//
// The screen-by-screen version of this flow is in the geode-phone-e2e skill; run it with
// GEODE_PHONE=1 and GEODE_PHONE_PUSH=1.

const PASSPHRASE = "rejoin-over-stale-copy-pass";
const ADMIN_TOKEN = "e2e";
const SEEDED = 20;
const DELETED = 5;
const EDITED = 5;
const MOVED = 2;

const notePath = (i: number) => `notes/n${i}.md`;
const movedTo = (i: number) => `moved/n${i}.md`;
const movedFrom = (i: number) => `notes/n${i + SEEDED}.md`;
const seededBody = (i: number) => `# note ${i}\nsummer copy\n`;
const editedBody = (i: number) => `# note ${i}\nwinter copy\n`;

const ADB = process.env.ADB_PATH ?? "adb";
const SERIAL = process.env.ANDROID_SERIAL;

function adbShell(...args: string[]): string {
  return execFileSync(ADB, [...(SERIAL ? ["-s", SERIAL] : []), "shell", ...args], {
    encoding: "utf-8",
  }).trim();
}

/** Delete through the vault API: it fires the event the plugin commits on, where
 * adapter.remove leaves the commit to the reconciler. */
function deleteNote(device: SyncDevice, vaultPath: string): Promise<boolean> {
  return device.eval<boolean>(
    `await app.vault.delete(app.vault.getAbstractFileByPath(${JSON.stringify(vaultPath)})); true`,
  );
}

/** The vault folder on the phone, read from the adapter before the app stops. */
async function phoneVaultPath(device: SyncDevice): Promise<string> {
  const basePath = await device.eval<string>(`(() => {
    const adapter = app.vault.adapter;
    return typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter.basePath ?? "";
  })()`);
  expect(basePath, "the phone vault path is needed to remove a state file while the app is stopped")
    .not.toBe("");
  return basePath;
}

/** Remove one state file with the app stopped: with the app running, the in-memory rows are
 * written back over the deletion. */
async function removeStateFileStopped(device: PhoneDevice, name: string): Promise<void> {
  const vault = await phoneVaultPath(device);
  await device.forceStop();
  adbShell("rm", "-f", `${vault}/.obsidian/plugins/geode/${name}`);
}

/** A revoke from another device: the device row goes, the vault and its folder stay. */
async function revokeDevice(serverUrl: string, vaultId: string, deviceId: string): Promise<void> {
  const res = await fetch(`${serverUrl}/vaults/${vaultId}/devices/${deviceId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  expect(res.ok, `revoke failed: ${res.status}`).toBe(true);
}

test("rejoin over a stale copy: the server wins, nothing is resurrected (phone)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const pair = await launchHybridPair({ passphrase: PASSPHRASE });
  const { A, B, server } = pair;
  try {
    // 1. Paired, unlocked, converged.
    await waitForPluginLoaded(A);
    await waitForPluginLoaded(B);
    await waitForUnlocked(A);
    await waitForUnlocked(B);
    const vaultId = await A.eval<string>("app.plugins.plugins.geode.settings.vaultId");

    // 2. Seed the notes on A and let them land on the phone.
    for (let i = 0; i < SEEDED + MOVED; i++) {
      await upsertVaultFile(A, notePath(i), seededBody(i));
    }
    for (let i = 0; i < SEEDED + MOVED; i++) {
      await expect
        .poll(async () => await B.fileExists(notePath(i)), { timeout: 120_000 })
        .toBe(true);
    }
    await waitForStatusBar(A, "Geode: synced", 120_000);
    await waitForStatusBar(B, "Geode: synced", 120_000);

    // 3. Revoke the phone, stop it, and reproduce the reported split: rows gone, cursor kept.
    const phoneDeviceId = await B.eval<string>("app.plugins.plugins.geode.settings.deviceId");
    await revokeDevice(server.url, vaultId, phoneDeviceId);
    await removeStateFileStopped(B as PhoneDevice, "local-files.json");

    // 4. Meanwhile on A: delete, edit and move notes (the move lands as delete plus create).
    // app.vault.delete fires the vault event the plugin commits on, and the waits below poll
    // A's own applied position, so the phone cannot rejoin before these reach the server.
    const aSeqBefore = await A.eval<number>("app.plugins.plugins.geode.transport.getLastSeenSeq()");
    for (let i = 0; i < DELETED; i++) {
      await deleteNote(A, notePath(i));
    }
    for (let i = DELETED; i < DELETED + EDITED; i++) {
      await upsertVaultFile(A, notePath(i), editedBody(i));
    }
    for (let i = 0; i < MOVED; i++) {
      await deleteNote(A, movedFrom(i));
      await upsertVaultFile(A, movedTo(i), `# moved ${i}\nwinter copy\n`);
    }
    await expect
      .poll(
        async () => await A.eval<number>("app.plugins.plugins.geode.transport.getLastSeenSeq()"),
        { timeout: 180_000 },
      )
      .toBeGreaterThan(aSeqBefore);
    await expect
      .poll(
        async () => await A.eval<number>("app.plugins.plugins.geode.getPendingOps().length"),
        { timeout: 120_000 },
      )
      .toBe(0);

    // 5. The phone comes back with its old copy and joins again through the real wizard.
    await (B as PhoneDevice).relaunch();
    await waitForPluginLoaded(B);
    await B.eval(
      `await app.vault.create("written offline.md", "# written here while offline\\n"); return true;`,
    );
    // A configured device does not auto-open the setup wizard (gate7 joins an unconfigured
    // one): the user opens it from Settings, which is the same call.
    await B.eval("app.plugins.plugins.geode.startSetupWizard(); return true;");
    await focusSetupWizard(B);
    await B.eval(
      `document.querySelector('[data-testid="geode-wizard-join"]').click(); return true;`,
    );
    await B.win.locator('[data-testid="geode-join-server"]').waitFor();
    await B.eval(`
      document.querySelector('[data-testid="geode-join-server"]').value = ${
      JSON.stringify(server.url)
    };
      document.querySelector('[data-testid="geode-join-admin"]').value = ${
      JSON.stringify(ADMIN_TOKEN)
    };
      document.querySelector('[data-testid="geode-join-load"]').click();
      return true;
    `);
    await B.win.locator('[data-testid="geode-join-vault-select"]').waitFor();

    // The warning must be on screen before the join runs. Shot for review (notices first:
    // a toast would cover the modal).
    const warning = B.win.locator('[data-testid="geode-join-rejoin-warning"]');
    await expect(warning).toContainText("Geode backup", { timeout: 30_000 });
    // #701 review: text alone passes on a hidden element: it must be on screen.
    await expect(warning).toBeVisible();
    await B.eval(`document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`);
    await B.screenshot("rejoin-join-warning");

    await B.eval(`
      const sel = document.querySelector('[data-testid="geode-join-vault-select"]');
      sel.value = ${JSON.stringify(vaultId)};
      sel.dispatchEvent(new Event("change"));
      document.querySelector('[data-testid="geode-join-device-name"]').value = "rejoined-phone";
      document.querySelector('[data-testid="geode-join-passphrase"]').value = ${
      JSON.stringify(PASSPHRASE)
    };
      document.querySelector('[data-testid="geode-join-submit"]').click();
      return true;
    `);
    await waitForUnlocked(B, 180_000);

    // The Done step reports the count and the folder.
    await expect(B.win.locator('[data-testid="geode-join-rejoin-result"]'))
      .toContainText("Geode backup", { timeout: 60_000 });
    await B.eval(`document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`);
    await B.screenshot("rejoin-done-result");
    await waitForStatusBar(B, "Geode: synced", 180_000);

    // 6. The observable outcome: no conflicts, the server's state landed, nothing came back.
    expect(await B.eval<number>("app.plugins.plugins.geode.getConflictCount()")).toBe(0);
    for (let i = 0; i < DELETED; i++) {
      expect(await B.fileExists(notePath(i)), `${notePath(i)} was resurrected`).toBe(false);
    }
    for (let i = DELETED; i < DELETED + EDITED; i++) {
      expect(await B.readVaultFile(notePath(i))).toBe(editedBody(i));
    }
    for (let i = 0; i < MOVED; i++) {
      expect(await B.fileExists(movedFrom(i))).toBe(false);
      expect(await B.fileExists(movedTo(i))).toBe(true);
    }
    expect(
      await B.eval<number>(
        `app.vault.getMarkdownFiles().filter((f) => /conflict/i.test(f.path)).length`,
      ),
    )
      .toBe(0);

    // The set-aside folder holds exactly the note written here while offline, and never syncs.
    const backupDirs = await B.eval<string[]>(
      `(await app.vault.adapter.list("Geode backup")).folders`,
    );
    expect(backupDirs.length).toBe(1);
    expect(
      await B.eval<string>(
        `await app.vault.adapter.read(${JSON.stringify(`${backupDirs[0]}/written offline.md`)})`,
      ),
    ).toBe("# written here while offline\n");
    expect(await B.fileExists("written offline.md")).toBe(false);
    // The folder scope list offers only folders the user can switch: the backup folder is
    // never in scope, so it is not listed. Shot for review.
    await B.eval(`app.setting.open(); app.setting.openTabById("geode"); return true;`);
    await expect
      .poll(
        async () =>
          await B.eval<boolean>(
            `Boolean(document.querySelector('[data-testid="geode-settings-folders-manage"]'))`,
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    await B.eval(
      `document.querySelector('[data-testid="geode-settings-folders-manage"]').click(); return true;`,
    );
    const readRows = () =>
      B.eval<string[]>(
        `[...document.querySelectorAll('[data-testid="geode-folder-row"]')].map((el) => el.textContent)`,
      );
    await expect.poll(async () => (await readRows()).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    const folderRows = await readRows();
    expect(folderRows.join("|")).not.toContain("Geode backup");
    await B.eval(`document.querySelectorAll('.notice').forEach((n) => n.remove()); return true;`);
    await B.screenshot("rejoin-folder-scope");

    const log = await B.eval<string[]>(
      "app.plugins.plugins.geode.getRecentLog().map((e) => JSON.stringify(e))",
    );
    expect(log.some((line) => line.includes("rejoin prepared"))).toBe(true);
    expect(log.some((line) => line.includes("rejoin backed up doubtful files"))).toBe(true);
  } finally {
    await pair.stop();
  }
});
