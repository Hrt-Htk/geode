import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { listSeedFiles } from "../fixtures/obsidian";
import { PhoneDevice } from "../helpers/device-abstraction";
import { serverMaxSeq, serverVersionCount, unlockIfLocked } from "../helpers/interrupt";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #493 flow b (hybrid): EXPECTED: the phone cold-catching-up on a real seed backlog is
// force-stopped mid catch-up; after a relaunch it converges to the FULL backlog with
// byte-identical content (vs the seed vault), its cursor reaches the server head (no skipped
// versions), and it commits nothing.
const PASSPHRASE = "interrupt-catchup-hybrid-pass";
const N = 90;

const norm = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/** The same first-`n` files the hybrid fixture seeds (sorted relative path, .md only). */
async function seededFiles(n: number): Promise<{ path: string; content: string }[]> {
  const sourceDir = process.env.GEODE_SEED_VAULT_DIR!;
  return await Promise.all(
    (await listSeedFiles(sourceDir, n)).map(async (rel) => ({
      path: rel,
      content: await readFile(path.join(sourceDir, rel), "utf8"),
    })),
  );
}

test("issue493 (hybrid): force-stop phone mid backlog catch-up → relaunch → full backlog, correct bytes, cursor at head", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.setTimeout(900_000);

  const pair = await launchHybridPair({ passphrase: PASSPHRASE, seedFromVault: { count: N } });
  const phone = pair.B as PhoneDevice;
  const files = await seededFiles(N);

  try {
    const { dataDir, vaultId } = pair.server;
    /* The desktop has pushed the whole backlog before the phone connected; the phone must commit nothing. */
    const countBefore = serverVersionCount(dataDir, vaultId);
    expect(countBefore, "desktop must have pushed the full seed backlog").toBeGreaterThanOrEqual(N);

    /* Deterministic mid catch-up signal: half the backlog applied on the phone. */
    const startedAt = Date.now();
    let applied = 0;
    while (Date.now() - startedAt < 300_000) {
      applied = await phone.eval<number>("app.plugins.plugins.geode.state.getAllLocalFiles().size");
      if (applied >= N / 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(applied, "kill must land MID catch-up, not before").toBeGreaterThanOrEqual(N / 2);
    expect(applied, "kill must land MID catch-up, not after").toBeLessThan(N);

    /* Force-stop, relaunch, re-attach. */
    await phone.relaunch();
    await unlockIfLocked(phone, PASSPHRASE);
    /* Convergence signal: the full backlog applied ("synced" can flash earlier). */
    const settleStart = Date.now();
    while (Date.now() - settleStart < 420_000) {
      const applied = await phone.eval<number>(
        "app.plugins.plugins.geode.state.getAllLocalFiles().size",
      );
      if (applied >= N) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(
      await phone.eval<number>("app.plugins.plugins.geode.state.getAllLocalFiles().size"),
      "full backlog must be applied after relaunch",
    ).toBeGreaterThanOrEqual(N);
    await waitForStatusBar(phone, "Geode: synced", 120_000);
    await phone.screenshot(shotPath("493-catchup-phone-settled.png"));

    /* Full backlog on the phone, byte-identical to the seed vault. */
    for (const f of files) {
      expect(await phone.fileExists(f.path), `phone must have ${f.path}`).toBe(true);
      const got = await phone.readVaultFile(f.path);
      expect(norm(got), `phone bytes for ${f.path}`).toBe(norm(f.content));
    }

    /* The catching-up phone committed nothing; its cursor reached the server head. */
    expect(serverVersionCount(dataDir, vaultId)).toBe(countBefore);
    const lastSeen = await phone.eval<number>("app.plugins.plugins.geode.getLastSeenSeq()");
    expect(lastSeen, "cursor must not skip versions").toBe(serverMaxSeq(dataDir, vaultId));
  } finally {
    await pair.stop();
  }
});
