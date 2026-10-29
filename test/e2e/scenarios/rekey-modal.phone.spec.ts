import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { upsertVaultFile } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick, evalSetValue } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #559: the change-passphrase / re-key modal on the real phone: settings rows,
// change form with the live mismatch hint, re-key form with the level dropdown,
// choose step with estimate + copy available, then a real change re-key
// (copy mode) through running, paused, and success. The copy-blocked state is
// a server-side condition covered by the desktop spec (same disabled-toggle UI).
const PASSPHRASE = "rekey-phone-pass";
const NEW_PASSPHRASE = "rekey-phone-new-pass";

const NOTE_SEED = "rekey phone note";

function noteContent(seed: number, kb: number): string {
  const line = `${NOTE_SEED} ${seed} ${"x".repeat(60)}\n`;
  const lines = Math.ceil((kb * 1024) / line.length);
  return Array.from({ length: lines }, (_, i) => `${i} ${line}`).join("");
}

/** Close only the re-key modal. dismissModals closes every .modal-container,
 * on mobile the settings tab is one, so it would take the tab down too. */
function closeRekeyModal(obsidian: { eval: (s: string) => Promise<unknown> }): Promise<unknown> {
  return obsidian.eval(`
    (() => {
      const modals = document.querySelectorAll('[data-testid="geode-rekey-modal"]');
      const m = modals[modals.length - 1]; // closed modals persist; the newest is last
      // The X is a div.modal-header-button (not a button element) on mobile.
      m?.querySelector(".modal-header-button")?.click();
      return true;
    })()
  `);
}

/** Wait until the server's vault blob store holds at least `minBytes`: the status bar
 * can read "synced" before the reconciler has even seen newly created files. */
async function waitForVaultBytes(
  server: { url: string; vaultId: string },
  token: string,
  minBytes: number,
): Promise<void> {
  await expect
    .poll(async () => {
      const r = await fetch(`${server.url}/vaults/${server.vaultId}/storage`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return (await r.json() as { vault_used: number }).vault_used;
    }, { timeout: 120_000 })
    .toBeGreaterThanOrEqual(minBytes);
}

test("rekey modal surfaces + real change-passphrase run (phone)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("rekey-modal");
  // #675: the seeded vault needs its re-key auth hash, as a real create/join registers it.
  await server.registerAuthHash(device.token, PASSPHRASE, TEST_ARGON2_PARAMS);

  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    keepStartupModal: true,
  });

  try {
    await expect.poll(
      async () => await readGeodeStatusBar(obsidian.win),
      { timeout: 30_000 },
    ).toBe("Geode: locked");

    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    // A real file with a few MB of work so the run has a visible running phase.
    const filePath = "phone-note.md";
    const fileContent = noteContent(1, 3000);
    await upsertVaultFile(obsidian, filePath, fileContent);
    await waitForVaultBytes(server, device.token, 2_500_000);

    /* ---- (a) Settings rows: Passphrase (Vault) + Encryption strength (Advanced) ---- */
    await obsidian.eval(`
      app.setting.open();
      app.setting.openTabById("geode");
      return "ok";
    `);
    const passphraseRow = obsidian.win.locator('[data-testid="geode-settings-passphrase"]');
    await expect(passphraseRow).toHaveCount(1, { timeout: 15_000 });
    await expect(passphraseRow.locator(".setting-item-name")).toHaveText("Passphrase");
    await expect(passphraseRow.locator('[data-testid="geode-settings-passphrase-change"]'))
      .toHaveText("Change…");

    await evalClick(obsidian, ".geode-advanced-heading");
    const strengthRow = obsidian.win.locator('[data-testid="geode-settings-encryption-strength"]');
    await expect(strengthRow).toHaveCount(1, { timeout: 15_000 });
    await expect(strengthRow.locator(".setting-item-name")).toHaveText("Encryption strength");
    await expect(strengthRow.locator('[data-testid="geode-settings-rekey"]')).toHaveText("Rekey…");

    await obsidian.eval(`
      document.querySelector('[data-testid="geode-settings-passphrase"]')?.scrollIntoView({ block: "center" });
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      return true;
    `);
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("559-phone-01-passphrase-row.png"));

    await obsidian.eval(`
      document.querySelector('[data-testid="geode-settings-encryption-strength"]')?.scrollIntoView({ block: "center" });
      document.querySelectorAll(".notice").forEach((n) => n.remove());
      return true;
    `);
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("559-phone-02-strength-row.png"));

    /* ---- (b) Change form with the live mismatch hint ---- */
    await evalClick(obsidian, '[data-testid="geode-settings-passphrase-change"]');
    const changeModal = obsidian.win.locator('.modal:has([data-testid="geode-rekey-current"])');
    await expect(changeModal).toBeVisible({ timeout: 15_000 });
    await evalSetValue(obsidian, '[data-testid="geode-rekey-current"]', PASSPHRASE);
    await evalSetValue(obsidian, '[data-testid="geode-rekey-new"]', NEW_PASSPHRASE);
    await evalSetValue(obsidian, '[data-testid="geode-rekey-confirm"]', `${NEW_PASSPHRASE}-nope`);
    await expect
      .poll(async () =>
        await obsidian.eval<string>(
          `document.querySelector('[data-testid="geode-rekey-form-error"]')?.textContent ?? ""`,
        ), { timeout: 10_000 }).toBe("New passphrases don't match.");
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    // Blur so the keyboard drops and the mismatch hint is visible in the shot.
    await obsidian.eval(`document.activeElement?.blur(); return true;`);
    await new Promise((r) => setTimeout(r, 600));
    await obsidian.screenshot(shotPath("559-phone-03-change-form-mismatch.png"));

    await evalSetValue(obsidian, '[data-testid="geode-rekey-confirm"]', NEW_PASSPHRASE);
    await expect
      .poll(async () =>
        await obsidian.eval<boolean>(
          `!document.querySelector('[data-testid="geode-rekey-continue"]')?.disabled`,
        ), { timeout: 10_000 }).toBe(true);

    /* ---- (c) Re-key form with the level dropdown ---- */
    await closeRekeyModal(obsidian);
    await new Promise((r) => setTimeout(r, 300));
    await evalClick(obsidian, '[data-testid="geode-settings-rekey"]');
    const rekeyModal = obsidian.win.locator('.modal:has([data-testid="geode-rekey-strength"])');
    await expect(rekeyModal).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () =>
        await obsidian.eval<string>(
          `document.querySelector('[data-testid="geode-rekey-strength"]')?.value ?? ""`,
        ), { timeout: 10_000 }).toBe("standard");
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await obsidian.eval(`document.activeElement?.blur(); return true;`);
    await new Promise((r) => setTimeout(r, 600));
    await obsidian.screenshot(shotPath("559-phone-04-rekey-form.png"));
    await closeRekeyModal(obsidian);
    await new Promise((r) => setTimeout(r, 300));

    /* ---- (d) Choose step: estimate + copy available ---- */
    await evalClick(obsidian, '[data-testid="geode-settings-passphrase-change"]');
    // Closed modals persist in the mobile DOM; the newest is last.
    const chooseModal = obsidian.win.locator('[data-testid="geode-rekey-modal"]').last();
    await expect(chooseModal).toBeVisible({ timeout: 15_000 });
    await evalSetValue(obsidian, '[data-testid="geode-rekey-current"]', PASSPHRASE);
    await evalSetValue(obsidian, '[data-testid="geode-rekey-new"]', NEW_PASSPHRASE);
    await evalSetValue(obsidian, '[data-testid="geode-rekey-confirm"]', NEW_PASSPHRASE);
    await evalClick(obsidian, '[data-testid="geode-rekey-continue"]');

    const estimateText = () =>
      obsidian.eval<string>(
        `document.querySelector('[data-testid="geode-rekey-estimate"]')?.textContent ?? ""`,
      );
    await expect.poll(estimateText, { timeout: 60_000 }).not.toBe("Estimating the time…");
    // Obsidian ToggleComponent disables via the is-disabled class, not the input's disabled attribute.
    const copyEnabled = () =>
      obsidian.eval<boolean>(
        `!document.querySelector('[data-testid="geode-rekey-copy"]')?.classList.contains("is-disabled")`,
      );
    await expect.poll(copyEnabled, { timeout: 30_000 }).toBe(true);
    console.log("PHONE ESTIMATE:", (await estimateText()).trim());
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("559-phone-05-choose.png"));

    /* ---- (f) Running: real re-key in copy mode, progress line ---- */
    await evalClick(obsidian, '[data-testid="geode-rekey-copy"]');
    await evalClick(obsidian, '[data-testid="geode-rekey-understood"]');
    await evalClick(obsidian, '[data-testid="geode-rekey-start"]');
    const progressText = () =>
      obsidian.eval<string>(
        `document.querySelector('[data-testid="geode-rekey-progress"]')?.textContent ?? ""`,
      );
    await expect.poll(progressText, { timeout: 60_000, intervals: [50] }).toMatch(/Rekeying \d+%/);
    console.log("PHONE PROGRESS:", (await progressText()).trim());
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("559-phone-06-running.png"));

    /* ---- (g) Paused ---- */
    await evalClick(obsidian, '[data-testid="geode-rekey-pause"]');
    await expect.poll(progressText, { timeout: 30_000 }).toBe("Rekey paused");
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("559-phone-07-paused.png"));
    await evalClick(obsidian, '[data-testid="geode-rekey-resume"]');

    /* ---- (h) Success ---- */
    await expect
      .poll(async () =>
        await obsidian.eval<string>(
          `document.querySelector('[data-testid="geode-rekey-success"]')?.textContent ?? ""`,
        ), { timeout: 120_000 }).toBe("Passphrase changed.");
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 400));
    await obsidian.screenshot(shotPath("559-phone-08-success.png"));
    await evalClick(obsidian, '[data-testid="geode-rekey-done"]');

    /* ---- Outcome: file reads back identical after the re-key ---- */
    const readBack = await obsidian.eval<string>(
      `app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(filePath)}))`,
    );
    expect(readBack, "file content after rekey").toBe(fileContent);
    await waitForStatusBar(obsidian.win, "Geode: synced", 90_000);

    /* ---- Log-ring oracle ---- */
    const errors = await obsidian.eval<Array<{ level: string; msg: string }>>(
      `app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === "error")`,
    );
    console.log(
      "=== PHONE LOG RING ERRORS ===\n" +
        (errors.length ? JSON.stringify(errors, null, 2) : "(none)") + "\n=== END ===",
    );
    expect(errors).toEqual([]);
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
