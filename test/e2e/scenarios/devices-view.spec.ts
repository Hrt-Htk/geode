import { expect, test } from "@playwright/test";
import { launchPair } from "../fixtures/pair";
import { waitForStatusBar } from "../helpers/waits";
import {
  commitPath,
  disconnectSync,
  reconnectSync,
  upsertVaultFile,
  waitForUnlocked,
} from "../helpers/geode";
import { shotPath } from "../helpers/shots";

// #433: the Devices view (and the settings Devices section) are readable with
// the DEVICE token: device B (no admin token) sees both devices. After A commits
// while B is offline, A's view shows B "N changes behind"; once B reconnects and
// catches up, B reports its applied position and the view flips to "Up to date".
const PASSPHRASE = "devices-view-pass";

const FILES = ["notes/a.md", "notes/b.md", "notes/c.md"];

async function openDevicesView(
  instance: { win: import("@playwright/test").Page; eval: <T>(s: string) => Promise<T> },
): Promise<void> {
  await instance.eval(`app.setting.open(); app.setting.openTabById("geode"); return true;`);
  const win = instance.win;
  await win.locator('[data-testid="geode-settings-devices-manage"]').click();
  await win.locator('[data-testid="geode-devices-modal"]').waitFor();
  await win.locator('[data-testid="geode-device-row"]').first().waitFor({ timeout: 15_000 });
}

async function closeDevicesView(
  instance: { eval: <T>(s: string) => Promise<T> },
): Promise<void> {
  await instance.eval(
    `document.querySelector('[data-testid="geode-devices-done"]')?.click(); app.setting?.close?.(); return true;`,
  );
}

async function rowDesc(
  win: import("@playwright/test").Page,
  deviceName: string,
): Promise<string> {
  const row = win.locator('[data-testid="geode-device-row"]', { hasText: deviceName });
  return (await row.locator(".geode-device-desc").textContent()) ?? "";
}

async function serverStatus(
  server: { url: string; vaultId: string },
  token: string,
): Promise<{ headSeq: number; deviceApplied: Map<string, number> }> {
  const res = await fetch(`${server.url}/vaults/${server.vaultId}/devices/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`devices/status fetch failed: ${res.status}`);
  const body = (await res.json()) as {
    head_seq: number;
    devices: Array<{ name: string; applied_seq: number }>;
  };
  const deviceApplied = new Map(body.devices.map((d) => [d.name, d.applied_seq]));
  return { headSeq: body.head_seq, deviceApplied };
}

test("devices view: device-token list, N changes behind, then up to date", async () => {
  test.slow();
  const pair = await launchPair({ passphrase: PASSPHRASE });
  const { A, B, server } = pair;
  try {
    await waitForUnlocked(A);
    await waitForUnlocked(B);
    await waitForStatusBar(A.win, "Geode: synced", 60_000);
    await waitForStatusBar(B.win, "Geode: synced", 60_000);

    /* ---- B (no admin token) sees both devices ---- */
    await openDevicesView(B);
    const bRows = B.win.locator('[data-testid="geode-device-row"]');
    await expect(bRows).toHaveCount(2);
    const bNames = (await bRows.locator(".geode-device-name").allTextContents()).map((n) =>
      n.trim()
    );
    expect(bNames.some((n) => n.includes("device-A"))).toBe(true);
    expect(bNames.some((n) => n.includes("device-B"))).toBe(true);
    await B.win.locator('[data-testid="geode-devices-modal"]').screenshot({
      path: shotPath("433-00-b-sees.png"),
    });
    await closeDevicesView(B);

    /* ---- A commits while B is offline ---- */
    const aTokenValue = await A.eval<string>(
      "app.plugins.plugins.geode.settings.deviceToken",
    );
    await disconnectSync(B);
    for (const file of FILES) {
      await upsertVaultFile(A, file, `content of ${file}\n`);
      await commitPath(A, file);
    }

    // Wait until the server head reflects A's commits, A has reported its own
    // applied position, and B's is still stale (the pre-catch-up baseline, 0 on
    // a fresh vault).
    let head = 0;
    let bApplied = -1;
    await expect.poll(async () => {
      const s = await serverStatus(server, aTokenValue);
      head = s.headSeq;
      bApplied = s.deviceApplied.get("device-B") ?? -1;
      const aApplied = s.deviceApplied.get("device-A") ?? -1;
      return aApplied >= head && head >= FILES.length && bApplied >= 0 && bApplied < head;
    }, { timeout: 30_000 }).toBe(true);

    const expectedBehind = head - bApplied;
    expect(expectedBehind).toBeGreaterThanOrEqual(FILES.length);

    /* ---- A's view shows B "N changes behind" ---- */
    await openDevicesView(A);
    await expect.poll(async () => await rowDesc(A.win, "device-B"), { timeout: 15_000 })
      .toMatch(/changes behind$/);
    await A.win.locator('[data-testid="geode-devices-modal"]').screenshot({
      path: shotPath("433-01-behind.png"),
    });
    await closeDevicesView(A);

    /* ---- B reconnects, catches up, reports its applied position ---- */
    await reconnectSync(B);
    await expect.poll(async () => {
      const s = await serverStatus(server, aTokenValue);
      return (s.deviceApplied.get("device-B") ?? -1) >= s.headSeq;
    }, { timeout: 60_000 }).toBe(true);

    /* ---- A's view flips B to "Up to date" ---- */
    await openDevicesView(A);
    await expect.poll(async () => await rowDesc(A.win, "device-B"), { timeout: 30_000 })
      .toMatch(/Up to date$/);
    await A.win.locator('[data-testid="geode-devices-modal"]').screenshot({
      path: shotPath("433-02-uptodate.png"),
    });
    await closeDevicesView(A);
  } finally {
    await pair.stop();
  }
});
