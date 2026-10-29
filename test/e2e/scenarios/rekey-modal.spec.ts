import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { launchObsidian, TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #559: the change-passphrase / re-key modal, driven through the real UI
// (settings rows → buttons → modal phases) in real Obsidian. Test 1 runs a
// real change re-key end to end (copy mode) and asserts the outcome: the new
// passphrase unlocks, the old one fails, and a file reads back identical.
// Test 2 points the server at a small tmpfs so the choose step shows copy
// BLOCKED with the #558 space reason.
const PASSPHRASE = "rekey-modal-pass";
const NEW_PASSPHRASE = "rekey-modal-new-pass";
const WRONG_PASSPHRASE = "That passphrase doesn't match this vault.";

const NOTE_SEED = "rekey modal note";

function noteContent(seed: number, kb: number): string {
  const line = `${NOTE_SEED} ${seed} ${"x".repeat(60)}\n`;
  const lines = Math.ceil((kb * 1024) / line.length);
  return Array.from({ length: lines }, (_, i) => `${i} ${line}`).join("");
}

async function openSettingsTab(o: { eval: <T>(s: string) => Promise<T> }): Promise<void> {
  await o.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    app.setting.open();
    app.setting.openTabById("geode");
    return true;
  `);
}

async function clearNotices(o: { eval: <T>(s: string) => Promise<T> }): Promise<void> {
  await o.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
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

/** A row's description fits on one line: height within 1.6x of its line height. */
async function fitsOneLine(
  o: { eval: <T>(s: string) => Promise<T> },
  sel: string,
): Promise<boolean> {
  return await o.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
    return el.offsetHeight <= lh * 1.6;
  })()`);
}

test("rekey modal surfaces + real change-passphrase run", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("rekey-modal");
  // #675: the seeded vault needs its re-key auth hash, as a real create/join registers it.
  await server.registerAuthHash(device.token, PASSPHRASE, TEST_ARGON2_PARAMS);
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

    // ~24 MB of real files: the re-key run takes several seconds, so the
    // running and paused states are both catchable.
    const fileContents: [string, string][] = [];
    for (let i = 1; i <= 4; i++) {
      const content = noteContent(i, 6000);
      fileContents.push([`note-${i}.md`, content]);
      await upsertVaultFile(o, `note-${i}.md`, content);
    }
    await waitForVaultBytes(server, device.token, 20_000_000);

    /* ---- (a) Settings rows: Passphrase (Vault) + Encryption strength (Advanced) ---- */
    await openSettingsTab(o);
    const passphraseRow = o.win.locator('[data-testid="geode-settings-passphrase"]');
    await expect(passphraseRow).toBeVisible({ timeout: 15_000 });
    await expect(passphraseRow.locator(".setting-item-name")).toHaveText("Passphrase");
    await expect(passphraseRow.locator(".setting-item-description")).toHaveText(
      "The passphrase that unlocks this vault.",
    );
    await expect(passphraseRow.locator('[data-testid="geode-settings-passphrase-change"]'))
      .toHaveText("Change…");

    // Advanced is collapsed by default; expand it for the strength row.
    await o.win.locator(".geode-advanced-heading").click();
    const strengthRow = o.win.locator('[data-testid="geode-settings-encryption-strength"]');
    await expect(strengthRow).toBeVisible({ timeout: 15_000 });
    await expect(strengthRow.locator(".setting-item-name")).toHaveText("Encryption strength");
    // The test vault's argon2 params (ops 1, 8 MB) are not a wizard level: "Custom".
    await expect(strengthRow.locator(".setting-item-description")).toHaveText("Custom");
    await expect(strengthRow.locator('[data-testid="geode-settings-rekey"]')).toHaveText("Rekey…");

    await o.win.locator('[data-testid="geode-settings-passphrase"]').evaluate((el) =>
      el.scrollIntoView({ block: "center" })
    );
    await clearNotices(o);
    await o.win.waitForTimeout(300);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("559-01-passphrase-row.png"),
    });

    await o.win.locator('[data-testid="geode-settings-encryption-strength"]').evaluate((el) =>
      el.scrollIntoView({ block: "center" })
    );
    await o.win.waitForTimeout(300);
    await o.win.locator(".vertical-tab-content").screenshot({
      path: shotPath("559-02-strength-row.png"),
    });

    /* ---- (b) Change form with the live mismatch hint ---- */
    await o.win.locator('[data-testid="geode-settings-passphrase-change"]').click();
    const changeModal = o.win.locator('.modal:has([data-testid="geode-rekey-current"])');
    await expect(changeModal).toBeVisible({ timeout: 10_000 });
    const currentInput = changeModal.locator('[data-testid="geode-rekey-current"]');
    const newInput = changeModal.locator('[data-testid="geode-rekey-new"]');
    const confirmInput = changeModal.locator('[data-testid="geode-rekey-confirm"]');
    const formError = changeModal.locator('[data-testid="geode-rekey-form-error"]');
    const continueBtn = changeModal.locator('[data-testid="geode-rekey-continue"]');

    await currentInput.fill(PASSPHRASE);
    await newInput.fill(NEW_PASSPHRASE);
    await confirmInput.fill(`${NEW_PASSPHRASE}-nope`);
    await expect(formError).toHaveText("New passphrases don't match.");
    await expect(continueBtn).toBeDisabled();
    await clearNotices(o);
    await changeModal.screenshot({ path: shotPath("559-03-change-form-mismatch.png") });

    await confirmInput.fill(NEW_PASSPHRASE);
    await expect(formError).toHaveText("");
    await expect(continueBtn).toBeEnabled();

    /* ---- (c) Re-key form with the level dropdown ---- */
    await o.win.keyboard.press("Escape");
    await expect(changeModal).not.toBeVisible({ timeout: 10_000 });
    await o.win.locator('[data-testid="geode-settings-rekey"]').click();
    const rekeyModal = o.win.locator('.modal:has([data-testid="geode-rekey-strength"])');
    await expect(rekeyModal).toBeVisible({ timeout: 10_000 });
    await expect(rekeyModal.locator(".modal-title")).toHaveText("Rekey vault");
    const strengthSelect = rekeyModal.locator('[data-testid="geode-rekey-strength"]');
    await expect(strengthSelect).toHaveValue("standard");
    const options = await strengthSelect.locator("option").allTextContents();
    expect(options).toEqual(["Lower", "Standard (default)", "Higher"]);
    await clearNotices(o);
    await rekeyModal.screenshot({ path: shotPath("559-04-rekey-form.png") });
    await o.win.keyboard.press("Escape");
    await expect(rekeyModal).not.toBeVisible({ timeout: 10_000 });

    /* ---- (d) Choose step: estimate + copy available ---- */
    await o.win.locator('[data-testid="geode-settings-passphrase-change"]').click();
    const chooseModal = o.win.locator('[data-testid="geode-rekey-modal"]');
    await expect(chooseModal).toBeVisible({ timeout: 10_000 });
    await chooseModal.locator('[data-testid="geode-rekey-current"]').fill(PASSPHRASE);
    await chooseModal.locator('[data-testid="geode-rekey-new"]').fill(NEW_PASSPHRASE);
    await chooseModal.locator('[data-testid="geode-rekey-confirm"]').fill(NEW_PASSPHRASE);
    await chooseModal.locator('[data-testid="geode-rekey-continue"]').click();

    const estimate = chooseModal.locator('[data-testid="geode-rekey-estimate"]');
    await expect
      .poll(async () => await estimate.textContent(), { timeout: 30_000 })
      .not.toBe("Estimating the time…");
    const copyToggle = chooseModal.locator('[data-testid="geode-rekey-copy"]');
    // Obsidian ToggleComponent disables via the is-disabled class + a component flag,
    // never the input's disabled attribute.
    await expect
      .poll(
        async () =>
          await chooseModal.locator('[data-testid="geode-rekey-copy"]').getAttribute("class"),
        { timeout: 15_000 },
      )
      .not.toContain("is-disabled");
    await expect(chooseModal.locator('[data-testid="geode-rekey-warning"]')).toHaveText(
      "Your server copy will be encrypted again and every other device will enter the new passphrase. Your local notes are not affected.",
    );
    await clearNotices(o);
    await chooseModal.screenshot({ path: shotPath("559-05-choose.png") });
    console.log("ESTIMATE:", (await estimate.textContent())?.trim());
    // #569: the live probe yields a finite estimate on a local server.
    await expect(estimate).toHaveText(/^About /);
    // #571: every estimate step lands in the copyable log export.
    const estimateLog = await o.win.evaluate(() =>
      (window as any).app.plugins.plugins.geode.exportLog().split("\n").filter((l: string) =>
        l.includes("rekey estimate:")
      )
    );
    console.log("ESTIMATE LOG:\n" + estimateLog.join("\n"));
    for (
      const step of [
        "start",
        "storage",
        "file list",
        "trash",
        "file histories done",
        "speed test",
        "result",
        "done",
      ]
    ) {
      expect(estimateLog.some((l: string) => l.includes(`rekey estimate: ${step} `))).toBe(true);
    }

    /* ---- (f) Running: real re-key in copy mode, progress line ---- */
    await copyToggle.click();
    await chooseModal.locator('[data-testid="geode-rekey-understood"]').click();
    const startBtn = chooseModal.locator('[data-testid="geode-rekey-start"]');
    await expect(startBtn).toBeEnabled();
    await startBtn.click();

    const runView = o.win.locator('.modal:has([data-testid="geode-rekey-progress"])');
    await expect(runView).toBeVisible({ timeout: 10_000 });
    const progress = runView.locator('[data-testid="geode-rekey-progress"]');
    await expect
      .poll(async () => (await progress.textContent()) ?? "", { timeout: 30_000, intervals: [20] })
      .toMatch(/Rekeying \d+%/);
    await expect(runView.locator('[data-testid="geode-rekey-keep-open"]')).toHaveText(
      "Keep the app open until it finishes.",
    );
    await clearNotices(o);
    await runView.screenshot({ path: shotPath("559-06-running.png") });
    console.log("PROGRESS:", (await progress.textContent())?.trim());

    /* ---- (g) Paused ---- */
    await runView.locator('[data-testid="geode-rekey-pause"]').click();
    await expect(progress).toHaveText("Rekey paused", { timeout: 15_000 });
    await expect(runView.locator('[data-testid="geode-rekey-resume"]')).toBeVisible();
    await clearNotices(o);
    await runView.screenshot({ path: shotPath("559-07-paused.png") });
    await runView.locator('[data-testid="geode-rekey-resume"]').click();

    /* ---- (h) Success ---- */
    const successView = o.win.locator('.modal:has([data-testid="geode-rekey-success"])');
    await expect(successView).toBeVisible({ timeout: 180_000 });
    await expect(successView.locator('[data-testid="geode-rekey-success"]')).toHaveText(
      "Passphrase changed.",
    );
    await expect(successView.locator('[data-testid="geode-rekey-success-sub"]')).toHaveText(
      "Your other devices will ask for it.",
    );
    await clearNotices(o);
    await successView.screenshot({ path: shotPath("559-08-success.png") });
    await successView.locator('[data-testid="geode-rekey-done"]').click();
    await expect(successView).not.toBeVisible({ timeout: 10_000 });

    /* ---- Outcome: file reads back identical ---- */
    for (const [filePath, content] of fileContents) {
      const readBack = await o.eval<string>(
        `app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(filePath)}))`,
      );
      expect(readBack, `${filePath} content after rekey`).toBe(content);
    }

    /* ---- Outcome: old passphrase fails, new one unlocks ---- */
    await o.eval(`app.plugins.plugins.geode.lockVault(); return true;`);
    await expect.poll(async () => await readGeodeStatusBar(o.win), { timeout: 15_000 }).toBe(
      "Geode: locked",
    );
    await o.eval(`app.commands.executeCommandById("geode:geode-unlock"); return true;`);
    const unlockModal = o.win.locator('.modal:has([data-testid="geode-passphrase-input"])');
    await expect(unlockModal).toBeVisible({ timeout: 10_000 });
    const passInput = unlockModal.locator('[data-testid="geode-passphrase-input"]');
    const passSubmit = unlockModal.locator('[data-testid="geode-passphrase-submit"]');

    await passInput.fill(PASSPHRASE);
    await passSubmit.click();
    await expect(unlockModal.locator('[data-testid="geode-passphrase-error"]')).toHaveText(
      WRONG_PASSPHRASE,
    );
    await expect(unlockModal).toBeVisible(); // the old passphrase did not unlock

    await passInput.fill(NEW_PASSPHRASE);
    await passSubmit.click();
    await expect(unlockModal).not.toBeVisible({ timeout: 30_000 });
    await waitForStatusBar(o.win, "Geode: synced", 60_000);

    /* ---- Log-ring oracle ---- */
    const errors = await o.eval<Array<{ level: string; msg: string }>>(
      `app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === "error")`,
    );
    console.log(
      "=== LOG RING ERRORS ===\n" + (errors.length ? JSON.stringify(errors, null, 2) : "(none)") +
        "\n=== END ===",
    );
    expect(errors).toEqual([]);
    expect(o.consoleErrors()).toEqual([]);
  } finally {
    await o.close();
    await server.stop?.();
  }
});

test("choose step: copy blocked on a small-disk server", async () => {
  test.slow();

  // The server's data dir lives on a 2.4 MB tmpfs: the DB + WAL (~270 KB) and
  // the vault's blobs (~1.5 MB) fit, but the free space left after the upload
  // is far below the copy requirement (vault size + 10%), so the choose step
  // blocks copy with the #558 reason.
  const smallDir = path.join(tmpdir(), "geode-e2e-smallfs");
  await rm(smallDir, { recursive: true, force: true });
  await mkdir(smallDir, { recursive: true });
  const mount = spawnSync("sudo", ["mount", "-t", "tmpfs", "-o", "size=2500k", "tmpfs", smallDir], {
    encoding: "utf-8",
  });
  if (mount.status !== 0) {
    throw new Error(`tmpfs mount failed (needs sudo): ${mount.stderr?.trim()}`);
  }

  const server = await startServer({ dataDir: smallDir });
  const device = await server.mintToken("copy-blocked");
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

    for (let i = 1; i <= 15; i++) {
      await upsertVaultFile(o, `small-${i}.md`, noteContent(i, 100));
    }
    await waitForVaultBytes(server, device.token, 1_400_000);

    await openSettingsTab(o);
    await o.win.locator('[data-testid="geode-settings-passphrase-change"]').click();
    const modal = o.win.locator('[data-testid="geode-rekey-modal"]');
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await modal.locator('[data-testid="geode-rekey-current"]').fill(PASSPHRASE);
    await modal.locator('[data-testid="geode-rekey-new"]').fill(NEW_PASSPHRASE);
    await modal.locator('[data-testid="geode-rekey-confirm"]').fill(NEW_PASSPHRASE);
    await modal.locator('[data-testid="geode-rekey-continue"]').click();

    const estimate = modal.locator('[data-testid="geode-rekey-estimate"]');
    await expect
      .poll(async () => await estimate.textContent(), { timeout: 30_000 })
      .not.toBe("Estimating the time…");
    const copyToggle = modal.locator('[data-testid="geode-rekey-copy"]');
    // Obsidian ToggleComponent disables via the is-disabled class + a component flag,
    // never the input's disabled attribute.
    await expect(copyToggle).toHaveClass(/is-disabled/, { timeout: 15_000 });
    const copyRow = modal.locator('.setting-item:has([data-testid="geode-rekey-copy"])');
    const copyDesc = await copyRow.locator(".setting-item-description").textContent();
    expect(copyDesc).toMatch(
      /Not enough free space on the server\. Rekeying needs about .+ free\./,
    );
    // Replace stays available: the run stays startable without copy.
    await expect(modal.locator('[data-testid="geode-rekey-replace"]')).not.toHaveClass(
      /is-disabled/,
    );
    // Behavioral: clicking the blocked copy toggle does nothing, so Start stays disabled.
    await copyToggle.click();
    await modal.locator('[data-testid="geode-rekey-understood"]').click();
    await expect(modal.locator('[data-testid="geode-rekey-start"]')).toBeDisabled();
    expect(
      await fitsOneLine(o, '.modal [data-testid="geode-rekey-choose"] .setting-item-description'),
    ).toBe(true);
    console.log("COPY BLOCKED REASON:", copyDesc?.trim());

    await clearNotices(o);
    await modal.screenshot({ path: shotPath("559-09-choose-copy-blocked.png") });
  } finally {
    await o.close();
    await server.stop?.();
    for (let i = 0; i < 5; i++) {
      const um = spawnSync("sudo", ["umount", smallDir], { encoding: "utf-8" });
      if (um.status === 0) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    await rm(smallDir, { recursive: true, force: true });
  }
});
