import { expect, test } from "@playwright/test";
import { connectPhone, type PhoneInstance } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #583 (phone): the marker row between two names on the real device, and the
// oldest name's save still previewable through Show older. Phone keeps the two
// panes stacked, so the marker row must read in the list alone.
const PASSPHRASE = "rename-history-phone-pass";
const OLD_PATH = "rename-phone.md";
const NEW_PATH = "renamed phone.md";

const MODAL = ".geode-history-modal";
const ACTIVITY = ".geode-activity-modal";
const MOBILE = '[data-testid="geode-mobile-status"]';

/** evalClick, but on the last match (the periods are ordered newest first). */
async function clickLast(obsidian: PhoneInstance, selector: string): Promise<void> {
  await obsidian.eval(`
    (() => {
      const matches = document.querySelectorAll(${JSON.stringify(selector)});
      const el = matches[matches.length - 1];
      if (!el) throw new Error("nothing to click: " + ${JSON.stringify(selector)});
      el.click();
      return true;
    })()
  `);
}

/** The status menu, then one entry; a menu click needs the in-page tap on mobile. */
async function openMenuItem(obsidian: PhoneInstance, label: string): Promise<void> {
  await obsidian.eval(`document.querySelector(${JSON.stringify(MOBILE)}).click(); return true;`);
  await expect(obsidian.win.locator(".menu .menu-item-title").first()).toBeVisible({
    timeout: 10_000,
  });
  await obsidian.eval(`
    (() => {
      const items = Array.from(document.querySelectorAll(".menu .menu-item"));
      const target = items.find(
        (i) => (i.querySelector(".menu-item-title")?.textContent || "").trim() === ${
    JSON.stringify(label)
  },
      );
      if (!target) throw new Error("menu item not found: " + ${JSON.stringify(label)});
      target.click();
      return true;
    })()
  `);
}

async function openHistory(obsidian: PhoneInstance, vaultPath: string): Promise<void> {
  await obsidian.eval(`
    const file = app.vault.getFileByPath(${JSON.stringify(vaultPath)});
    if (!file) throw new Error("expected " + ${JSON.stringify(vaultPath)} + " in the vault");
    await app.workspace.getLeaf(true).openFile(file);
    app.commands.executeCommandById("geode:geode-show-file-history");
    return true;
  `);
  await expect(obsidian.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
}

test("rename history (phone): a marker row and the oldest name behind it", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("rename-history");
  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
  });

  try {
    /* The reset vault starts locked: unlock with the test passphrase first. */
    await expect
      .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 30_000 })
      .toBe("Geode: locked");
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* ---- Two saves under the old name, then a real rename ---- */
    for (const body of ["first draft", "second draft"]) {
      await upsertVaultFile(obsidian, OLD_PATH, `# Phone rename\n\n${body}\n`);
      await commitPath(obsidian, OLD_PATH);
    }
    await obsidian.eval(`
      const entry = app.vault.getAbstractFileByPath(${JSON.stringify(OLD_PATH)});
      if (!entry) throw new Error("expected the note to rename: " + ${JSON.stringify(OLD_PATH)});
      await app.vault.rename(entry, ${JSON.stringify(NEW_PATH)});
      return true;
    `);
    await expect
      .poll(
        async () =>
          await obsidian.eval<number>(`
            const row = app.plugins.plugins.geode.state.getLocalFile(${JSON.stringify(NEW_PATH)});
            if (!row) return -1;
            const chain = await app.plugins.plugins.geode.transport.getVersionChain(row.path_hash);
            return chain[0] ? chain[0].rename_mark : 0;
          `),
        { timeout: 90_000 },
      )
      .toBe(2);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);

    /* ---- The new name has one save; Show older crosses the rename ---- */
    await openHistory(obsidian, NEW_PATH);
    await expect(obsidian.win.locator(`${MODAL} .modal-title`)).toHaveText(
      "History · renamed phone.md",
    );
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-marker"]`)).toHaveCount(
      0,
    );
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-older"]`);
    const markers = obsidian.win.locator(`${MODAL} [data-testid="geode-history-marker"]`);
    await expect(markers).toHaveCount(1, { timeout: 10_000 });
    await expect(markers.first()).toHaveText(`Renamed from ${OLD_PATH}`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-period"]`)).toHaveCount(
      2,
    );
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await obsidian.screenshot(shotPath("583-phone-01-marker.png"));

    /* ---- The oldest name's first save still previews, with Back ---- */
    await clickLast(obsidian, `${MODAL} [data-testid="geode-history-chevron"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-save"]`)).toHaveCount(
      2,
    );
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-save"][data-version="1"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-back"]`)).toBeVisible({
      timeout: 10_000,
    });
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("first draft");
    await obsidian.screenshot(shotPath("583-phone-02-oldest-preview.png"));

    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-back"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-marker"]`)).toHaveCount(
      1,
    );
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-done"]`);
    await expect(obsidian.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });

    /* ---- The renamed-away name from its activity row (uncapped) lists its own
       saves: its head row is the marker that renamed it away. ---- */
    await openMenuItem(obsidian, "Sync activity");
    await expect(obsidian.win.locator(ACTIVITY)).toBeVisible({ timeout: 10_000 });
    await evalClick(
      obsidian,
      `${ACTIVITY} [data-testid="geode-activity-row"][data-path="${OLD_PATH}"]`,
    );
    await expect(obsidian.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-empty"]`)).toHaveCount(
      0,
    );
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-period"]`)).toHaveCount(
      1,
    );
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-chevron"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-save"]`)).toHaveCount(
      2,
    );
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await obsidian.screenshot(shotPath("583-phone-03-renamed-away-name.png"));
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-done"]`);
    await expect(obsidian.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });
    await evalClick(obsidian, `${ACTIVITY} [data-testid="geode-activity-done"]`);
    await expect(obsidian.win.locator(ACTIVITY)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
