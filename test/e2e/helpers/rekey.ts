import { expect, type Page } from "@playwright/test";
import type { SyncDevice } from "./device-abstraction";
import { commitPath, upsertVaultFile, waitForUnlocked } from "./geode";
import { evalClick, evalSetValue, type MobileUI } from "./mobile-ui";
import { readGeodeStatusBar } from "./waits";

/** Deterministic seed content (~3 MB each) so specs can prove byte-identical
 * reads after a re-key. */
export function seedContent(): string {
  const line = `seed line ${"x".repeat(90)}\n`;
  const lines = Math.ceil((3000 * 1024) / line.length);
  return Array.from({ length: lines }, (_, n) => `${n} ${line}`).join("");
}

/** Seed real files so the re-key has real blobs to re-encrypt and its running
 * state is catchable (a tiny vault re-keys in <1 s). */
export async function seedFiles(device: SyncDevice, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await upsertVaultFile(device, `seed-${i}.md`, seedContent());
  }
  await commitPath(device, `seed-${count}.md`);
}

const present = (d: MobileUI, sel: string) =>
  d.eval<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = (d: MobileUI, sel: string) =>
  d.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? ""`);

/** Every seeded file reads back byte-identical (the vault is not mixed-key). */
export async function assertSeedFilesReadBack(
  device: SyncDevice,
  n: number,
  label = "after the switch",
): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const readBack = await device.eval<string>(
      `app.vault.read(app.vault.getAbstractFileByPath(${JSON.stringify(`seed-${i}.md`)}))`,
    );
    expect(readBack, `seed file ${i} ${label}`).toBe(seedContent());
  }
}

/** Log oracle: the device's recent log must have no error entries. */
export async function assertNoLogErrors(device: SyncDevice, label = "LOG ERRORS"): Promise<void> {
  const errors = await device.eval<Array<{ level: string; msg: string }>>(
    `app.plugins.plugins.geode.getRecentLog().filter((e) => e.level === "error")`,
  );
  console.log(`=== ${label} ===\n` + (errors.length ? JSON.stringify(errors, null, 2) : "(none)"));
  expect(errors).toEqual([]);
}

/** Open the settings tab and drive the change-passphrase form → choose step →
 * Start, in the given mode. In-page eval, so it works on desktop and phone. */
export async function startRekeyRun(
  device: SyncDevice,
  current: string,
  next: string,
  mode: "copy" | "replace",
): Promise<void> {
  const d = device as unknown as MobileUI;
  await d.eval(`
    app.setting.open();
    app.setting.openTabById("geode");
    return true;
  `);
  await evalClick(d, '[data-testid="geode-settings-passphrase-change"]');
  await expect.poll(() => present(d, '[data-testid="geode-rekey-current"]'), { timeout: 15_000 })
    .toBe(true);
  await evalSetValue(d, '[data-testid="geode-rekey-current"]', current);
  await evalSetValue(d, '[data-testid="geode-rekey-new"]', next);
  await evalSetValue(d, '[data-testid="geode-rekey-confirm"]', next);
  await evalClick(d, '[data-testid="geode-rekey-continue"]');

  // Choose step: wait for the estimate, pick the mode, confirm, start.
  await expect.poll(() => text(d, '[data-testid="geode-rekey-estimate"]'), { timeout: 60_000 }).not
    .toBe(
      "Estimating the time…",
    );
  if (mode === "copy") {
    // Copy is server-gated (free space); replace is never disabled.
    await expect
      .poll(
        () =>
          d.eval<string>(
            `document.querySelector('[data-testid="geode-rekey-copy"]')?.className ?? ""`,
          ),
        {
          timeout: 15_000,
        },
      )
      .not.toContain("is-disabled");
  }
  await evalClick(d, `[data-testid="geode-rekey-${mode}"]`);
  await evalClick(d, '[data-testid="geode-rekey-understood"]');
  await expect
    .poll(
      () =>
        d.eval<boolean>(
          `!document.querySelector('[data-testid="geode-rekey-start"]')?.hasAttribute("disabled")`,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await evalClick(d, '[data-testid="geode-rekey-start"]');
}

/** Poll until the run's progress line shows blob work ("Rekeying N%"). */
export async function waitForRekeyProgress(device: SyncDevice): Promise<string> {
  const d = device as unknown as MobileUI;
  await expect
    .poll(() => text(d, '[data-testid="geode-rekey-progress"]'), {
      timeout: 120_000,
      intervals: [50],
    })
    .toMatch(/Rekeying \d+%/);
  return (await text(d, '[data-testid="geode-rekey-progress"]'))!;
}

/** Wait for the run's success view and close it. */
export async function waitForRekeySuccess(device: SyncDevice): Promise<void> {
  const d = device as unknown as MobileUI;
  await expect
    .poll(() => text(d, '[data-testid="geode-rekey-success"]'), { timeout: 600_000 })
    .toBe("Passphrase changed.");
  await evalClick(d, '[data-testid="geode-rekey-done"]');
  await expect.poll(() => present(d, '[data-testid="geode-rekey-success"]'), { timeout: 10_000 })
    .toBe(false);
}

/** Drive the desktop's change-passphrase → copy re-key through the real modal
 * to the success view. */
export async function runRekeyCopy(
  desktop: SyncDevice,
  current: string,
  next: string,
): Promise<void> {
  await startRekeyRun(desktop, current, next, "copy");
  await waitForRekeySuccess(desktop);
}

/** Resume a killed run through the real modal: on a saved cursor the modal
 * opens in the resume form; re-enter the passphrases, submit, wait for success. */
export async function resumeRekeyRun(
  device: SyncDevice,
  current: string,
  next: string,
): Promise<void> {
  const d = device as unknown as MobileUI;
  await d.eval(`
    app.setting.open();
    app.setting.openTabById("geode");
    return true;
  `);
  await evalClick(d, '[data-testid="geode-settings-passphrase-change"]');
  await expect
    .poll(() => present(d, '[data-testid="geode-rekey-resume-title"]'), { timeout: 15_000 })
    .toBe(true);
  await evalSetValue(d, '[data-testid="geode-rekey-resume-current"]', current);
  await evalSetValue(d, '[data-testid="geode-rekey-resume-new"]', next);
  await expect
    .poll(
      () =>
        d.eval<boolean>(
          `!document.querySelector('[data-testid="geode-rekey-resume-submit"]')?.disabled`,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
  await evalClick(d, '[data-testid="geode-rekey-resume-submit"]');
  // An open cursor reopens the run PAUSED (by design): press Resume to run it.
  await expect
    .poll(() => text(d, '[data-testid="geode-rekey-progress"]'), { timeout: 15_000 })
    .toBe("Rekey paused");
  await evalClick(d, '[data-testid="geode-rekey-resume"]');
  await waitForRekeySuccess(d);
}

const WRONG_PASSPHRASE = "That passphrase doesn't match this vault.";

/** The switch landed: lock, prove the old passphrase fails, unlock with the
 * new one through the real unlock modal. In-page eval, so it works on desktop
 * and phone (Playwright locator actions hang on mobile modals). */
export async function assertSwitchLanded(
  inst: { eval: <T>(jsExpr: string) => Promise<T>; win: Page },
  oldPass: string,
  newPass: string,
): Promise<void> {
  await inst.eval(`app.plugins.plugins.geode.lockVault(); return true;`);
  await expect.poll(async () => await readGeodeStatusBar(inst.win), { timeout: 15_000 }).toBe(
    "Geode: locked",
  );
  await inst.eval(`app.commands.executeCommandById("geode:geode-unlock"); return true;`);
  const d = inst as unknown as MobileUI;
  await expect.poll(() => present(d, '[data-testid="geode-passphrase-input"]'), { timeout: 10_000 })
    .toBe(true);

  await evalSetValue(d, '[data-testid="geode-passphrase-input"]', oldPass);
  await evalClick(d, '[data-testid="geode-passphrase-submit"]');
  await expect
    .poll(() => text(d, '[data-testid="geode-passphrase-error"]'), { timeout: 15_000 })
    .toBe(WRONG_PASSPHRASE);
  await expect.poll(() => present(d, '[data-testid="geode-passphrase-input"]'), { timeout: 10_000 })
    .toBe(true);

  await evalSetValue(d, '[data-testid="geode-passphrase-input"]', newPass);
  await evalClick(d, '[data-testid="geode-passphrase-submit"]');
  await waitForUnlocked(inst, 60_000);
}
