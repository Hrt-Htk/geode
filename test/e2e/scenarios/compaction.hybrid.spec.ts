import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #218: compaction folds a chain's middle versions; cross-device sync survives.

const PASSPHRASE = "compaction-passphrase";
const FILE = "notes/compact.md";

type HeadRow = {
  path_hash: string;
  version: number;
  seq: number;
  deleted: boolean;
  chunk_hashes: string[];
};

/** #59: every head the probes see, named. A head row carries no plaintext path (only its MAC'd
 * `path_hash` plus ciphertext), and deriving the vault keys inside a spec is not small, so the hash
 * and the commit shape (a tombstone, an empty file) are what name an intruder. */
const describeHeads = (rows: HeadRow[]): string =>
  rows.length === 0
    ? "no heads"
    : rows.map((row) =>
      `${row.path_hash} (version ${row.version}, seq ${row.seq}, ${
        row.deleted ? "deleted" : `${row.chunk_hashes.length} chunk(s)`
      })`
    ).join(", ");

// Flushes the version-compaction background pass: GEODE_COMPACT_FLOOR_DAYS=0 folds every
// pre-now version into one checkpoint per calendar day, and GEODE_COMPACT_THROTTLE_MS=0 makes
// every qualifying commit arm a pass (so the middle versions fold progressively as they land).
test("compaction folds old versions and cross-device sync survives (desktop-as-A)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const pair = await launchHybridPair({
    passphrase: PASSPHRASE,
    serverEnv: {
      GEODE_COMPACT_FLOOR_DAYS: "0",
      GEODE_COMPACT_THROTTLE_MS: "0",
    },
  });

  try {
    const { A, B } = pair;

    await waitForUnlocked(A);
    await waitForUnlocked(B);
    await waitForStatusBar(A, "Geode: synced", 60_000);
    await waitForStatusBar(B, "Geode: synced", 60_000);

    // Server reads happen in the node context, not in-page.
    const probe = await pair.server.mintToken("compaction-probe");
    const authHeaders = { authorization: `Bearer ${probe.token}` };
    const readHeads = async (): Promise<HeadRow[]> => {
      const resp = await fetch(
        `${pair.server.url}/vaults/${pair.server.vaultId}/heads`,
        { headers: authHeaders },
      );
      expect(resp.ok, `heads request failed: ${resp.status}`).toBe(true);
      return (await resp.text())
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    };

    // #59: the fresh desktop vault holds only its filtered config dir and the phone is wiped, so no
    // head may exist before this spec's first edit. One here was committed by a device at connect:
    // probe it now, while the dump still names only the intruder.
    const initialHeads = await readHeads();
    expect(
      initialHeads.length,
      `expected no heads before the first edit; got: ${describeHeads(initialHeads)}`,
    ).toBe(0);

    // Build a chain of ~5 server versions. Space edits ~2.5s apart so each lands as its own
    // version (the plugin coalesces edits within its 2s pending window).
    for (let v = 1; v <= 5; v++) {
      await upsertVaultFile(A, FILE, `v${v} of compact.md\n`);
      await waitForConvergence(A, B, FILE, 60_000);
      if (v < 5) await new Promise((r) => setTimeout(r, 2500));
    }

    // Let the final setTimeout(0) compaction pass finish before probing.
    await new Promise((r) => setTimeout(r, 2500));

    // Prove a fold happened via the real API (node context, not in-page).
    const filePathHash = await A.eval<string>(
      `app.plugins.plugins.geode.state.getLocalFile(${JSON.stringify(FILE)}).path_hash`,
    );
    const headRows = await readHeads();
    expect(
      headRows.length,
      `expected exactly one head (only ${FILE} synced, config sync off); got: ${
        describeHeads(headRows)
      }`,
    ).toBe(1);
    // #59: select compact.md's head by its own path hash, not by position.
    const fileHead = headRows.find((row) => row.path_hash === filePathHash);
    expect(
      fileHead,
      `${FILE} has no head (path_hash ${filePathHash}); got: ${describeHeads(headRows)}`,
    ).toBeDefined();

    const versionsResp = await fetch(
      `${pair.server.url}/vaults/${pair.server.vaultId}/versions/${filePathHash}`,
      { headers: authHeaders },
    );
    expect(versionsResp.ok, `versions request failed: ${versionsResp.status}`).toBe(true);
    const chain = await versionsResp.json() as Array<{
      version: number;
      parent: number | null;
      compacted_range: string | null;
    }>;
    const chainJson = JSON.stringify(chain);

    expect(
      chain.length,
      `expected middle versions folded away (<5); full chain: ${chainJson}`,
    ).toBeLessThan(5);
    expect(
      chain.some((row) => row.compacted_range !== null && /^\d+-\d+$/.test(row.compacted_range)),
      `expected at least one compacted_range label; full chain: ${chainJson}`,
    ).toBe(true);

    // Cross-device sync still works AFTER compaction (head is always retained).
    await upsertVaultFile(A, FILE, "v6 POST-COMPACT of compact.md\n");
    await waitForConvergence(A, B, FILE, 60_000);
    expect(await B.readVaultFile(FILE)).toContain("POST-COMPACT");

    await A.screenshot("compaction-final-A");
    await B.screenshot("compaction-final-B");
  } finally {
    await pair.stop();
  }
});
