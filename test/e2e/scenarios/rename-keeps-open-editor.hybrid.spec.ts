// #697: applying a rename moves the file with the vault's own rename, so the note this
// device has open follows the new name instead of dropping to "No file", and nothing typed
// through the apply is lost. Both directions: the phone holds the open note while the
// desktop renames, and the desktop holds it while the phone renames.
import { expect, test } from "@playwright/test";
import { activeEditorPath, readVaultTextIfPresent } from "../helpers/editor";
import { launchSyncedPair, renameInVault, seedNote } from "../helpers/rename-links";

const PASSPHRASE = "rename-keeps-open-editor";
const OLD = "Untitled.md";
const NEW = "Ggf fhj.md";
const TYPED_BEFORE = "typing ";
const TYPED_THROUGH_APPLY = "and the peer renames this note while i keep typing in it";

/** Append one character through the CodeMirror API of the ACTIVE editor: CDP keystrokes do
 * not reach the mobile editor, and earlier specs leave other markdown leaves around (#695
 * probe). Throws once the editor is gone, like a lost keypress. */
const appendChar = (ch: string) => `
  const view = app.workspace.activeLeaf?.view;
  if (!view?.editor) throw new Error("no active markdown editor");
  const line = view.editor.lineCount() - 1;
  view.editor.setCursor({ line, ch: view.editor.getLine(line).length });
  view.editor.replaceSelection(${JSON.stringify(ch)});
  return true;
`;

for (const phoneTypes of [true, false]) {
  const role = phoneTypes ? "phone types, desktop renames" : "desktop types, phone renames";

  test(`an applied rename keeps the open note and its typing (${role})`, async () => {
    test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
    test.slow();

    // A is the phone when it types and the desktop when it renames: the typing device is
    // always A, so the second direction puts the keyboard on the desktop (item 5).
    const pair = await launchSyncedPair(PASSPHRASE, phoneTypes);
    const typer = pair.A;
    const renamer = pair.B;
    const side = phoneTypes ? "phone" : "desktop";
    try {
      await seedNote(pair.A, pair.B, OLD, "phone note\n");
      await typer.eval(`
        const leaf = app.workspace.getLeaf(true);
        await leaf.openFile(app.vault.getFileByPath(${JSON.stringify(OLD)}));
        app.workspace.setActiveLeaf(leaf, { focus: true });
        return true;
      `);
      await expect
        .poll(() => activeEditorPath(typer), {
          timeout: 30_000,
          message: "the note is the open tab",
        })
        .toBe(OLD);
      if (!phoneTypes) await typer.win.click(".cm-content");
      const typeChar = (ch: string) =>
        phoneTypes ? typer.eval(appendChar(ch)) : typer.win.keyboard.type(ch, { delay: 20 });

      for (const ch of TYPED_BEFORE) await typeChar(ch);
      await expect.poll(() => readVaultTextIfPresent(typer, OLD)).toContain(TYPED_BEFORE);
      await typer.screenshot(`697-before-rename-${side}.png`);

      // Type straight through the apply, one character at a time.
      const dropped: string[] = [];
      const typing = (async () => {
        for (const ch of TYPED_THROUGH_APPLY) {
          try {
            await typeChar(ch);
          } catch {
            dropped.push(ch);
          }
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const renaming = renameInVault(renamer, OLD, NEW);
      await expect
        .poll(
          () => typer.eval<boolean>(`!app.vault.getAbstractFileByPath(${JSON.stringify(OLD)})`),
          {
            timeout: 120_000,
          },
        )
        .toBe(true);
      await renaming;
      await typing;
      await typer.screenshot(`697-after-apply-${side}.png`);

      // The open tab follows the new name instead of dropping to "No file".
      await expect
        .poll(() => activeEditorPath(typer), {
          timeout: 60_000,
          message: "the tab follows the rename",
        })
        .toBe(NEW);

      const typed = TYPED_BEFORE + TYPED_THROUGH_APPLY;
      expect(dropped.join("")).toBe("");
      await expect
        .poll(() => readVaultTextIfPresent(typer, NEW), {
          timeout: 60_000,
          message: "typing kept on this device",
        })
        .toContain(typed);
      await expect
        .poll(() => readVaultTextIfPresent(renamer, NEW), {
          timeout: 120_000,
          message: "typing reached the peer",
        })
        .toContain(typed);
      expect(await typer.consoleErrors()).toEqual([]);
      expect(await renamer.consoleErrors()).toEqual([]);
    } finally {
      await pair.stop();
    }
  });
}
