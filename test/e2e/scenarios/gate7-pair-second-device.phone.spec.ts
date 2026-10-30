import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { waitForPluginLoaded, waitForUnlocked } from "../helpers/geode";

const PASSPHRASE = "gate7-phone-pair-pass";
const BLANK_CREDS = { serverUrl: "", vaultId: "", deviceId: "", deviceToken: "", salt: "" };

test("gate7 phone createVaultFlow provisions, unlocks, and syncs a note to the server", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const obsidian = await connectPhone({ geodeSettings: BLANK_CREDS });

  try {
    await waitForPluginLoaded(obsidian);

    await obsidian.eval(`
      await app.plugins.plugins.geode.createVaultFlow({
        serverUrl: ${JSON.stringify(server.url)},
        adminToken: "e2e",
        vaultName: "gate7-phone-pair-A",
        deviceName: "e2e-device",
        passphrase: ${JSON.stringify(PASSPHRASE)},
      });
      return true;
    `);

    await waitForUnlocked(obsidian);

    const creds = await obsidian.eval<{ vaultId: string; token: string }>(
      `(() => { const s = app.plugins.plugins.geode.pluginSettings; return { vaultId: s.vaultId, token: s.deviceToken }; })()`,
    );
    expect(creds.vaultId).toBeTruthy();
    expect(creds.token).toBeTruthy();

    await obsidian.eval(`
      const path = "notes/pair-created.md";
      const content = "# created\\non phone\\n";
      const folder = path.split("/").slice(0, -1).join("/");
      if (folder && !(await app.vault.adapter.exists(folder))) {
        await app.vault.createFolder(folder);
      }
      await app.vault.create(path, content);
      await app.plugins.plugins.geode.syncManager.handlePendingOps([{ path, kind: "commit" }]);
      return true;
    `);

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
  } finally {
    await obsidian.close();
    await server.stop();
  }
});

test("gate7 phone joins existing vault as second device and converges pre-existing file", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const savedReset = process.env.GEODE_PHONE_RESET;
  const FILE_PATH = "notes/pre-existing.md";
  const CONTENT = "# pre-existing\\nseeded by first device\\n";

  let phone1: Awaited<ReturnType<typeof connectPhone>> | undefined = undefined;
  let phone2: Awaited<ReturnType<typeof connectPhone>> | undefined = undefined;

  try {
    /* --- Phase 1: create vault + seed a file as device-1 --- */
    phone1 = await connectPhone({ geodeSettings: BLANK_CREDS });

    await waitForPluginLoaded(phone1);

    await phone1.eval(`
      await app.plugins.plugins.geode.createVaultFlow({
        serverUrl: ${JSON.stringify(server.url)},
        adminToken: "e2e",
        vaultName: "gate7-phone-pair-B",
        deviceName: "e2e-device",
        passphrase: ${JSON.stringify(PASSPHRASE)},
      });
      return true;
    `);

    await waitForUnlocked(phone1);

    const vaultId = await phone1.eval<string>("app.plugins.plugins.geode.pluginSettings.vaultId");
    const phase1Token = await phone1.eval<string>(
      "app.plugins.plugins.geode.pluginSettings.deviceToken",
    );

    await phone1.eval(`
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

    await expect
      .poll(async () => {
        const res = await fetch(`${server.url}/vaults/${vaultId}/heads?after_seq=0`, {
          headers: { Authorization: `Bearer ${phase1Token}` },
        });
        if (!res.ok) return 0;
        const body = (await res.text()).trim();
        return body ? body.split("\n").length : 0;
      }, { timeout: 60_000 })
      .toBeGreaterThan(0);

    await phone1.close();
    phone1 = undefined;

    /* --- Phase 2: re-join as device-2, verify file converges down --- */
    process.env.GEODE_PHONE_RESET = "1";
    phone2 = await connectPhone({ geodeSettings: BLANK_CREDS });

    await waitForPluginLoaded(phone2);

    await phone2.eval(`
      await app.plugins.plugins.geode.joinWithAdminFlow({
        serverUrl: ${JSON.stringify(server.url)},
        adminToken: "e2e",
        vaultId: ${JSON.stringify(vaultId)},
        deviceName: "phone-2",
        passphrase: ${JSON.stringify(PASSPHRASE)},
      });
      return true;
    `);

    await waitForUnlocked(phone2);

    const joinedVaultId = await phone2.eval<string>(
      "app.plugins.plugins.geode.pluginSettings.vaultId",
    );
    expect(joinedVaultId).toBe(vaultId);

    await phone2.eval(`(() => { app.plugins.plugins.geode.reconcileNow(); return true; })()`);

    await expect
      .poll(async () => {
        const result = await phone2.eval<string>(`
          (async () => {
            const path = ${JSON.stringify(FILE_PATH)};
            if (!(await app.vault.adapter.exists(path))) return "";
            return await app.vault.adapter.read(path);
          })()
        `);
        return result;
      }, { timeout: 60_000 })
      .toBe(CONTENT);
  } finally {
    if (phone2) await phone2.close().catch(() => {});
    if (phone1) await phone1.close().catch(() => {});
    process.env.GEODE_PHONE_RESET = savedReset;
    await server.stop().catch(() => {});
  }
});
