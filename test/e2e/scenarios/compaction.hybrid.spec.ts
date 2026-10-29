import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import { upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForConvergence, waitForStatusBar } from "../helpers/waits";

// #218: compaction folds a chain's middle versions; cross-device sync survives.

const PASSPHRASE = "compaction-passphrase";
const FILE = "notes/compact.md";

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
    const probe = await pair.server.mintToken("compaction-probe");
    const authHeaders = { authorization: `Bearer ${probe.token}` };

    const headsResp = await fetch(
      `${pair.server.url}/vaults/${pair.server.vaultId}/heads`,
      { headers: authHeaders },
    );
    expect(headsResp.ok, `heads request failed: ${headsResp.status}`).toBe(true);
    const headRows = (await headsResp.text())
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
    expect(
      headRows.length,
      `expected exactly one head (only ${FILE} synced, config sync off); got: ${
        JSON.stringify(headRows)
      }`,
    ).toBe(1);
    const pathHash = headRows[0].path_hash as string;

    const versionsResp = await fetch(
      `${pair.server.url}/vaults/${pair.server.vaultId}/versions/${pathHash}`,
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
