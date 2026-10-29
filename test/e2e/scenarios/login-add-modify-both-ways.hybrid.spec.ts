import { expect, test } from "@playwright/test";
import type { SyncDevice } from "../helpers/device-abstraction";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "login-modify-passphrase";

async function takeScreenshots(
  init: SyncDevice,
  peer: SyncDevice,
  label: string,
): Promise<void> {
  await Promise.all([
    init.screenshot(`${label}-init`),
    peer.screenshot(`${label}-peer`),
  ]);
}

async function listSiblingConflicts(device: SyncDevice, vaultPath: string): Promise<string[]> {
  const parts = vaultPath.split("/");
  const fileName = parts.pop()!;
  const dir = parts.join("/");
  const stem = fileName.replace(/\.[^.]+$/, "");
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot) : "";
  const entries = await device.listVaultDir(dir);
  return entries
    .filter((e) => e.startsWith(`${stem} (conflict `) && e.endsWith(ext))
    .map((e) => (dir ? `${dir}/${e}` : e));
}

function readStatus(device: SyncDevice): Promise<string> {
  return device.eval<string>(
    `Array.from(document.querySelectorAll('.status-bar-item')).map(e=>e.title).find(t=>t&&t.includes('Geode'))||''`,
  );
}

async function runDirection(
  initiatorLabel: string,
  init: SyncDevice,
  peer: SyncDevice,
): Promise<void> {
  const FILE_PATH = `notes/${initiatorLabel}.md`;

  // --- Phase 1: Both working before start ---
  await waitForUnlocked(init);
  await waitForUnlocked(peer);
  await waitForStatusBar(init, "Geode: synced", 60_000);
  await waitForStatusBar(peer, "Geode: synced", 60_000);

  await takeScreenshots(init, peer, `${initiatorLabel}-00-synced`);

  expect(await init.consoleErrors()).toEqual([]);
  expect(await peer.consoleErrors()).toEqual([]);
  expect(await init.eval("app.plugins.plugins.geode.getConflictCount()")).toBe(0);
  expect(await peer.eval("app.plugins.plugins.geode.getConflictCount()")).toBe(0);

  // --- Phase 2: Add a file (real path, real 5s debounce) ---
  await upsertVaultFile(init, FILE_PATH, `# ${initiatorLabel}\nline one\n`);
  await waitForConvergence(init, peer, FILE_PATH, 60_000);

  await takeScreenshots(init, peer, `${initiatorLabel}-01-after-add`);

  expect(
    await peer.eval(`await app.vault.adapter.exists(${JSON.stringify(FILE_PATH)})`),
  ).toBe(true);

  const initConflictsAfterAdd = await listSiblingConflicts(init, FILE_PATH);
  const peerConflictsAfterAdd = await listSiblingConflicts(peer, FILE_PATH);
  expect(initConflictsAfterAdd).toEqual([]);
  expect(peerConflictsAfterAdd).toEqual([]);
  expect(await init.eval("app.plugins.plugins.geode.getConflictCount()")).toBe(0);
  expect(await peer.eval("app.plugins.plugins.geode.getConflictCount()")).toBe(0);
  expect(await init.consoleErrors()).toEqual([]);
  expect(await peer.consoleErrors()).toEqual([]);

  // --- Phase 3: Modify the file ---
  await upsertVaultFile(init, FILE_PATH, `# ${initiatorLabel}\nline one edited\n`);
  await waitForConvergence(init, peer, FILE_PATH, 60_000);

  await takeScreenshots(init, peer, `${initiatorLabel}-02-after-modify`);

  const initConflictsAfterModify = await listSiblingConflicts(init, FILE_PATH);
  const peerConflictsAfterModify = await listSiblingConflicts(peer, FILE_PATH);
  expect(initConflictsAfterModify).toEqual([]);
  expect(peerConflictsAfterModify).toEqual([]);
  expect(await init.eval("app.plugins.plugins.geode.getConflictCount()")).toBe(0);
  expect(await peer.eval("app.plugins.plugins.geode.getConflictCount()")).toBe(0);
  expect(await init.consoleErrors()).toEqual([]);
  expect(await peer.consoleErrors()).toEqual([]);

  // --- Phase 4: Restart then modify (the bug repro) ---
  await init.eval("app.plugins.plugins.geode.lockVault()");
  await init.eval(
    `app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`,
  );
  await peer.eval("app.plugins.plugins.geode.lockVault()");
  await peer.eval(
    `app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)})`,
  );

  await waitForUnlocked(init);
  await waitForUnlocked(peer);

  // Poll up to 20s for the post-restart status to settle to EITHER synced OR conflict
  let initStatus = "";
  const settleDeadline = Date.now() + 20_000;
  while (Date.now() < settleDeadline) {
    initStatus = await readStatus(init);
    if (initStatus.includes("synced") || initStatus.includes("conflict")) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Screenshot BEFORE modify: captures the post-restart state (conflict is the key visual)
  await takeScreenshots(init, peer, `${initiatorLabel}-03-after-restart`);

  // Immediately modify in the initiator
  await upsertVaultFile(
    init,
    FILE_PATH,
    `# ${initiatorLabel}\nedited right after restart\n`,
  );

  // Poll up to 30s for a conflict file in the PEER vault
  let peerConflicts: string[] = [];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    peerConflicts = await listSiblingConflicts(peer, FILE_PATH);
    if (peerConflicts.length > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Best-effort convergence: don't let timeout skip the screenshot
  try {
    await waitForConvergence(init, peer, FILE_PATH, 60_000);
  } catch {
    // Convergence may fail if there is a conflict: that's fine
  }

  await takeScreenshots(init, peer, `${initiatorLabel}-04-after-restart-modify`);

  // Screenshots are already taken; now assert (failures still leave artifacts)
  const initConflictCount = await init.eval<number>("app.plugins.plugins.geode.getConflictCount()");
  const peerConflictCount = await peer.eval<number>("app.plugins.plugins.geode.getConflictCount()");
  expect(
    initStatus.includes("conflict"),
    `init status after restart was: ${initStatus}`,
  ).toBe(false);
  expect(
    peerConflicts,
    `peer conflict files: ${JSON.stringify(peerConflicts)}`,
  ).toEqual([]);
  expect(initConflictCount, "init conflict count after restart-modify").toBe(0);
  expect(peerConflictCount, "peer conflict count after restart-modify").toBe(0);
}

test("test-A initiates login add modify both ways (desktop initiates)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const pair = await launchHybridPair({ passphrase: PASSPHRASE, phoneAsA: false });

  try {
    await runDirection("test-A", pair.A, pair.B);
  } finally {
    await pair.stop();
  }
});

test("test-B initiates login add modify both ways (phone initiates)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const pair = await launchHybridPair({ passphrase: PASSPHRASE, phoneAsA: true });

  try {
    await runDirection("test-B", pair.A, pair.B);
  } finally {
    await pair.stop();
  }
});
