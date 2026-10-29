// Level 0 single-device sanity campaign: desktop (Electron) real-Obsidian spec.
//
// ASSUMPTIONS (harness detail):
//  - The e2e fixtures (`launchPair`/`launchObsidian`) create a FRESH mkdtemp vault
//    each launch and expose no "relaunch on the same vault" primitive (no shared
//    vaultDir reuse). A true OS process-kill + relaunch therefore cannot yet be
//    expressed here. Following the existing `data-loss-revert-on-restart.spec.ts`
//    pattern, each "restart" step below is modeled as `lockVault()` + `unlockVault()`
//    (a state re-session): lock clears the in-memory runtime, unlock reloads the
//    persisted-on-disk state (local files + sync cursor + version cache) through the
//    same `openState()` path a real process restart uses. Swap these for a process
//    kill/relaunch on a preserved vaultDir once that fixture exists.
//  - 0b's "kill before the debounce/push" assumes `lockVault()` is issued before any
//    debounce-timer push fires; the durable assertions (content survived + propagated,
//    no conflict) hold regardless of whether the write captured a pending op.
//  - Parent-chain correctness is asserted at the driver level (0c driver test + server
//    invariants); the real-app layer asserts the change propagated (a new version was
//    committed) and no conflict file was produced.
import { expect, test } from "@playwright/test";
import { launchPair } from "../fixtures/pair";
import { readVaultFile, writeVaultFile } from "../helpers/editor";
import { upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForContent, waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "level0-single-device-passphrase";
const FOLDERS = [
  { path: "Inbox/test1.md", content: "# one\n" },
  { path: "Projects/test2.md", content: "# two\n" },
  { path: "Reference/test3.md", content: "# three\n" },
];

async function commit(
  inst: Awaited<ReturnType<typeof launchPair>>["A"],
  paths: string[],
): Promise<void> {
  await inst.eval(`
    await app.plugins.plugins.geode.syncManager.handlePendingOps(
      ${JSON.stringify(paths.map((path) => ({ path, kind: "commit" })))},
    );
    return true;
  `);
}

async function relaunch(inst: Awaited<ReturnType<typeof launchPair>>["A"]): Promise<void> {
  // The eval wrapper awaits the returned promise, so unlockVault() completes here.
  await inst.eval("app.plugins.plugins.geode.lockVault()");
  await inst.eval(`app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`);
  await waitForUnlocked(inst);
}

function lastSeenSeq(inst: Awaited<ReturnType<typeof launchPair>>["A"]): Promise<number> {
  return inst.eval<number>("app.plugins.plugins.geode.getLastSeenSeq()");
}

async function conflictPaths(inst: Awaited<ReturnType<typeof launchPair>>["A"]): Promise<string[]> {
  return await inst.eval<string[]>(
    `app.vault.getFiles().filter((f) => /(\.conflict-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}|\(conflict .+? \d{4}-\d{2}-\d{2} \d{4}\))/.test(f.path)).map((f) => f.path)`,
  );
}

// 0a: clean create + commit + restart: files and the sync cursor survive a restart.
test("level0/0a clean create + commit + restart preserves content and cursor", async () => {
  test.slow();
  const pair = await launchPair({ passphrase: PASSPHRASE });
  try {
    await waitForUnlocked(pair.A);
    await waitForStatusBar(pair.A.win, "Geode: synced");
    for (const f of FOLDERS) await upsertVaultFile(pair.A, f.path, f.content);
    await commit(pair.A, FOLDERS.map((f) => f.path));
    await waitForStatusBar(pair.A.win, "Geode: synced");
    expect(await lastSeenSeq(pair.A)).toBeGreaterThan(0);

    await relaunch(pair.A);
    await waitForStatusBar(pair.A.win, "Geode: synced");

    for (const f of FOLDERS) {
      expect(await readVaultFile(pair.A, f.path)).toBe(f.content);
    }
    expect(await lastSeenSeq(pair.A)).toBeGreaterThan(0); // cursor re-established, not reset to 0
    expect(await conflictPaths(pair.A)).toEqual([]);
  } finally {
    await pair.stop();
  }
});

// 0b: kill mid-debounce: autosaved bytes survive and sync commits them.
test("level0/0b kill mid-debounce auto-save recovery", async () => {
  test.slow();
  const pair = await launchPair({ passphrase: PASSPHRASE });
  const FILE = "Journal/draft.md";
  const LINES = "line1\nline2\nline3\nline4\nline5\n";
  try {
    await waitForUnlocked(pair.A);
    await waitForStatusBar(pair.A.win, "Geode: synced");
    await upsertVaultFile(pair.A, FILE, "line1\n");
    await commit(pair.A, [FILE]);
    await waitForContent(pair.A, pair.B, FILE, "line1\n");

    // Type/autosave the 5 lines, then "kill" before the debounce push completes.
    await writeVaultFile(pair.A, FILE, LINES);
    await relaunch(pair.A);
    await waitForStatusBar(pair.A.win, "Geode: synced");

    expect(await readVaultFile(pair.A, FILE)).toBe(LINES); // autosaved content survived
    await waitForContent(pair.A, pair.B, FILE, LINES, 60_000); // one new version propagated
    expect(await conflictPaths(pair.A)).toEqual([]);
  } finally {
    await pair.stop();
  }
});

// 0c: restart with an untracked local edit: reconciler commits a new version.
test("level0/0c restart with untracked local edit commits a new version", async () => {
  test.slow();
  const pair = await launchPair({ passphrase: PASSPHRASE });
  const FILE = "doc.md";
  const BASE = "line1\nline2\nline3\n";
  const EDITED = BASE + "extra1\nextra2\nextra3\n";
  try {
    await waitForUnlocked(pair.A);
    await waitForStatusBar(pair.A.win, "Geode: synced");
    await upsertVaultFile(pair.A, FILE, BASE);
    await commit(pair.A, [FILE]);
    await waitForContent(pair.A, pair.B, FILE, BASE);

    // "Closed" the app, then an external editor appends 3 lines to the file on disk.
    await pair.A.eval("app.plugins.plugins.geode.lockVault()");
    await writeVaultFile(pair.A, FILE, EDITED);
    await pair.A.eval(`app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`);
    await waitForUnlocked(pair.A);
    await waitForStatusBar(pair.A.win, "Geode: synced");

    await waitForContent(pair.A, pair.B, FILE, EDITED, 60_000); // reconciler detected + committed
    expect(await readVaultFile(pair.A, FILE)).toBe(EDITED);
    expect(await conflictPaths(pair.A)).toEqual([]);
    await expect.poll(async () => await lastSeenSeq(pair.A)).toBeGreaterThan(1);
  } finally {
    await pair.stop();
  }
});
