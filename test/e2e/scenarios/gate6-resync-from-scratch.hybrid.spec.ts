import { expect, test } from "@playwright/test";
import { launchHybridPair } from "../fixtures/hybrid-pair";
import type { SyncDevice } from "../helpers/device-abstraction";
import { waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate6-resync-passphrase";
const SEEDED_FILES = buildSeedFiles();
const SEEDED_PATHS = SEEDED_FILES.map((file) => file.path);

for (const phoneAsA of [false, true]) {
  const role = phoneAsA ? "phone-as-A" : "desktop-as-A";
  test(
    `gate6 resync from scratch rebuilds local state without duplicates in real Obsidian (${role})`,
    async () => {
      test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
      test.slow();

      const pair = await launchHybridPair({ passphrase: PASSPHRASE, phoneAsA });

      try {
        // 1. Both devices unlocked and synced.
        await expect
          .poll(
            async () => await pair.A.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"),
            { timeout: 60_000 },
          )
          .toBe(true);
        await expect
          .poll(
            async () => await pair.B.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"),
            { timeout: 60_000 },
          )
          .toBe(true);
        await waitForStatusBar(pair.A, "Geode: synced", 60_000);
        await waitForStatusBar(pair.B, "Geode: synced", 60_000);

        // 2. Seed ~18 files (text + binary) on A.
        await seedVault(pair.A, SEEDED_FILES);
        await expect
          .poll(async () => await countTrackedSeedFiles(pair.A), { timeout: 90_000 })
          .toBe(SEEDED_FILES.length);
        await expect
          .poll(async () => await countTrackedSeedFiles(pair.B), { timeout: 90_000 })
          .toBe(SEEDED_FILES.length);

        // 3. Byte-for-byte match across A and B (on-device hash comparison).
        await expect
          .poll(async () => await treesMatch(pair.A, pair.B, SEEDED_PATHS), { timeout: 90_000 })
          .toBe(true);

        // 4. Resync B from scratch.
        await pair.B.eval(
          "await app.plugins.plugins.geode.resyncFromScratch(); return true;",
        );

        // 5. Verify data rebuilt correctly (tracked count + byte-for-byte match).
        await expect
          .poll(async () => await countTrackedSeedFiles(pair.B), { timeout: 90_000 })
          .toBe(SEEDED_FILES.length);
        await expect
          .poll(async () => await treesMatch(pair.A, pair.B, SEEDED_PATHS), { timeout: 90_000 })
          .toBe(true);

        // Verifies the #153 fix: status bar settles to "synced" after resyncFromScratch
        await waitForStatusBar(pair.B, "Geode: synced", 180_000);

        // 6. No duplicate or conflict files in B's seed tree.
        const seedTree = await listSeedTree(pair.B);
        expect(seedTree).toEqual([...SEEDED_PATHS].sort());
        expect(
          seedTree.filter((p) =>
            /(\.conflict-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}|\(conflict .+? \d{4}-\d{2}-\d{2} \d{4}\))/
              .test(p)
          ),
        ).toEqual([]);
      } finally {
        await pair.stop();
      }
    },
  );
}

// --- helpers ---

async function seedVault(
  device: SyncDevice,
  files: Array<{ path: string; bytes: number[] }>,
): Promise<void> {
  await device.eval(`
    const files = ${JSON.stringify(files)};
    for (const file of files) {
      let current = "";
      for (const part of file.path.split("/").slice(0, -1)) {
        current = current ? current + "/" + part : part;
        if (!(await app.vault.adapter.exists(current))) {
          await app.vault.createFolder(current);
        }
      }
      const payload = new Uint8Array(file.bytes);
      const existing = app.vault.getAbstractFileByPath(file.path);
      if (existing) {
        await app.vault.modifyBinary(existing, payload.buffer.slice(0));
      } else {
        await app.vault.createBinary(file.path, payload.buffer.slice(0));
      }
    }
    await app.plugins.plugins.geode.syncManager.handlePendingOps(
      files.map((file) => ({ path: file.path, kind: "commit" })),
    );
    return true;
  `);
}

async function countTrackedSeedFiles(device: SyncDevice): Promise<number> {
  return await device.eval<number>(`
    const state = app.plugins.plugins.geode.syncManager?.state;
    if (!state) {
      return 0;
    }
    return [...state.getAllLocalFiles().values()]
      .filter((row) => row.path.startsWith("seed/") && !row.deleted)
      .length;
  `);
}

function buildSeedFiles(): Array<{ path: string; bytes: number[] }> {
  const files: Array<{ path: string; bytes: number[] }> = [];
  for (let index = 1; index <= 16; index++) {
    const folder = index % 4 === 0
      ? "seed/nested/deeper"
      : index % 3 === 0
      ? "seed/nested"
      : "seed";
    const fileName = `note-${String(index).padStart(2, "0")}.md`;
    const body = `# Note ${index}\nseeded line ${index}\nchecksum ${index * 17}\n`;
    files.push({
      path: `${folder}/${fileName}`,
      bytes: [...new TextEncoder().encode(body)],
    });
  }
  files.push({
    path: "seed/assets/chart.canvas",
    bytes: [...new TextEncoder().encode('{"nodes":[{"id":"gate6","x":1,"y":2}],"edges":[]}')],
  });
  files.push({
    path: "seed/assets/diagram.bin",
    bytes: [0, 255, 4, 8, 15, 16, 23, 42, 99, 7, 3, 1],
  });
  return files;
}

// On-device SHA-256 hash comparison (replaces filesystem treesMatchBytes).
async function fileHash(device: SyncDevice, filePath: string): Promise<string> {
  return await device.eval<string>(`(async () => {
    const buf = await app.vault.adapter.readBinary(${JSON.stringify(filePath)});
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  })()`);
}

async function treesMatch(a: SyncDevice, b: SyncDevice, paths: string[]): Promise<boolean> {
  for (const p of paths) {
    const [ha, hb] = await Promise.all([fileHash(a, p), fileHash(b, p)]);
    if (ha !== hb) return false;
  }
  return true;
}

// On-device recursive listing of the "seed" directory (replaces filesystem collectRelativeFiles).
async function listSeedTree(device: SyncDevice): Promise<string[]> {
  return await device.eval<string[]>(`(async () => {
    const walk = async (dir) => {
      const out = [];
      const { files, folders } = await app.vault.adapter.list(dir);
      for (const f of files) out.push(f);
      for (const sub of folders) out.push(...(await walk(sub)));
      return out;
    };
    return (await walk("seed")).sort();
  })()`);
}
