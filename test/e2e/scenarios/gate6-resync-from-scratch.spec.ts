import { expect, test } from "@playwright/test";
import path from "node:path";
import { launchPair } from "../fixtures/pair";
import { collectRelativeFiles, treesMatchBytes } from "../helpers/files";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate6-resync-passphrase";
const SEEDED_FILES = buildSeedFiles();
const SEEDED_PATHS = SEEDED_FILES.map((file) => file.path);

test("gate6 resync from scratch rebuilds local state without duplicates in real Obsidian", async () => {
  test.slow();

  const pair = await launchPair({ passphrase: PASSPHRASE });

  try {
    await Promise.all([
      waitForUnlocked(pair.A),
      waitForUnlocked(pair.B),
      waitForStatusBar(pair.A.win, "Geode: synced", 60_000),
      waitForStatusBar(pair.B.win, "Geode: synced", 60_000),
    ]);

    await seedVault(pair.A, SEEDED_FILES);
    await expect
      .poll(async () => await countTrackedSeedFiles(pair.A), { timeout: 90_000 })
      .toBe(SEEDED_FILES.length);
    await expect
      .poll(async () => await countTrackedSeedFiles(pair.B), { timeout: 90_000 })
      .toBe(SEEDED_FILES.length);
    await expect
      .poll(
        async () => await treesMatchBytes(pair.A.vaultDir, pair.B.vaultDir, SEEDED_PATHS),
        { timeout: 90_000 },
      )
      .toBe(true);

    await pair.B.eval("await app.plugins.plugins.geode.resyncFromScratch(); return true;");

    await waitForStatusBar(pair.B.win, "Geode: synced", 90_000);
    await expect
      .poll(async () => await countTrackedSeedFiles(pair.B), { timeout: 90_000 })
      .toBe(SEEDED_FILES.length);
    await expect
      .poll(
        async () => await treesMatchBytes(pair.A.vaultDir, pair.B.vaultDir, SEEDED_PATHS),
        { timeout: 90_000 },
      )
      .toBe(true);

    const seedTree = await collectRelativeFiles(path.join(pair.B.vaultDir, "seed"));
    expect(seedTree).toEqual(SEEDED_PATHS.map((filePath) => filePath.slice("seed/".length)).sort());
    expect(
      seedTree.filter((filePath) =>
        /(\.conflict-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}|\(conflict .+? \d{4}-\d{2}-\d{2} \d{4}\))/
          .test(filePath)
      ),
    ).toEqual([]);
  } finally {
    await pair.stop();
  }
});

async function seedVault(
  instance: Awaited<ReturnType<typeof launchPair>>["A"],
  files: Array<{ path: string; bytes: number[] }>,
): Promise<void> {
  await instance.eval(`
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

async function countTrackedSeedFiles(
  instance: Awaited<ReturnType<typeof launchPair>>["A"],
): Promise<number> {
  return await instance.eval<number>(`
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
