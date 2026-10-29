import { expect, test } from "@playwright/test";
import { launchPair } from "../fixtures/pair";
import { waitForStatusBar } from "../helpers/waits";
import { shotPath } from "../helpers/shots";

const PASSPHRASE = "sync-folders-pass";

// #342: Sync folders scope, two real devices:
//  - B switches a folder off in the Manage tree; A's edits there don't reach B
//  - switching back on brings them (catch-up to server heads)
//  - a subfolder switched on inside an off folder syncs; the parent shows partial
//  - the row summary updates in place (no full settings re-render)

async function unlock(o: Awaited<ReturnType<typeof launchPair>>["A"]) {
  await o.eval(
    `await app.plugins.plugins.geode.unlockVault(${JSON.stringify(PASSPHRASE)}); return true;`,
  );
  await waitForStatusBar(o.win, "Geode: synced", 60_000);
}

function vaultFile(
  o: Awaited<ReturnType<typeof launchPair>>["A"],
  path: string,
): Promise<string | null> {
  return o.eval(
    `(async () => { try { return await app.vault.adapter.read(${
      JSON.stringify(path)
    }); } catch { return null; } })()`,
  );
}

async function vaultWrite(
  o: Awaited<ReturnType<typeof launchPair>>["A"],
  path: string,
  content: string,
) {
  await o.eval(`
    (async () => {
      const folder = ${JSON.stringify(path)}.split("/").slice(0, -1).join("/");
      if (folder && !(await app.vault.adapter.exists(folder))) await app.vault.createFolder(folder);
      const existing = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
      if (existing) await app.vault.modify(existing, ${JSON.stringify(content)});
      else await app.vault.create(${JSON.stringify(path)}, ${JSON.stringify(content)});
      return true;
    })()
  `);
}

async function vaultDelete(o: Awaited<ReturnType<typeof launchPair>>["A"], path: string) {
  await o.eval(`
    (async () => {
      const f = app.vault.getAbstractFileByPath(${JSON.stringify(path)});
      if (f) await app.vault.delete(f);
      return true;
    })()
  `);
}

async function openSettings(o: Awaited<ReturnType<typeof launchPair>>["A"]) {
  await o.eval(`
    if (app.setting && typeof app.setting.close === "function") app.setting.close();
    app.setting.open();
    app.setting.openTabById("geode");
    return "ok";
  `);
}

test("sync folders scope (two devices)", async () => {
  test.slow();
  const pair = await launchPair({ passphrase: PASSPHRASE });
  const { A, B, server } = pair;
  try {
    await unlock(A);
    await unlock(B);

    // Seed: A creates a folder tree with files; both devices converge.
    // Projects has two child folders so a switched on child leaves a partial parent.
    await vaultWrite(A, "Projects/a.md", "alpha v1");
    await vaultWrite(A, "Projects/b.md", "beta v1");
    await vaultWrite(A, "Projects/Geode/g.md", "geode v1");
    await vaultWrite(A, "Projects/Old/o.md", "old v1");
    await expect.poll(async () => await vaultFile(B, "Projects/a.md"), { timeout: 60_000 }).toBe(
      "alpha v1",
    );
    await expect.poll(async () => await vaultFile(B, "Projects/Geode/g.md"), { timeout: 60_000 })
      .toBe("geode v1");

    // B opens the settings tab; capture the row element to prove in-place updates.
    await openSettings(B);
    await B.win.locator('[data-testid="geode-settings-folders-row"]').waitFor();
    const rowText0 = await B.win.locator(
      '[data-testid="geode-settings-folders-row"] .setting-item-description',
    ).innerText();
    expect(rowText0).toBe("All folders sync");
    await B.eval(
      `window.__g342row = document.querySelector('[data-testid="geode-settings-folders-row"]'); return true;`,
    );
    await B.eval(
      `document.querySelector('[data-testid="geode-settings-folders-row"]')?.scrollIntoView({ block: "center" }); return true;`,
    );
    await B.win.locator(".modal.mod-settings").screenshot({ path: shotPath("row-all-sync.png") })
      .catch(async () => {
        await B.win.screenshot({ path: shotPath("row-all-sync.png") });
      });

    // B opens Manage and switches Projects off.
    await B.win.locator('[data-testid="geode-settings-folders-manage"]').click();
    await B.win.locator('[data-testid="geode-folder-row"][data-path="Projects"]').waitFor();
    await B.win.locator('[data-testid="geode-folders-tree"]').screenshot({
      path: shotPath("manage-tree.png"),
    })
      .catch(async () => {
        await B.win.screenshot({ path: shotPath("manage-tree.png") });
      });
    await B.win.locator('[data-testid="geode-folder-toggle"][data-path="Projects"]').click();

    // The row summary updated in place: same DOM node, new text.
    await expect.poll(() =>
      B.eval(
        `window.__g342row === document.querySelector('[data-testid="geode-settings-folders-row"]')`,
      )
    ).toBe(true);
    const rowText1 = await B.win.locator(
      '[data-testid="geode-settings-folders-row"] .setting-item-description',
    ).innerText();
    expect(rowText1).toContain("All folders sync except 1");
    expect(rowText1).toContain("Projects/");

    // A's edits inside the excluded folder don't reach B.
    await vaultWrite(A, "Projects/a.md", "alpha v2");
    await vaultDelete(A, "Projects/b.md");
    await A.eval(`app.plugins.plugins.geode.pushNow(); return true;`);
    // Give the server time to record the versions, then assert B is untouched.
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await vaultFile(B, "Projects/a.md")).toBe("alpha v1");
    expect(await vaultFile(B, "Projects/b.md")).toBe("beta v1");

    // B re-includes Projects: catch-up brings the edit and the delete.
    await B.win.locator('[data-testid="geode-folder-toggle"][data-path="Projects"]').click();
    await expect.poll(async () => await vaultFile(B, "Projects/a.md"), { timeout: 60_000 }).toBe(
      "alpha v2",
    );
    await expect.poll(async () => await vaultFile(B, "Projects/b.md"), { timeout: 60_000 })
      .toBeNull();

    // #342: B excludes Projects again and deletes a.md locally (free-space use
    // case). Re-including must restore it from the server, not delete it for every
    // device.
    await B.win.locator('[data-testid="geode-folder-toggle"][data-path="Projects"]').click();
    await vaultDelete(B, "Projects/a.md");
    await B.eval(`app.plugins.plugins.geode.pushNow(); return true;`);
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await vaultFile(B, "Projects/a.md")).toBeNull();
    expect(await vaultFile(A, "Projects/a.md")).toBe("alpha v2");
    // Re-include: the file comes back on B and is still on A.
    await B.win.locator('[data-testid="geode-folder-toggle"][data-path="Projects"]').click();
    await expect.poll(async () => await vaultFile(B, "Projects/a.md"), { timeout: 60_000 }).toBe(
      "alpha v2",
    );
    expect(await vaultFile(A, "Projects/a.md")).toBe("alpha v2");

    // Subfolder exception: Projects off again, then Projects/Geode on.
    await B.win.locator('[data-testid="geode-folder-toggle"][data-path="Projects"]').click();
    // Expand Projects to reveal the child toggle, then switch the child on.
    await B.win.locator('[data-testid="geode-folder-row"][data-path="Projects"]').click();
    await B.win.locator('[data-testid="geode-folder-toggle"][data-path="Projects/Geode"]')
      .waitFor();
    await B.win.locator('[data-testid="geode-folder-toggle"][data-path="Projects/Geode"]').click();
    // Parent row now shows the partial badge.
    await expect(
      B.win.locator('[data-testid="geode-folder-row"][data-path="Projects"] .geode-folder-partial'),
    ).toHaveCount(1);
    await B.win.locator('[data-testid="geode-folders-tree"]').screenshot({
      path: shotPath("manage-partial.png"),
    })
      .catch(async () => {
        await B.win.screenshot({ path: shotPath("manage-partial.png") });
      });

    // The row summary shows the partly clause.
    const rowText2 = await B.win.locator(
      '[data-testid="geode-settings-folders-row"] .setting-item-description',
    ).innerText();
    expect(rowText2).toContain("partly");
    expect(rowText2).toContain("Geode/ only");
    // Close the modal so the row itself is visible in the shot.
    await B.win.locator(".modal .mod-cta").last().click();
    await B.eval(
      `document.querySelector('[data-testid="geode-settings-folders-row"]')?.scrollIntoView({ block: "center" }); return true;`,
    );
    await B.win.locator(".modal.mod-settings").screenshot({ path: shotPath("row-partial.png") })
      .catch(async () => {
        await B.win.screenshot({ path: shotPath("row-partial.png") });
      });

    // The switched on subfolder syncs; its off sibling does not.
    await vaultWrite(A, "Projects/Geode/g.md", "geode v2");
    await vaultWrite(A, "Projects/c.md", "gamma v1");
    await A.eval(`app.plugins.plugins.geode.pushNow(); return true;`);
    await expect.poll(async () => await vaultFile(B, "Projects/Geode/g.md"), { timeout: 60_000 })
      .toBe("geode v2");
    await new Promise((r) => setTimeout(r, 5_000));
    expect(await vaultFile(B, "Projects/c.md")).toBeNull();
  } finally {
    await pair.stop();
    void server;
  }
});
