import { expect, test } from "@playwright/test";
import { launchObsidian, type ObsidianInstance } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

// #29: a click in the history window redraws only what it changed, and the list
// keeps its width whatever the preview holds. One period of three saves, the oldest
// a paragraph far wider than the window: open the day, pick each save, toggle
// Changes, close the day. The list width is read the moment each click returns and
// again once the preview lands; the preview element must survive a day opening or
// closing.
const PASSPHRASE = "history-redraw-pass";
const NOTE = "Notes/Redraw.md";
const MODAL = ".geode-history-modal";
const LONG = "a long line that runs well past the window ".repeat(40);

/** Click in the renderer, then read the list width before any async work lands. */
async function clickAndMeasure(o: ObsidianInstance, selector: string): Promise<number> {
  return await o.eval<number>(`
    const el = document.querySelector(${JSON.stringify(`${MODAL} ${selector}`)});
    if (!el) throw new Error("missing " + ${JSON.stringify(selector)});
    el.click();
    return document.querySelector(${JSON.stringify(`${MODAL} .geode-history-list`)})
      .getBoundingClientRect().width;
  `);
}

async function listWidth(o: ObsidianInstance): Promise<number> {
  return await o.eval<number>(
    `document.querySelector(${
      JSON.stringify(`${MODAL} .geode-history-list`)
    }).getBoundingClientRect().width`,
  );
}

/** Tag the preview's current content node, so a rebuild shows as a new node. */
async function tagPreview(o: ObsidianInstance, testid: string): Promise<void> {
  await o.eval(`
    const el = document.querySelector(${JSON.stringify(`${MODAL} [data-testid="${testid}"]`)});
    if (!el) throw new Error("missing " + ${JSON.stringify(testid)});
    el.dataset.redrawTag = "kept";
    return true;
  `);
}

async function previewKept(o: ObsidianInstance, testid: string): Promise<boolean> {
  return await o.eval<boolean>(
    `document.querySelector(${
      JSON.stringify(`${MODAL} [data-testid="${testid}"]`)
    })?.dataset.redrawTag === "kept"`,
  );
}

test("history window: a click redraws only what it changed and the list keeps its width", async () => {
  test.slow();
  const server = await startServer();
  const device = await server.mintToken("history-redraw");
  const o = await launchObsidian({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
    },
    unlockPassphrase: PASSPHRASE,
  });

  try {
    await waitForUnlocked(o);
    await waitForStatusBar(o.win, "Geode: synced", 60_000);
    for (const body of [LONG, "short second save", "short third save"]) {
      await upsertVaultFile(o, NOTE, `# Redraw\n\n${body}\n`);
      await commitPath(o, NOTE);
    }

    await o.eval(`
      const file = app.vault.getFileByPath(${JSON.stringify(NOTE)});
      await app.workspace.getLeaf(true).openFile(file);
      app.commands.executeCommandById("geode:geode-show-file-history");
      return true;
    `);
    const markdown = o.win.locator(`${MODAL} [data-testid="geode-history-markdown"]`);
    await expect(markdown).toContainText("short third save", { timeout: 15_000 });
    const width = await listWidth(o);
    expect(width).toBeGreaterThan(0);
    const same = (label: string, w: number) =>
      expect.soft(Math.abs(w - width), `${label}: list ${w}px, opened at ${width}px`)
        .toBeLessThan(1);
    await o.win.screenshot({ path: shotPath("history-redraw-01-open.png") });

    /* ---- Opening the day rebuilds the list, not the preview ---- */
    await tagPreview(o, "geode-history-markdown");
    same("open day", await clickAndMeasure(o, '[data-testid="geode-history-chevron"]'));
    await expect(o.win.locator(`${MODAL} [data-testid="geode-history-save"]`)).toHaveCount(3);
    expect.soft(await previewKept(o, "geode-history-markdown"), "open day kept the preview")
      .toBe(true);
    await o.win.screenshot({ path: shotPath("history-redraw-02-day-open.png") });

    /* ---- Picking the long save: the list holds its width while loading and after ---- */
    const oldest = '[data-testid="geode-history-save"][data-version="1"]';
    same("select long save", await clickAndMeasure(o, oldest));
    await expect(markdown).toContainText("runs well past", { timeout: 15_000 });
    same("long save landed", await listWidth(o));
    await expect(o.win.locator(`${MODAL} ${oldest}`)).toHaveClass(/is-active/);
    await o.win.screenshot({ path: shotPath("history-redraw-03-long-save.png") });

    const second = '[data-testid="geode-history-save"][data-version="2"]';
    same("select short save", await clickAndMeasure(o, second));
    await expect(markdown).toContainText("short second save", { timeout: 15_000 });
    same("short save landed", await listWidth(o));

    /* ---- Changes swaps the preview only; the list stays put ---- */
    await o.win.locator(`${MODAL} [data-testid="geode-history-chevron"]`).evaluate((el) =>
      el.setAttribute("data-redraw-tag", "kept")
    );
    same("changes", await clickAndMeasure(o, '[data-testid="geode-history-diff-toggle"]'));
    await expect(o.win.locator(`${MODAL} [data-testid="geode-history-diff"]`)).toBeVisible({
      timeout: 15_000,
    });
    expect.soft(
      await o.eval<boolean>(
        `document.querySelector('${MODAL} [data-testid="geode-history-chevron"]')?.dataset.redrawTag === "kept"`,
      ),
      "Changes kept the list",
    ).toBe(true);
    same("diff landed", await listWidth(o));
    await o.win.screenshot({ path: shotPath("history-redraw-04-changes.png") });

    /* ---- Closing the day keeps the diff as it is ---- */
    await tagPreview(o, "geode-history-diff");
    same("close day", await clickAndMeasure(o, '[data-testid="geode-history-chevron"]'));
    await expect(o.win.locator(`${MODAL} [data-testid="geode-history-save"]`)).toHaveCount(0);
    expect.soft(await previewKept(o, "geode-history-diff"), "close day kept the preview")
      .toBe(true);
    await o.win.screenshot({ path: shotPath("history-redraw-05-day-closed.png") });
  } finally {
    await o.close();
    await server.stop?.();
  }
});
