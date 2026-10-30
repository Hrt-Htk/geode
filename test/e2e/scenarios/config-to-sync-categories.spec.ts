import { expect, test } from "@playwright/test";
import { launchPair } from "../fixtures/pair";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

const PASSPHRASE = "config-to-sync-categories-pass";

// #454: Config to sync row + Manage modal, two real devices:
//  - the row is hidden while Sync config folder is off and appears in place when on
//  - the modal lists the 5 settings categories and the community plugins
//  - toggling Hotkeys off on B stops A's hotkeys.json change from reaching B;
//    toggling it back on brings it (catch-up)
//  - a plugin toggle still gates plugin data
//  - the row summary updates in place (no full settings re-render)

type Obsidian = Awaited<ReturnType<typeof launchPair>>["A"];

async function unlock(o: Obsidian): Promise<void> {
  await o.eval(
    `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
  );
  await waitForStatusBar(o.win, "Geode: synced", 60_000);
}

function configRead(o: Obsidian, path: string): Promise<string | null> {
  return o.eval(
    `(async () => { try { return await app.vault.adapter.read(${
      JSON.stringify(path)
    }); } catch { return null; } })()`,
  );
}

async function configWrite(o: Obsidian, path: string, content: string): Promise<void> {
  await o.eval(`
    (async () => {
      const parts = ${JSON.stringify(path)}.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
      }
      await app.vault.adapter.write(${JSON.stringify(path)}, ${JSON.stringify(content)});
      return true;
    })()
  `);
}

async function openSettings(o: Obsidian): Promise<void> {
  await o.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    app.setting.open();
    app.setting.openTabById("geode");
    return "ok";
  `);
}

test("config to sync row + modal (two devices)", async () => {
  test.slow();
  const pair = await launchPair({ passphrase: PASSPHRASE });
  const { A, B, server } = pair;
  try {
    await unlock(A);
    await unlock(B);

    // Seed a config file on A; both devices converge (categories default all on).
    await configWrite(A, ".obsidian/hotkeys.json", '{"seed":1}');
    await A.eval(`app.plugins.plugins.geode.pushNow(); return true;`);
    await expect.poll(async () => await configRead(B, ".obsidian/hotkeys.json"), {
      timeout: 60_000,
    })
      .toBe('{"seed":1}');

    // Inject fake community plugins on B so the summary has a plugin count.
    await B.eval(`
      app.plugins.manifests['dataview'] = { id:'dataview', name:'Dataview', version:'1.0.0', minAppVersion:'1.0.0', author:'x', description:'d' };
      app.plugins.manifests['templater-obsidian'] = { id:'templater-obsidian', name:'Templater', version:'1.0.0', minAppVersion:'1.0.0', author:'x', description:'t' };
      const s = app.plugins.plugins.geode.pluginSettings;
      s.syncedPlugins = ['dataview'];
      return true;
    `);

    /* ---- Row hidden while Sync config folder is off, appears in place when on ---- */
    await openSettings(B);
    await B.win.locator('[data-testid="geode-settings-config-row"]').waitFor({ timeout: 10_000 });
    // Scroll the settings pane so a full re-render would be visible as a scroll reset.
    await B.eval(`
      (() => {
        const el = document.querySelector(".vertical-tab-content");
        if (el) el.scrollTop = 120;
        return true;
      })()
    `);
    const scrollBefore = await B.eval<number>(
      `document.querySelector(".vertical-tab-content")?.scrollTop ?? 0`,
    );
    // Turn the folder toggle off → row disappears (change event, no focus-scroll).
    await B.eval(`
      (() => {
        const el = document.querySelector('[data-testid="geode-settings-toggle-sync-obsidian"]');
        el.checked = !el.checked;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()
    `);
    await expect(B.win.locator('[data-testid="geode-settings-config-row"]')).toHaveCount(0, {
      timeout: 10_000,
    });
    expect(
      await B.eval<number>(`document.querySelector(".vertical-tab-content")?.scrollTop ?? 0`),
      "no re-render on toggle off",
    )
      .toBe(scrollBefore);
    // Turn it back on → the row reappears in place (no full settings re-render).
    await B.eval(`
      (() => {
        const el = document.querySelector('[data-testid="geode-settings-toggle-sync-obsidian"]');
        el.checked = !el.checked;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()
    `);
    await expect(B.win.locator('[data-testid="geode-settings-config-row"]')).toHaveCount(1, {
      timeout: 10_000,
    });
    expect(
      await B.eval<number>(`document.querySelector(".vertical-tab-content")?.scrollTop ?? 0`),
      "no re-render on toggle on",
    )
      .toBe(scrollBefore);
    // The row's summary updates in place after this point: the same DOM node
    // survives every modal toggle (only its desc text changes).
    await B.eval(
      `window.__g454row = document.querySelector('[data-testid="geode-settings-config-row"]'); return true;`,
    );
    const summary0 = await B.win.locator(
      '[data-testid="geode-settings-config-row"] .setting-item-description',
    ).innerText();
    expect(summary0).toBe("Snippets, themes, hotkeys · 1 of 2 plugins");

    /* ---- Manage modal lists categories + plugins ---- */
    await B.win.locator('[data-testid="geode-settings-config-manage"]').click();
    const modal = B.win.locator(".geode-config-modal");
    await expect(modal).toBeVisible();
    await expect(B.win.locator('[data-testid="geode-config-category-appearance"]')).toBeVisible();
    await expect(B.win.locator('[data-testid="geode-config-category-snippets"]')).toBeVisible();
    await expect(B.win.locator('[data-testid="geode-config-category-hotkeys"]')).toBeVisible();
    await expect(B.win.locator('[data-testid="geode-config-category-corePlugins"]')).toBeVisible();
    await expect(B.win.locator('[data-testid="geode-config-category-other"]')).toBeVisible();
    await expect(B.win.locator('[data-testid="geode-config-plugin-dataview"]')).toBeVisible();
    await expect(B.win.locator('[data-testid="geode-config-plugin-templater-obsidian"]'))
      .toBeVisible();
    await expect(B.win.locator('[data-testid="geode-config-plugin-geode"]')).toHaveCount(0);
    await B.eval(`document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`);
    await modal.screenshot({ path: shotPath("config-modal.png") }).catch(async () => {
      await B.win.screenshot({ path: shotPath("config-modal.png") });
    });

    /* ---- Toggle Hotkeys off: summary updates in place, A's change doesn't reach B ---- */
    await B.win.locator('[data-testid="geode-config-category-hotkeys"]').click();
    await expect.poll(() =>
      B.win.locator('[data-testid="geode-settings-config-row"] .setting-item-description')
        .innerText()
    ).toBe("All settings except Hotkeys · 1 of 2 plugins");
    await B.eval(`document.querySelector('.geode-config-modal .mod-cta')?.click(); return true;`);

    await configWrite(A, ".obsidian/hotkeys.json", '{"seed":2}');
    await A.eval(`app.plugins.plugins.geode.pushNow(); return true;`);
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await configRead(B, ".obsidian/hotkeys.json")).toBe('{"seed":1}');
    expect(await configRead(A, ".obsidian/hotkeys.json")).toBe('{"seed":2}');

    /* ---- Toggle Hotkeys back on: catch-up brings A's change ---- */
    await B.win.locator('[data-testid="geode-settings-config-manage"]').click();
    await expect(B.win.locator('[data-testid="geode-config-category-hotkeys"]')).toBeVisible();
    await B.win.locator('[data-testid="geode-config-category-hotkeys"]').click();
    await expect.poll(async () => await configRead(B, ".obsidian/hotkeys.json"), {
      timeout: 60_000,
    })
      .toBe('{"seed":2}');

    /* ---- A plugin toggle still gates plugin data ---- */
    // A opts both plugins in so it uploads their data; B has only dataview.
    await A.eval(
      `app.plugins.plugins.geode.pluginSettings.syncedPlugins = ['dataview', 'templater-obsidian']; return true;`,
    );
    // Templater is off on B: A writes its data, B must not receive it.
    await B.eval(`document.querySelector('.geode-config-modal .mod-cta')?.click(); return true;`);
    await configWrite(A, ".obsidian/plugins/templater-obsidian/data.json", '{"t":1}');
    await A.eval(`app.plugins.plugins.geode.pushNow(); return true;`);
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await configRead(B, ".obsidian/plugins/templater-obsidian/data.json")).toBeNull();

    // Toggle Templater on in the modal, then A's data flows to B.
    await B.win.locator('[data-testid="geode-settings-config-manage"]').click();
    await expect(B.win.locator('[data-testid="geode-config-plugin-templater-obsidian"]'))
      .toBeVisible();
    await B.win.locator('[data-testid="geode-config-plugin-templater-obsidian"]').click();
    await expect.poll(() =>
      B.eval(`JSON.stringify(app.plugins.plugins.geode.pluginSettings.syncedPlugins)`)
    ).toContain("templater-obsidian");
    // Summary shows both plugins now.
    await expect.poll(() =>
      B.win.locator('[data-testid="geode-settings-config-row"] .setting-item-description')
        .innerText()
    ).toBe("Snippets, themes, hotkeys · 2 of 2 plugins");
    await configWrite(A, ".obsidian/plugins/templater-obsidian/data.json", '{"t":2}');
    await A.eval(`app.plugins.plugins.geode.pushNow(); return true;`);
    await expect.poll(
      async () => await configRead(B, ".obsidian/plugins/templater-obsidian/data.json"),
      { timeout: 60_000 },
    )
      .toBe('{"t":2}');

    // The row node survived every in-place summary update.
    await expect.poll(() =>
      B.eval(
        `window.__g454row === document.querySelector('[data-testid="geode-settings-config-row"]')`,
      )
    ).toBe(true);
  } finally {
    await pair.stop();
    void server;
  }
});
