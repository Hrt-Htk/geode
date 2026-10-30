import { expect, test } from "@playwright/test";
import { DEMO_PASSPHRASE, readDemoNotes } from "../fixtures/demo-vault";
import { connectPhone } from "../fixtures/phone-obsidian";
import { useRemoteServer } from "../fixtures/phone-server";
import { commitPath, upsertVaultFile, waitForUnlocked } from "../helpers/geode";
import { dismissModals, evalClick } from "../helpers/mobile-ui";
import { docsShot } from "../helpers/shots";
import { readGeodeStatusBar, waitForStatusBar } from "../helpers/waits";

// #8: the phone half of the committed docs images, on the real Android device: the status icon
// with its menu open, and the file history window. Run by `deno task docs:screenshots` (the
// `docs` project only); the phone lock and the test-vault interlock come from global-setup.

const NOTE = "3 - Areas/Daily notes/2026/10/2026-10-06-tuesday.md";

type DemoNote = { path: string; content: string };

/** Writes the demo vault's notes into the device's (reset) vault, then commits them in one pass. */
async function seedDemoVaultOnDevice(
  obsidian: Awaited<ReturnType<typeof connectPhone>>,
  notes: DemoNote[],
) {
  await obsidian.eval(`
    (async () => {
      const files = ${JSON.stringify(notes)};
      const folders = new Set();
      for (const f of files) {
        const folder = f.path.split("/").slice(0, -1).join("/");
        let acc = "";
        for (const seg of folder.split("/")) {
          if (!seg) continue;
          acc = acc ? acc + "/" + seg : seg;
          folders.add(acc);
        }
      }
      for (const folder of [...folders].sort((a, b) => a.split("/").length - b.split("/").length)) {
        if (!(await app.vault.adapter.exists(folder))) await app.vault.createFolder(folder);
      }
      for (const f of files) await app.vault.create(f.path, f.content);
      return files.length;
    })()
  `);
  await obsidian.eval(`
    await app.plugins.plugins.geode.syncManager.handlePendingOps(
      ${JSON.stringify(notes.map((n) => n.path))}.map((path) => ({ path, kind: "commit" })),
    );
    return true;
  `);
}

async function darkTheme(obsidian: Awaited<ReturnType<typeof connectPhone>>): Promise<void> {
  await obsidian.eval(`
    app.changeTheme("obsidian");
    await new Promise((r) => setTimeout(r, 500));
    return document.body.className;
  `);
  await expect
    .poll(async () => await obsidian.eval<string>("document.body.className"))
    .toContain("theme-dark");
}

test("demo vault (phone): status menu and file history", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires the connected phone (GEODE_PHONE=1)");
  test.setTimeout(15 * 60_000);

  const notes = await readDemoNotes();
  const base = notes.find((n) => n.path === NOTE)?.content ?? "";
  const edit1 = base.replace("# What moved", "# What moved\n- Walked the coast path in the rain.");
  const edit2 = edit1.replace(
    "- Walked the coast path in the rain.",
    "- Walked the coast path in the rain, then the harbour wall at dusk.",
  );
  const server = await useRemoteServer();
  const device = await server.mintToken("Phone");
  const obsidian = await connectPhone({
    geodeSettings: {
      serverUrl: server.url,
      vaultId: server.vaultId,
      deviceId: device.deviceId,
      deviceToken: device.token,
      salt: server.salt,
      deviceName: "Phone",
      syncObsidianConfig: false,
    },
    keepStartupModal: true,
  });

  try {
    await expect.poll(async () => await readGeodeStatusBar(obsidian.win), { timeout: 60_000 })
      .toBe("Geode: locked");
    await obsidian.eval(
      `await app.plugins.plugins.geode.unlockVault(${
        JSON.stringify(DEMO_PASSPHRASE)
      }); return true;`,
    );
    await waitForUnlocked(obsidian);
    await seedDemoVaultOnDevice(obsidian, notes);
    await waitForStatusBar(obsidian.win, "Geode: synced", 180_000);
    await dismissModals(obsidian);
    await darkTheme(obsidian);

    /* ---- The status icon with its menu open, over a demo note ---- */
    await obsidian.eval(`
      const file = app.vault.getFileByPath(${JSON.stringify(NOTE)});
      if (!file) throw new Error("expected " + ${JSON.stringify(NOTE)} + " in the vault");
      await app.workspace.getLeaf(true).openFile(file);
      return true;
    `);
    await obsidian.eval(
      `document.querySelector('[data-testid="geode-mobile-status"]').click(); return true;`,
    );
    await expect(obsidian.win.locator(".menu .menu-item-title").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(obsidian.win.locator(".menu .menu-item-title")).toHaveCount(6);
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await new Promise((r) => setTimeout(r, 500));
    await obsidian.win.screenshot({
      path: docsShot("status-menu-phone"),
      scale: "css",
      animations: "disabled",
    });
    await obsidian.eval(
      `document.querySelector(".menu")?.remove(); document.querySelector(".menu-container")?.remove(); return true;`,
    );

    /* ---- File history on the device: a note with two saves, previewed ---- */
    await upsertVaultFile(obsidian, NOTE, edit1);
    await commitPath(obsidian, NOTE);
    await upsertVaultFile(obsidian, NOTE, edit2);
    await commitPath(obsidian, NOTE);
    await waitForStatusBar(obsidian.win, "Geode: synced", 60_000);
    await expect
      .poll(
        () =>
          obsidian.eval<number>(
            `app.plugins.plugins.geode.state.getLocalFile(${
              JSON.stringify(NOTE)
            })?.last_seen_version ?? 0`,
          ),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(1);
    await obsidian.eval(`
      const file = app.vault.getFileByPath(${JSON.stringify(NOTE)});
      await app.workspace.getLeaf(true).openFile(file);
      app.commands.executeCommandById("geode:geode-show-file-history");
      return true;
    `);
    const modal = obsidian.win.locator(".geode-history-modal");
    await expect(modal).toBeVisible({ timeout: 20_000 });
    await evalClick(obsidian, `.geode-history-modal [data-testid="geode-history-period"]`);
    await expect(obsidian.win.locator('[data-testid="geode-history-back"]')).toBeVisible({
      timeout: 15_000,
    });
    // Tapping the period previews its newest save; the phone keeps the two panes stacked.
    await expect(obsidian.win.locator('[data-testid="geode-history-markdown"]')).toContainText(
      "the harbour wall at dusk",
    );
    await obsidian.eval(
      `document.querySelectorAll(".notice").forEach((n) => n.remove()); return true;`,
    );
    await obsidian.win.screenshot({
      path: docsShot("file-history-phone"),
      scale: "css",
      animations: "disabled",
    });
  } finally {
    await obsidian.close();
    await server.stop?.().catch(() => {});
  }
});
