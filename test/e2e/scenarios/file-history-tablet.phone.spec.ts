import { expect, test } from "@playwright/test";
import { connectPhone, type PhoneInstance } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { shotPath } from "../helpers/shots";

// #24: a tablet is mobile but wide, so the history window keeps the desktop two-pane layout:
// the period list at 40%, the selected version beside it, nothing left empty or cut. The
// window's layout keys on the phone (`Platform.isPhone`, `body:not(.is-phone)`), never on
// mobile, or the tablet gets the phone's single pane at desktop size.
const PASSPHRASE = "file-history-tablet-pass";
const NOTE = "history-tablet-notes.md";

const MODAL = ".geode-history-modal";

type Box = {
  left: number;
  right: number;
  width: number;
  height: number;
  /** How much of the box is clipped away: 0 when it holds all of its content. */
  cut: number;
};

type Layout = {
  viewport: { width: number; height: number };
  /** The styles' `body:not(.is-phone)`, which is what gives the tablet two panes. */
  isPhone: boolean;
  modal: Box;
  body: Box;
  list: Box | null;
  pane: Box | null;
  back: number;
  controls: Box[];
};

async function tabletLayout(obsidian: PhoneInstance): Promise<Layout> {
  return await obsidian.eval<Layout>(`
    (() => {
      const modal = document.querySelector(${JSON.stringify(MODAL)});
      if (!modal) throw new Error("tabletLayout: the history modal is not open");
      const body = modal.querySelector(".geode-history-body");
      if (!body) throw new Error("tabletLayout: the history body is missing");
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          width: r.width,
          height: r.height,
          cut: Math.max(el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight),
        };
      };
      const found = (selector) => {
        const el = modal.querySelector(selector);
        return el ? box(el) : null;
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        isPhone: document.body.classList.contains("is-phone"),
        modal: box(modal),
        body: box(body),
        list: found(".geode-history-list"),
        pane: found('[data-testid="geode-history-pane"]'),
        back: modal.querySelectorAll('[data-testid="geode-history-back"]').length,
        controls: [
          ...modal.querySelectorAll(
            "button, .geode-history-period-head, .geode-history-version, .geode-history-event, " +
              ".geode-history-older",
          ),
        ].map(box),
      };
    })()
  `);
}

/** #24: the two-pane window on the tablet, in the state on screen: the list at 40% with the
 * preview beside it, the content most of the window, nothing cut or out of it. Soft, so one run
 * reports every defect (and every state still gets its shot) instead of only the first. */
function expectTwoPanes(l: Layout): void {
  expect.soft(l.isPhone, "the styles call the tablet a phone, so code and styles disagree (#24)")
    .toBe(false);
  expect.soft(l.list, "the window has no period list").not.toBeNull();
  expect.soft(l.pane, "the window has no preview pane: the list leaves the rest of it empty")
    .not.toBeNull();
  if (!l.list || !l.pane) return;
  expect.soft(l.pane.left, "the preview is not beside the list, so the panes are stacked")
    .toBeGreaterThanOrEqual(l.list.right - 1);
  expect.soft(l.list.width / l.body.width, "the list is not the desktop 40%").toBeCloseTo(0.4, 1);
  expect.soft(
    Math.abs(l.body.right - l.pane.right),
    "the preview stops short of the window, leaving the right side empty",
  ).toBeLessThanOrEqual(2);
  expect.soft(l.body.height / l.modal.height, "the content is a sliver of the window")
    .toBeGreaterThan(0.6);
  expect.soft(l.back, "the phone's Back button is on the tablet").toBe(0);
  expect.soft(
    l.controls.filter((c) => c.cut > 0).length,
    "controls the window cuts, such as a button in half",
  ).toBe(0);
  expect.soft(
    l.controls.filter((c) => c.left < l.modal.left - 1 || c.right > l.modal.right + 1).length,
    "controls outside the window",
  ).toBe(0);
}

/** Measure, shoot, then judge: the shot is evidence even when the state is broken. */
async function shootAndJudge(obsidian: PhoneInstance, name: string): Promise<void> {
  const l = await tabletLayout(obsidian);
  const orient = l.viewport.width > l.viewport.height ? "landscape" : "portrait";
  await clearNotices(obsidian);
  await obsidian.screenshot(shotPath(`24-tablet-${orient}-${name}.png`));
  expectTwoPanes(l);
}

async function openHistory(obsidian: PhoneInstance): Promise<void> {
  await obsidian.eval(`
    const file = app.vault.getFileByPath(${JSON.stringify(NOTE)});
    if (!file) throw new Error("expected " + ${JSON.stringify(NOTE)} + " in the vault");
    await app.workspace.getLeaf(true).openFile(file);
    app.commands.executeCommandById("geode:show-file-history");
    return true;
  `);
  await expect(obsidian.win.locator(MODAL)).toBeVisible({ timeout: 10_000 });
}

/** Notices fade over the modal: clear them so the shot shows it alone. */
async function clearNotices(obsidian: PhoneInstance): Promise<void> {
  await obsidian.eval(
    `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
  );
}

test("file history (tablet): the two-pane window, in portrait and landscape", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected tablet (GEODE_PHONE=1)");
  test.skip(process.env.GEODE_TABLET !== "1", "requires the tablet (GEODE_TABLET=1)");
  test.slow();

  const server = await useRemoteServer();
  const device = await server.mintToken("tablet");
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
    await expect
      .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 30_000 })
      .toBe("Geode: locked");
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
    );
    await waitForUnlocked(obsidian);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await dismissModals(obsidian);

    /* ---- One editing period with two saves ---- */
    await upsertVaultFile(obsidian, NOTE, "# Tablet history\n\nfirst save\n");
    await commitPath(obsidian, NOTE);
    await upsertVaultFile(obsidian, NOTE, "# Tablet history\n\nsecond save\n");
    await commitPath(obsidian, NOTE);
    await expect
      .poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 60_000 })
      .toContain("Geode: synced");

    /* ---- List: the period expanded into its save times, beside the first version ---- */
    await openHistory(obsidian);
    await expect(obsidian.win.locator(`${MODAL} .modal-title`)).toHaveText(
      `History · ${NOTE}`,
    );
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-period"]`))
      .toHaveCount(1);
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-chevron"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-save"]`)).toHaveCount(
      2,
    );
    await shootAndJudge(obsidian, "01-list");

    /* ---- Preview: the older save selected, both panes still on screen ---- */
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-save"][data-version="1"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`))
      .toContainText("first save", { timeout: 20_000 });
    await shootAndJudge(obsidian, "02-preview");

    /* ---- Changes: the diff beside the list, with Show version and Restore in its toolbar ---- */
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-diff-toggle"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-diff-toggle"]`))
      .toHaveText("Show version", { timeout: 20_000 });
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-diff"]`)).toBeVisible();
    await shootAndJudge(obsidian, "03-changes");

    /* The two panes survive the round trip, so the layout is not a one-state fluke. */
    await evalClick(obsidian, `${MODAL} [data-testid="geode-history-diff-toggle"]`);
    await expect(obsidian.win.locator(`${MODAL} [data-testid="geode-history-diff-toggle"]`))
      .toHaveText("Changes");
    expectTwoPanes(await tabletLayout(obsidian));

    expect(await obsidian.consoleErrors(), "Geode errors on the device").toEqual([]);

    await dismissModals(obsidian);
    await expect(obsidian.win.locator(MODAL)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
