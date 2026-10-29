import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { writeVaultFile } from "../helpers/editor";
import { commitPath } from "../helpers/geode";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #593 (hybrid): a delete is never silently undone by a remote edit. The deleting
// device holds its delete behind the gated commit queue (the same state as the 2 s
// debounce: the op exists, the bytes are gone), the peer then edits the note; the edit
// is kept (#361) and the device that deleted records a visible
// "Restored after your delete" activity row instead of cancelling the delete behind the
// user's back. Both directions, so each device is the deleter once.
const PASSPHRASE = "delete-window-pass";
const PATH = "notes/delete-window.md";
const DELETED = "# delete me\nfirst body\n";
const EDITED_A = "# delete me\nedited on the other device, first round\n";
const EDITED_B = "# delete me\nedited on the other device, second round\n";

const MODAL = ".geode-activity-modal";
const ROW = `${MODAL} [data-testid="geode-activity-row"][data-path="${PATH}"]`;
const q = (value: string) => JSON.stringify(value);

type Device = {
  eval: <T>(js: string) => Promise<T>;
  screenshot: (label: string) => Promise<void>;
};

/** Delete on `deleter` while its queue is gated, edit on `editor`: the edit comes back
 * on the deleter, with a visible restore row. */
async function deleteOverridden(
  deleter: Device,
  editor: Device,
  edited: string,
  shot: string,
): Promise<void> {
  // Gate the queue: the delete op can be enqueued but never executed, so the peer's
  // edit always reaches the apply path first (the 2 s debounce behaves the same way).
  await deleter.eval(`app.plugins.plugins.geode.syncManager.pause(); return true;`);
  await deleter.eval(`
    const file = app.vault.getAbstractFileByPath(${q(PATH)});
    if (!file) throw new Error("the deleting device must hold the note first");
    await app.vault.delete(file);
    return true;
  `);
  await writeVaultFile(editor, PATH, edited);
  await commitPath(editor, PATH);

  await expect
    .poll(() => deleter.eval<boolean>(`return await app.vault.adapter.exists(${q(PATH)})`), {
      timeout: 60_000,
    })
    .toBe(true);
  expect(await deleter.eval<string>(`return await app.vault.adapter.read(${q(PATH)})`)).toBe(
    edited,
  );

  // The override is visible in the activity log, not just an on-disk side effect.
  await deleter.eval(`app.plugins.plugins.geode.openActivityModal(); return true;`);
  await expect
    .poll(
      () =>
        deleter.eval<string>(
          `const el = document.querySelector(${q(`${ROW} .geode-activity-desc`)});
           return el ? el.textContent : "";`,
        ),
      { timeout: 30_000 },
    )
    .toContain("Restored after your delete");
  await deleter.screenshot(shot);
  await deleter.eval(
    `document.querySelector(${q(`${MODAL} .modal-close-button`)})?.click(); return true;`,
  );

  // The winning edit already cancelled the held delete op (#593), so resuming drains
  // nothing and the edit stays on both devices.
  await deleter.eval(`
    await app.plugins.plugins.geode.syncManager.resume();
    await app.plugins.plugins.geode.syncManager.handlePendingOps([]);
    return true;
  `);
}

test("hybrid: a delete in the window is overridden visibly, not silently", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(300_000);

  const pair = await launchHybridPair({ passphrase: PASSPHRASE });
  const desktop = pair.A;
  const phone = pair.B;
  try {
    for (const device of [desktop, phone]) {
      await expect
        .poll(async () =>
          await device.eval<boolean>("return app.plugins.plugins.geode.isUnlockedCheck()")
        )
        .toBe(true);
      await waitForStatusBar(device, "Geode: synced", 60_000);
    }

    await writeVaultFile(desktop, PATH, DELETED);
    await commitPath(desktop, PATH);
    await waitForConvergence(desktop, phone, PATH, 60_000);

    // Desktop deletes, the phone edits: the desktop keeps the phone's edit and shows it.
    await deleteOverridden(desktop, phone, EDITED_A, "593-01-restored-desktop");
    expect(await waitForConvergence(desktop, phone, PATH, 60_000)).toBe(EDITED_A);

    // ...and the other way round, so the phone is the deleting device too. Each round
    // edits to new bytes: re-committing the same content is skipped, not a new version.
    await deleteOverridden(phone, desktop, EDITED_B, "593-02-restored-phone");
    expect(await waitForConvergence(desktop, phone, PATH, 60_000)).toBe(EDITED_B);
  } finally {
    await pair.stop();
  }
});
