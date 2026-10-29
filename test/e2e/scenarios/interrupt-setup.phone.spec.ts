import { expect, test } from "@playwright/test";
import { connectPhone, type PhoneInstance } from "../fixtures/phone-obsidian";
import { requireDataDir, useRemoteServer } from "../fixtures/phone-server";
import {
  commitPath,
  focusSetupWizard,
  waitForPluginLoaded,
  waitForUnlocked,
} from "../helpers/geode";
import { serverVaultCount, unlockIfLocked, waitForServerState } from "../helpers/interrupt";
import { waitForStatusBar } from "../helpers/waits";
import { evalClick, evalSetValue } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #493 flow a (phone, #459): EXPECTED: the phone is force-stopped mid wizard (create: after
// the server vault row exists; join: after the server device row exists, before the local
// settings are saved); a relaunch shows an honest state: the setup wizard re-opens (not a
// half-configured plugin that silently fails), and finishing the wizard works: the device is
// unlocked, syncs, and writes the vault. The orphaned server rows from the interrupted attempt
// are harmless (no double-provisioning that breaks sync).
const ADMIN = "e2e";
const BLANK_CREDS = { serverUrl: "", vaultId: "", deviceId: "", deviceToken: "", salt: "" };

async function runCreateWizard(
  obsidian: PhoneInstance,
  serverUrl: string,
  vaultName: string,
  passphrase: string,
): Promise<void> {
  await evalClick(obsidian, '[data-testid="geode-wizard-create"]');
  await expect
    .poll(() =>
      obsidian.eval<boolean>(`!!document.querySelector('[data-testid="geode-create-server"]')`)
    )
    .toBe(true);
  await evalSetValue(obsidian, '[data-testid="geode-create-server"]', serverUrl);
  await evalSetValue(obsidian, '[data-testid="geode-create-admin"]', ADMIN);
  await evalClick(obsidian, '[data-testid="geode-create-continue"]');
  await expect
    .poll(() =>
      obsidian.eval<boolean>(`!!document.querySelector('[data-testid="geode-create-vault-name"]')`)
    )
    .toBe(true);
  await evalSetValue(obsidian, '[data-testid="geode-create-vault-name"]', vaultName);
  await evalSetValue(obsidian, '[data-testid="geode-create-passphrase"]', passphrase);
  await evalSetValue(obsidian, '[data-testid="geode-create-confirm"]', passphrase);
  await evalClick(obsidian, '[data-testid="geode-create-submit"]');
}

async function runJoinWizard(
  obsidian: PhoneInstance,
  serverUrl: string,
  vaultId: string,
  passphrase: string,
): Promise<void> {
  await evalClick(obsidian, '[data-testid="geode-wizard-join"]');
  await expect
    .poll(() =>
      obsidian.eval<boolean>(`!!document.querySelector('[data-testid="geode-join-server"]')`)
    )
    .toBe(true);
  await evalSetValue(obsidian, '[data-testid="geode-join-server"]', serverUrl);
  await evalSetValue(obsidian, '[data-testid="geode-join-admin"]', ADMIN);
  await evalClick(obsidian, '[data-testid="geode-join-load"]');
  await obsidian.eval(`
    const sel = document.querySelector('[data-testid="geode-join-vault-select"]');
    if (!sel) throw new Error("vault select not found");
    sel.value = ${JSON.stringify(vaultId)};
    sel.dispatchEvent(new Event("change"));
    return true;
  `);
  await evalSetValue(obsidian, '[data-testid="geode-join-device-name"]', "interrupt-phone-join");
  await evalSetValue(obsidian, '[data-testid="geode-join-passphrase"]', passphrase);
  await evalClick(obsidian, '[data-testid="geode-join-submit"]');
}

test("issue493 (phone): force-stop mid wizard create → relaunch → wizard re-opens, finishing create syncs", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(600_000);

  const server = await useRemoteServer();
  const dataDir = requireDataDir(server);

  const obsidian = await connectPhone({ geodeSettings: BLANK_CREDS });

  try {
    await waitForPluginLoaded(obsidian);
    await focusSetupWizard(obsidian);
    await runCreateWizard(
      obsidian,
      server.url,
      "interrupt-phone-create",
      "interrupt-phone-create-pass",
    );

    /* Deterministic mid-create signal: the server vault row exists (the create is in flight).
       The kill lands somewhere in createVault → … → saveSettings; the relaunch is therefore
       either unconfigured (wizard re-opens) or configured (shows Unlock): both honest. */
    await waitForServerState(
      () => serverVaultCount(dataDir),
      (n) => n >= 2,
      60_000,
      "new vault row on the server",
    );

    const obsidian2 = await obsidian.relaunch();
    try {
      /* Honest state: wizard re-opens (settings unsaved) or configured + Unlock (saved). */
      const configured = await obsidian2.eval<string>("app.plugins.plugins.geode.settings.vaultId");
      if (configured === "") {
        await focusSetupWizard(obsidian2);
        await obsidian2.screenshot(shotPath("493-setup-create-phone-relaunch-wizard.png"));
        /* Finishing the wizard works: a fresh create unlocks and syncs. */
        await runCreateWizard(
          obsidian2,
          server.url,
          "interrupt-phone-create-retry",
          "interrupt-phone-create-pass",
        );
      } else {
        /* The interrupted create persisted its settings: unlock the vault it created. */
        await unlockIfLocked(obsidian2, "interrupt-phone-create-pass");
      }
      await waitForUnlocked(obsidian2);
      await waitForStatusBar(obsidian2.win, "Geode: synced", 120_000);

      /* No double-provisioning that breaks sync: the vault writes (commitPath waits for this
         specific file to land, not just the .obsidian config files). */
      await obsidian2.eval(`app.vault.create("after-recovery.md", "recovery works")`);
      await commitPath(obsidian2, "after-recovery.md", "commit");
      await obsidian2.screenshot(shotPath("493-setup-create-phone-settled.png"));
    } finally {
      await obsidian2.close();
    }
  } finally {
    await obsidian.close().catch(() => {});
    await server.stop().catch(() => {});
  }
});

test("issue493 (phone): force-stop mid wizard join → relaunch → wizard re-opens, finishing join syncs", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(600_000);

  const server = await useRemoteServer();
  requireDataDir(server);

  /* The vault is provisioned server-side (no verifier) so the join has a real target. */
  const vaultRes = await fetch(`${server.url}/vaults`, {
    method: "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "interrupt-phone-join-vault" }),
  });
  if (!vaultRes.ok) throw new Error(`create vault failed: ${vaultRes.status}`);
  const { vault_id: vaultId } = (await vaultRes.json()) as { vault_id: string };

  const obsidian = await connectPhone({ geodeSettings: BLANK_CREDS });

  try {
    await waitForPluginLoaded(obsidian);
    await focusSetupWizard(obsidian);
    await runJoinWizard(obsidian, server.url, vaultId, "interrupt-phone-join-pass");

    /* Deterministic mid-join signal: the wizard is in its "Joining…" busy state: the join
       flow is in flight (server round-trips + key derivation), settings not yet saved. The
       device-row → saveSettings window is milliseconds, so the busy state is the signal. */
    await expect
      .poll(
        () =>
          obsidian.eval<string>(
            `document.querySelector('[data-testid="geode-join-submit"]')?.textContent ?? ""`,
          ),
        { timeout: 60_000 },
      )
      .toBe("Joining…");

    const obsidian2 = await obsidian.relaunch();
    try {
      /* Honest state: wizard re-opens (settings unsaved) or configured + Unlock (saved). */
      const configured = await obsidian2.eval<string>("app.plugins.plugins.geode.settings.vaultId");
      if (configured === "") {
        await focusSetupWizard(obsidian2);
        await obsidian2.screenshot(shotPath("493-setup-join-phone-relaunch-wizard.png"));
        /* Finishing the wizard works: re-join unlocks and syncs. */
        await runJoinWizard(obsidian2, server.url, vaultId, "interrupt-phone-join-pass");
      } else {
        /* The interrupted join persisted its settings: unlock the vault it joined. */
        await unlockIfLocked(obsidian2, "interrupt-phone-join-pass");
      }
      await waitForUnlocked(obsidian2);
      await waitForStatusBar(obsidian2.win, "Geode: synced", 120_000);

      /* No double-provisioning that breaks sync: the joined vault writes (commitPath waits
         for this specific file to land, not just the .obsidian config files). */
      await obsidian2.eval(`app.vault.create("after-recovery.md", "recovery works")`);
      await commitPath(obsidian2, "after-recovery.md", "commit");
      await obsidian2.screenshot(shotPath("493-setup-join-phone-settled.png"));
    } finally {
      await obsidian2.close();
    }
  } finally {
    await obsidian.close().catch(() => {});
    await server.stop().catch(() => {});
  }
});
