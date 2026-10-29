import { expect, test } from "@playwright/test";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { launchPair } from "../fixtures/pair";
import { upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForConvergence, waitForStatusBar, waitForStatusBarAny } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

const PASSPHRASE = "data-loss-passphrase";
const FILE = "notes/revert.md";
const SERVER_CONTENT = "# Note\nSERVER ORIGINAL\n";
const LOCAL_EDIT = "# Note\nLOCAL UNSAVED EDIT: must not be lost\n";

async function takeScreenshot(
  inst: Awaited<ReturnType<typeof launchPair>>["A"],
  label: string,
  side: "A" | "B",
): Promise<void> {
  await inst.win.screenshot({
    path: shotPath(`${label}-${side}.png`),
    fullPage: true,
  });
}

async function listSiblingConflicts(vaultDir: string, vaultPath: string): Promise<string[]> {
  const parts = vaultPath.split("/");
  const fileName = parts.pop()!;
  const dirPath = path.join(vaultDir, ...parts);
  const stem = fileName.replace(/\.[^.]+$/, "");
  const ext = path.extname(fileName);
  const entries = await readdir(dirPath).catch(() => []);
  return entries
    .filter((entry) => entry.startsWith(`${stem} (conflict `) && entry.endsWith(ext))
    .map((entry) => [...parts, entry].join("/"));
}

async function showFileInEditor(
  inst: Awaited<ReturnType<typeof launchPair>>["A"],
  file: string,
): Promise<void> {
  await inst.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    const f = app.vault.getAbstractFileByPath(${JSON.stringify(file)});
    if (f) { const leaf = app.workspace.getLeaf(true); await leaf.openFile(f); }
    return true;
  `);
  await inst.win.waitForTimeout(800);
}

test("untracked local edit survives restart (no silent revert)", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    // --- Phase 1: Both devices synced ---
    await waitForUnlocked(pair.A);
    await waitForUnlocked(pair.B);
    await waitForStatusBar(pair.A.win, "Geode: synced", 60_000);
    await waitForStatusBar(pair.B.win, "Geode: synced", 60_000);

    // --- Phase 2: A creates the file and it syncs to B ---
    await upsertVaultFile(pair.A, FILE, SERVER_CONTENT);
    await waitForConvergence(pair.A, pair.B, FILE, 60_000);

    await showFileInEditor(pair.A, FILE);
    await takeScreenshot(pair.A, "dataloss-01-synced", "A");
    await showFileInEditor(pair.B, FILE);
    await takeScreenshot(pair.B, "dataloss-01-synced", "B");

    expect(
      await pair.B.eval(`await app.vault.adapter.read(${JSON.stringify(FILE)})`),
    ).toBe(SERVER_CONTENT);

    // --- Phase 3: Make an UNTRACKED local edit on B ---
    // Stop the event handler via lockVault, THEN write to disk so no pending op is recorded.
    await pair.B.eval("app.plugins.plugins.geode.lockVault()");
    await pair.B.eval(
      `await app.vault.adapter.write(${JSON.stringify(FILE)}, ${JSON.stringify(LOCAL_EDIT)})`,
    );

    // Confirm disk now has the local edit
    const beforeRestart = await pair.B.eval(
      `await app.vault.adapter.read(${JSON.stringify(FILE)})`,
    );
    expect(beforeRestart).toBe(LOCAL_EDIT);

    await showFileInEditor(pair.B, FILE);
    await takeScreenshot(pair.B, "dataloss-02-local-edit", "B");

    // --- Phase 4: Restart B's session (fresh state + replay) ---
    await pair.B.eval(
      `app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`,
    );
    await waitForUnlocked(pair.B);
    await waitForStatusBarAny(pair.B.win, ["Geode: synced", "conflict"], 60_000);
    await new Promise((r) => setTimeout(r, 3000));

    await showFileInEditor(pair.A, FILE);
    await takeScreenshot(pair.A, "dataloss-03-after-restart", "A");
    await showFileInEditor(pair.B, FILE);
    await takeScreenshot(pair.B, "dataloss-03-after-restart", "B");

    // --- Phase 5: Assert the bug (screenshots already captured) ---
    const after = await pair.B.eval(
      `await app.vault.adapter.read(${JSON.stringify(FILE)})`,
    );

    // Check for conflict files that might have preserved the local edit
    const conflictFiles = await listSiblingConflicts(pair.B.vaultDir, FILE);
    let conflictContents = "";
    if (conflictFiles.length > 0) {
      const contents = await Promise.all(
        conflictFiles.map(async (cf) => {
          const relPath = path.relative(pair.B.vaultDir, path.join(pair.B.vaultDir, cf));
          const content = await pair.B.eval(
            `await app.vault.adapter.read(${JSON.stringify(relPath.replace(/\\/g, "/"))})`,
          );
          return `${cf}:\n${content}`;
        }),
      );
      conflictContents = `\nConflict files found:\n${contents.join("\n")}`;
    }

    expect(
      after,
      `B local edit was overwritten by server version (data loss). Content after restart:\n${after}${conflictContents}`,
    ).toContain("LOCAL UNSAVED EDIT");

    // Also verify: if a conflict file was created, it should contain the local edit
    // (acceptable correct behavior: conflict preserves both versions)
    if (conflictFiles.length > 0) {
      const conflictContent = await pair.B.eval(
        `await app.vault.adapter.read(${JSON.stringify(conflictFiles[0].replace(/\\/g, "/"))})`,
      );
      expect(
        conflictContent,
        `Conflict file should preserve local edit. Content:\n${conflictContent}`,
      ).toContain("LOCAL UNSAVED EDIT");
    }
  } finally {
    await pair.stop();
  }
});
