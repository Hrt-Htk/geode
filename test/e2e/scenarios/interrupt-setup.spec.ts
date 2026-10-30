import { expect, test } from "@playwright/test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { launchObsidian, type ObsidianInstance, TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import {
  commitPath,
  focusSetupWizard,
  upsertVaultFile,
  waitForPluginLoaded,
  waitForUnlocked,
} from "../helpers/geode";
import {
  relaunchDesktop,
  serverVaultCount,
  unlockIfLocked,
  waitForServerState,
} from "../helpers/interrupt";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #493 flow a (desktop, #459): EXPECTED: the app is SIGKILLed mid wizard (create: once the
// server vault row exists; join, while the "Joining…" flow is in flight); a relaunch shows an
// honest state: the setup wizard re-opens (settings unsaved) or the plugin offers to unlock
// (settings saved): never a half-configured plugin that silently fails, and finishing setup
// works: the device is unlocked, syncs, and reads/writes the vault. The orphaned server rows
// from the interrupted attempt are harmless (no double-provisioning that breaks sync).
const ADMIN = "e2e";
const BLANK = { serverUrl: "", vaultId: "", deviceId: "", deviceToken: "", salt: "" };

async function launchUnconfiguredKeep(): Promise<ObsidianInstance> {
  return await launchObsidian({
    geodeSettings: { ...BLANK, argon2Params: TEST_ARGON2_PARAMS },
    keepStartupModal: true,
    keepVaultDir: true,
    keepUserDataDir: true,
  });
}

async function runCreateWizard(
  win: ObsidianInstance["win"],
  serverUrl: string,
  vaultName: string,
  passphrase: string,
): Promise<void> {
  await win.locator('[data-testid="geode-wizard-create"]').click();
  await win.locator('[data-testid="geode-create-server"]').fill(serverUrl);
  await win.locator('[data-testid="geode-create-admin"]').fill(ADMIN);
  await win.locator('[data-testid="geode-create-continue"]').click();
  await win.locator('[data-testid="geode-create-vault-name"]').waitFor();
  await win.locator('[data-testid="geode-create-vault-name"]').fill(vaultName);
  await win.locator('[data-testid="geode-create-passphrase"]').fill(passphrase);
  await win.locator('[data-testid="geode-create-confirm"]').fill(passphrase);
  await win.locator('[data-testid="geode-create-submit"]').click();
}

async function runJoinWizard(
  win: ObsidianInstance["win"],
  serverUrl: string,
  vaultId: string,
  passphrase: string,
): Promise<void> {
  await win.locator('[data-testid="geode-wizard-join"]').click();
  await win.locator('[data-testid="geode-join-server"]').fill(serverUrl);
  await win.locator('[data-testid="geode-join-admin"]').fill(ADMIN);
  await win.locator('[data-testid="geode-join-load"]').click();
  await win.locator('[data-testid="geode-join-vault-select"]').selectOption(vaultId);
  await win.locator('[data-testid="geode-join-device-name"]').fill("interrupt-join-device");
  await win.locator('[data-testid="geode-join-passphrase"]').fill(passphrase);
  await win.locator('[data-testid="geode-join-submit"]').click();
}

test("issue493: kill mid wizard create → relaunch → wizard re-opens, finishing create syncs", async () => {
  test.slow();

  const server = await startServer();
  const a = await launchUnconfiguredKeep();

  try {
    await waitForPluginLoaded(a);
    await focusSetupWizard(a);
    await runCreateWizard(a.win, server.url, "interrupt-create", "interrupt-create-pass");

    /* Deterministic mid-create signal: the server vault row exists (the create is in flight).
       The kill lands somewhere in createVault → … → saveSettings; the relaunch is therefore
       either unconfigured (wizard re-opens) or configured (shows Unlock): both honest. */
    await waitForServerState(
      () => serverVaultCount(server.dataDir),
      (n) => n >= 2,
      60_000,
      "new vault row on the server",
    );

    const a2 = await relaunchDesktop(a);
    try {
      /* Honest state: either the wizard re-opens (settings unsaved) or the plugin is
         configured and offers to unlock (settings saved): never a silent half-configuration. */
      const configured = await a2.eval<string>("app.plugins.plugins.geode.pluginSettings.vaultId");
      if (configured === "") {
        await focusSetupWizard(a2);
        await a2.win.screenshot({
          path: shotPath("493-setup-create-relaunch-wizard.png"),
          fullPage: true,
        });
        /* Finishing the wizard works: a fresh create unlocks and syncs. */
        await runCreateWizard(
          a2.win,
          server.url,
          "interrupt-create-retry",
          "interrupt-create-pass",
        );
      } else {
        /* The interrupted create persisted its settings: unlock the vault it created. */
        await unlockIfLocked(a2, "interrupt-create-pass");
      }
      await waitForUnlocked(a2);
      await waitForStatusBar(a2.win, "Geode: synced", 60_000);

      /* No double-provisioning that breaks sync: the vault reads and writes (commitPath
         waits for this specific file to land, not just the .obsidian config files). */
      await upsertVaultFile(a2, "after-recovery.md", "recovery works");
      await commitPath(a2, "after-recovery.md", "commit");
      await a2.win.screenshot({ path: shotPath("493-setup-create-settled.png"), fullPage: true });
    } finally {
      await a2.close();
    }
  } finally {
    await a.close();
    await rm(a.vaultDir, { recursive: true, force: true });
    await rm(a.userDataDir, { recursive: true, force: true });
    await server.stop().catch(() => {});
  }
});

test("issue493: kill mid wizard join → relaunch → wizard re-opens, finishing join sees A's file", async () => {
  test.slow();

  const server = await startServer();

  /* Device A creates the vault and commits a file. */
  const a = await launchUnconfiguredKeep();
  let vaultId = "";
  try {
    await waitForPluginLoaded(a);
    await focusSetupWizard(a);
    await runCreateWizard(a.win, server.url, "interrupt-join-vault", "interrupt-join-pass");
    await waitForUnlocked(a);
    vaultId = await a.eval<string>("app.plugins.plugins.geode.pluginSettings.vaultId");
    /* Commit a real file (commitPath waits for the commit to land: the .obsidian config
       files commit first, so a bare version-count wait would return before this file). */
    await upsertVaultFile(a, "from-a.md", "written by A before the join");
    await commitPath(a, "from-a.md", "commit");
  } finally {
    await a.close();
  }

  const b = await launchUnconfiguredKeep();
  try {
    await waitForPluginLoaded(b);
    await focusSetupWizard(b);
    await runJoinWizard(b.win, server.url, vaultId, "interrupt-join-pass");

    /* Deterministic mid-join signal: the wizard is in its "Joining…" busy state: the join
       flow is in flight (server round-trips + key derivation), settings not yet saved. The
       device-row → saveSettings window is milliseconds, so the busy state is the signal. */
    await expect
      .poll(
        () =>
          b.eval<string>(
            `document.querySelector('[data-testid="geode-join-submit"]')?.textContent ?? ""`,
          ),
        { timeout: 60_000 },
      )
      .toBe("Joining…");

    const b2 = await relaunchDesktop(b);
    try {
      /* Honest state: either the wizard re-opens (settings unsaved) or the plugin is
         configured and offers to unlock (settings saved): never a silent half-configuration. */
      const configured = await b2.eval<string>("app.plugins.plugins.geode.pluginSettings.vaultId");
      if (configured === "") {
        await focusSetupWizard(b2);
        await b2.win.screenshot({
          path: shotPath("493-setup-join-relaunch-wizard.png"),
          fullPage: true,
        });
        /* Finishing the wizard works: re-join unlocks and syncs A's file in. */
        await runJoinWizard(b2.win, server.url, vaultId, "interrupt-join-pass");
      } else {
        /* The interrupted join persisted its settings: unlock the vault it joined. */
        await unlockIfLocked(b2, "interrupt-join-pass");
      }
      await waitForUnlocked(b2);
      await waitForStatusBar(b2.win, "Geode: synced", 60_000);

      /* No data loss: A's file is on B with its content. "synced" can flash before the
         cold-sync apply lands, so poll for the file on disk first. */
      await expect
        .poll(() => b2.eval<boolean>(`await app.vault.adapter.exists("from-a.md")`), {
          timeout: 60_000,
        })
        .toBe(true);
      const got = await readFile(path.join(b2.vaultDir, "from-a.md"), "utf8");
      expect(got).toBe("written by A before the join");
      await b2.win.screenshot({ path: shotPath("493-setup-join-settled.png"), fullPage: true });
    } finally {
      await b2.close();
    }
  } finally {
    await b.close();
    await rm(b.vaultDir, { recursive: true, force: true });
    await rm(b.userDataDir, { recursive: true, force: true });
    await server.stop().catch(() => {});
  }
});
