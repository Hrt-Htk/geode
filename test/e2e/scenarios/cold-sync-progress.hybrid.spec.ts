import { expect, test } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { launchHybridPair } from "../fixtures/hybrid-pair";

const PASSPHRASE = "cold-sync-progress-passphrase";
// REAL .md files (copied from the source vault) keep the phone's drain
// observable as "applying N/M". Real files apply at ~1/sec on-device: the
// cost is per-file Capacitor FS bridge calls (adapter.exists + createBinary),
// not the network (#328): so 200 keeps the applying window long (tens of
// seconds) while still converging inside the budget below. Raise for a longer
// window, but bump the convergence timeout with it.
const SEED_COUNT = 200;

/**
 * #319: when the phone joins a vault that already holds a version backlog, the
 * cold-sync replay drains AFTER the transport goes live. While `current < total`
 * the mobile status button must show "applying N/M" (spinner): not a false
 * "synced" checkmark, and then converge to "Geode: synced" with all files.
 *
 * The backlog is real: the desktop's vault is pre-populated with seeded .md
 * files and its reconciler uploads the blobs before the phone ever connects.
 */
test("cold sync shows applying progress on the phone before synced (#319)", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const pair = await launchHybridPair({
    passphrase: PASSPHRASE,
    seedFromVault: { count: SEED_COUNT },
  });
  try {
    // Default roles: A = desktop, B = phone. hybrid-pair unlocks the phone.
    await expect
      .poll(async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"))
      .toBe(true);

    // The mobile status button's aria-label is set from resolveIcon's tooltip
    // by StatusBar.renderMobile (the desktop status bar does not exist on
    // mobile), so read it in-page.
    const mobileStatus = () =>
      pair.B.eval<string>(
        `document.querySelector('[data-testid="geode-mobile-status"]')?.getAttribute("aria-label") ?? ""`,
      );

    // 1. DURING the cold-sync drain the phone must show "applying N/M" with
    //    current < total. Capture {label, applied file count, transport
    //    state, lastSeenSeq} each tick so a failure shows the delivery path:
    //    gradual file climb while "synced" ⇒ post-live streaming (handleVersion)
    //    gap; a 0→N jump ⇒ the drain finished during setup (timing).
    let applyingLabel = "";
    const probe = () =>
      pair.B.eval<string>(
        `(() => {
          const g = app.plugins.plugins.geode;
          const label = document.querySelector('[data-testid="geode-mobile-status"]')?.getAttribute("aria-label") ?? "";
          const files = g?.state?.getAllLocalFiles?.().size ?? 0;
          const state = g?.transport?.getState?.() ?? "?";
          const seq = g?.transport?.lastSeenSeq ?? -1;
          return JSON.stringify({ label, files, state, seq });
        })()`,
      );
    let lastProbe = "";
    await expect
      .poll(async () => {
        const raw = await probe();
        if (raw !== lastProbe) {
          lastProbe = raw;
          console.log(`[probe] ${raw}`);
        }
        applyingLabel = JSON.parse(raw).label;
        return /Geode: applying \d+\/\d+/.test(applyingLabel);
      }, { timeout: 120_000 })
      .toBe(true);
    const match = applyingLabel.match(/applying (\d+)\/(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeLessThan(Number(match![2]));

    // 2. Convergence: the phone lands the full seeded backlog (state rows are
    //    written as versions apply: unlike getFiles(), which lags adapter
    //    writes on mobile), then reaches "Geode: synced" (which also requires
    //    the phone's own vault push to finish: the long pole, hence the budget).
    let lastConverge = -1;
    await expect
      .poll(
        async () => {
          const n = await pair.B.eval<number>(
            `app.plugins.plugins.geode.state.getAllLocalFiles().size`,
          );
          if (n !== lastConverge) {
            lastConverge = n;
            console.log(`[converge] ${n}/${SEED_COUNT}`);
          }
          return n;
        },
        { timeout: 240_000 },
      )
      .toBeGreaterThanOrEqual(SEED_COUNT);
    await expect.poll(mobileStatus, { timeout: 300_000 }).toMatch(/Geode: synced/);

    // 3. A sampled REAL file matches the desktop's bytes: proves the phone
    //    decrypted the seeded chunks with the same vault keys end-to-end.
    //    (Content is not hardcoded: real source-vault files vary.)
    const sample = await firstMarkdownFile(pair.A.vaultDir!);
    expect(sample).not.toBeNull();
    expect(
      await pair.B.eval<string>(`await app.vault.adapter.read(${JSON.stringify(sample!.rel)})`),
    ).toBe(sample!.content);
  } finally {
    await pair.stop();
  }
});

/**
 * First .md in the desktop vault (sorted walk, .obsidian skipped): a seeded
 * file whose bytes the phone must reproduce after cold sync.
 */
async function firstMarkdownFile(
  dir: string,
  prefix = "",
): Promise<{ rel: string; content: string } | null> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  for (const entry of entries) {
    if (entry.name === ".obsidian") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const found = await firstMarkdownFile(path.join(dir, entry.name), rel);
      if (found) return found;
    } else if (entry.name.endsWith(".md")) {
      return { rel, content: await readFile(path.join(dir, entry.name), "utf8") };
    }
  }
  return null;
}
