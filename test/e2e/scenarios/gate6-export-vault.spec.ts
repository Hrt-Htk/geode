import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchObsidian } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { collectRelativeFiles, readRelativeFileBytes } from "../helpers/files";
import { waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "gate6-export-passphrase";
const EXPORT_FILES = buildExportFiles();
const EXPORT_PATHS = EXPORT_FILES.map((file) => file.path);

test("gate6 export decrypted vault writes a byte-identical plaintext tree to a target folder", async () => {
  test.slow();

  const server = await startServer();
  const device = await server.mintToken("gate6-export");
  const obsidian = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
  });
  const exportDir = await mkdtemp(path.join(tmpdir(), "geode-export-"));

  try {
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    await seedVault(obsidian, EXPORT_FILES);
    await expect
      .poll(async () => await countTrackedExportFiles(obsidian), { timeout: 90_000 })
      .toBe(EXPORT_FILES.length);

    await obsidian.eval(`
      await app.plugins.plugins.geode.exportDecryptedVault(${JSON.stringify(exportDir)});
      return true;
    `);

    const exportedTree = await collectRelativeFiles(exportDir);
    /* Superset check: export includes all seeded files (plus any .obsidian/ config files
     * that are synced; those are environment-dependent so we don't assert their presence). */
    for (const p of EXPORT_PATHS) {
      expect(exportedTree).toContain(p);
    }

    for (const relativePath of EXPORT_PATHS) {
      const [vaultBytes, exportedBytes] = await Promise.all([
        readRelativeFileBytes(obsidian.vaultDir, relativePath),
        readRelativeFileBytes(exportDir, relativePath),
      ]);
      expect([...exportedBytes]).toEqual([...vaultBytes]);
    }
  } finally {
    await Promise.allSettled([
      obsidian.close(),
      server.stop(),
      rm(exportDir, { recursive: true, force: true }),
    ]);
  }
});

async function seedVault(
  instance: Awaited<ReturnType<typeof launchObsidian>>,
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

async function countTrackedExportFiles(
  instance: Awaited<ReturnType<typeof launchObsidian>>,
): Promise<number> {
  return await instance.eval<number>(`
    const state = app.plugins.plugins.geode.syncManager?.state;
    if (!state) {
      return 0;
    }
    return [...state.getAllLocalFiles().values()]
      .filter((row) => row.path.startsWith("export-seed/") && !row.deleted)
      .length;
  `);
}

function buildExportFiles(): Array<{ path: string; bytes: number[] }> {
  return [
    {
      path: "export-seed/readme.md",
      bytes: [...new TextEncoder().encode("# Gate 6 export\nhello from geode\n")],
    },
    {
      path: "export-seed/notes/today.md",
      bytes: [...new TextEncoder().encode("line one\nline two\nline three\n")],
    },
    {
      path: "export-seed/notes/archive/2026-05-21.md",
      bytes: [...new TextEncoder().encode("archive entry\nwith nested folder\n")],
    },
    {
      path: "export-seed/assets/graph.canvas",
      bytes: [...new TextEncoder().encode('{"nodes":[{"id":"n1","x":10,"y":20}],"edges":[]}')],
    },
    {
      path: "export-seed/assets/snapshot.bin",
      bytes: [1, 3, 5, 7, 9, 11, 13, 17, 19, 23],
    },
    {
      path: "export-seed/assets/payload.dat",
      bytes: [255, 0, 254, 1, 2, 3, 4, 5, 99, 100],
    },
  ];
}
