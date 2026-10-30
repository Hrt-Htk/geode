import { expect, test } from "@playwright/test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../fixtures/server";
import { launchUnconfigured } from "../fixtures/fresh";
import { focusSetupWizard, waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";

const PASSPHRASE = "gate7-brat-passphrase";
const FILE_PATH = "notes/brat.md";
const CONTENT = "# brat\nminimal install\n";

test("gate7 BRAT-shape install (main.js + manifest.json only) unlocks and syncs", async () => {
  test.slow();
  const distDir = path.join(process.cwd(), "plugin-dist");
  const bratDir = await mkdtemp(path.join(tmpdir(), "geode-brat-"));
  await cp(path.join(distDir, "main.js"), path.join(bratDir, "main.js"));
  await cp(path.join(distDir, "manifest.json"), path.join(bratDir, "manifest.json"));

  const server = await startServer();
  const obs = await launchUnconfigured(server, { keepStartupModal: true, pluginSrcDir: bratDir });
  try {
    await waitForPluginLoaded(obs);
    await focusSetupWizard(obs);
    const win = obs.win;
    await win.locator('[data-testid="geode-wizard-create"]').click();
    await win.locator('[data-testid="geode-create-server"]').fill(server.url);
    await win.locator('[data-testid="geode-create-admin"]').fill("e2e");
    await win.locator('[data-testid="geode-create-continue"]').click();
    await win.locator('[data-testid="geode-create-vault-name"]').fill("gate7-brat");
    await win.locator('[data-testid="geode-create-passphrase"]').fill(PASSPHRASE);
    await win.locator('[data-testid="geode-create-confirm"]').fill(PASSPHRASE);
    await win.locator('[data-testid="geode-create-submit"]').click();

    await waitForUnlocked(obs);

    await obs.eval(`
      const path = ${JSON.stringify(FILE_PATH)};
      const content = ${JSON.stringify(CONTENT)};
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder && !(await app.vault.adapter.exists(folder))) {
        await app.vault.createFolder(folder);
      }
      await app.vault.create(path, content);
      await app.plugins.plugins.geode.syncManager.handlePendingOps([{ path, kind: "commit" }]);
      return true;
    `);

    const creds = await obs.eval<{ vaultId: string; token: string }>(
      `(() => { const s = app.plugins.plugins.geode.pluginSettings; return { vaultId: s.vaultId, token: s.deviceToken }; })()`,
    );
    await expect
      .poll(async () => {
        const res = await fetch(`${server.url}/vaults/${creds.vaultId}/heads?after_seq=0`, {
          headers: { Authorization: `Bearer ${creds.token}` },
        });
        if (!res.ok) return 0;
        const body = (await res.text()).trim();
        return body ? body.split("\n").length : 0;
      }, { timeout: 60_000 })
      .toBeGreaterThan(0);

    expect(obs.consoleErrors().filter((e) => e.includes("Failed to fetch"))).toEqual([]);
  } finally {
    await obs.close();
    await server.stop();
    await rm(bratDir, { recursive: true, force: true });
  }
});
