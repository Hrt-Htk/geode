// A rename applied on this device must not close the note its user has open: the tab
// follows the new name and nothing typed through the apply is lost. Two real desktop
// clients on a throwaway server; B renames through the vault API while A keeps typing.
import { expect, test } from "@playwright/test";
import { launchPair } from "../fixtures/pair";
import { activeEditorPath, readVaultTextIfPresent, writeVaultFile } from "../helpers/editor";
import { commitPath, waitForUnlocked } from "../helpers/geode";
import { shotPath } from "../helpers/shots";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "rename-keeps-open-editor";
const OLD = "Untitled.md";
const NEW = "Ggf fhj.md";
const TYPED_BEFORE = "typing ";
const TYPED_THROUGH_APPLY = "and the peer renames this note while i keep typing in it";

test("a rename applied while the note is open keeps the editor and its typing", async () => {
  test.slow();
  const pair = await launchPair({
    passphrase: PASSPHRASE,
    settings: { syncObsidianConfig: false },
  });
  const { A, B } = pair;
  try {
    await waitForUnlocked(A);
    await waitForUnlocked(B);
    await waitForStatusBar(A.win, "Geode: synced", 60_000);
    await waitForStatusBar(B.win, "Geode: synced", 60_000);

    await writeVaultFile(A, OLD, "phone note\n");
    await commitPath(A, OLD);
    await waitForConvergence(A, B, OLD, 60_000);

    // A opens the note and its user types in it with the real keyboard.
    await A.eval(`
      await app.workspace.getLeaf(true).openFile(app.vault.getFileByPath(${JSON.stringify(OLD)}));
      return true;
    `);
    await A.win.click(".cm-content");
    await A.win.keyboard.type(TYPED_BEFORE);
    await expect.poll(() => readVaultTextIfPresent(A, OLD)).toContain(TYPED_BEFORE);
    await A.win.screenshot({ path: shotPath("before-rename") });

    // Keep typing straight through the apply: the race under test.
    const typing = A.win.keyboard.type(TYPED_THROUGH_APPLY, { delay: 120 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const renaming = B.eval(`
      await app.vault.rename(app.vault.getFileByPath(${JSON.stringify(OLD)}), ${
      JSON.stringify(NEW)
    });
      return true;
    `);
    // The apply has landed on A: the old name is gone from its vault.
    await expect
      .poll(
        () => A.eval<boolean>(`!app.vault.getAbstractFileByPath(${JSON.stringify(OLD)})`),
        { timeout: 90_000 },
      )
      .toBe(true);
    await renaming;
    await typing;
    await A.win.screenshot({ path: shotPath("after-apply") });

    // 1. The open tab follows the new name instead of dropping to "No file".
    await expect
      .poll(() => activeEditorPath(A), {
        timeout: 60_000,
        message: "A's active tab follows the rename",
      })
      .toBe(NEW);

    // 2. Every character typed ends up in the new file: here and on the other device.
    const typed = TYPED_BEFORE + TYPED_THROUGH_APPLY;
    await expect
      .poll(() => readVaultTextIfPresent(A, NEW), {
        timeout: 60_000,
        message: "A's new file holds the typing",
      })
      .toContain(typed);
    await expect
      .poll(() => readVaultTextIfPresent(B, NEW), {
        timeout: 90_000,
        message: "B's new file holds the typing",
      })
      .toContain(typed);

    expect(await A.consoleErrors()).toEqual([]);
    expect(await B.consoleErrors()).toEqual([]);
  } finally {
    await pair.stop();
  }
});
