import { expect } from "@playwright/test";
import type { Evaluatable } from "./device-abstraction";

export async function waitForPluginLoaded(
  instance: Evaluatable,
  timeoutMs = 60_000,
): Promise<void> {
  await expect
    .poll(
      async () => await instance.eval<boolean>("Boolean(app.plugins.plugins.geode)"),
      { timeout: timeoutMs },
    )
    .toBe(true);
}

// Obsidian auto-opens its Settings (Community plugins) modal on first run, layered on top of the
// Geode setup wizard, intercepting pointer events. Close Settings (safe: it is not our wizard) and
// wait until the "Set up Geode" wizard is the visible modal so its buttons are clickable.
export async function focusSetupWizard(
  instance: Evaluatable,
  timeoutMs = 30_000,
): Promise<void> {
  await expect
    .poll(
      async () =>
        await instance.eval<boolean>(`(() => {
          if (app.setting && typeof app.setting.close === "function") app.setting.close();
          const nodes = Array.from(
            document.querySelectorAll(".modal .modal-title, .modal h2"),
          );
          const headings = nodes.map((h) => h.textContent || "");
          const settingsOpen = document.querySelector(".vertical-tab-header") !== null;
          return headings.some((t) => t.includes("Set up Geode")) && !settingsOpen;
        })()`),
      { timeout: timeoutMs },
    )
    .toBe(true);
}

export async function waitForUnlocked(
  instance: Evaluatable,
  timeoutMs = 60_000,
): Promise<void> {
  await expect
    .poll(
      async () => await instance.eval<boolean>("app.plugins.plugins.geode.isUnlockedCheck()"),
      { timeout: timeoutMs },
    )
    .toBe(true);
}

export async function upsertVaultFile(
  instance: Evaluatable,
  vaultPath: string,
  content: string,
): Promise<void> {
  await instance.eval(`
    const path = ${JSON.stringify(vaultPath)};
    const nextContent = ${JSON.stringify(content)};
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder && !(await app.vault.adapter.exists(folder))) {
      await app.vault.createFolder(folder);
    }
    if (await app.vault.adapter.exists(path)) {
      const existing = app.vault.getAbstractFileByPath(path);
      if (!existing) {
        throw new Error("expected existing file handle for " + path);
      }
      await app.vault.modify(existing, nextContent);
    } else {
      await app.vault.create(path, nextContent);
    }
    return true;
  `);
}

export async function writeVaultFileDirect(
  instance: Evaluatable,
  vaultPath: string,
  content: string,
): Promise<void> {
  await instance.eval(`
    const path = ${JSON.stringify(vaultPath)};
    const nextContent = ${JSON.stringify(content)};
    let current = "";
    for (const part of path.split("/").slice(0, -1)) {
      current = current ? current + "/" + part : part;
      if (!(await app.vault.adapter.exists(current))) {
        await app.vault.adapter.mkdir(current);
      }
    }
    await app.vault.adapter.write(path, nextContent);
    return true;
  `);
}

export async function commitPath(
  instance: Evaluatable,
  vaultPath: string,
  kind: "commit" | "delete" = "commit",
): Promise<void> {
  await instance.eval(`
    await app.plugins.plugins.geode.syncManager.handlePendingOps([
      { path: ${JSON.stringify(vaultPath)}, kind: ${JSON.stringify(kind)} },
    ]);
    return true;
  `);
}

export async function queueCommitPath(
  instance: Evaluatable,
  vaultPath: string,
  kind: "commit" | "delete" = "commit",
): Promise<void> {
  await instance.eval(`
    window.__geodeE2eLastQueuedCommitError = "";
    void app.plugins.plugins.geode.syncManager.handlePendingOps([
      { path: ${JSON.stringify(vaultPath)}, kind: ${JSON.stringify(kind)} },
    ]).catch((error) => {
      window.__geodeE2eLastQueuedCommitError = error instanceof Error ? error.message : String(error);
    });
    return true;
  `);
}

export async function getLocalVersion(
  instance: Evaluatable,
  vaultPath: string,
): Promise<number> {
  return await instance.eval<number>(
    `app.plugins.plugins.geode.syncManager?.state?.getLocalFile(${
      JSON.stringify(vaultPath)
    })?.last_seen_version ?? 0`,
  );
}

export async function disconnectSync(instance: Evaluatable): Promise<void> {
  await instance.eval(`
    const geode = app.plugins.plugins.geode;
    if (!geode.syncManager) {
      throw new Error("expected syncManager before disconnect");
    }
    geode.syncManager.stop();
    return geode.getTransportState();
  `);
}

export async function reconnectSync(instance: Evaluatable): Promise<void> {
  await instance.eval(`
    const geode = app.plugins.plugins.geode;
    if (!geode.syncManager) {
      throw new Error("expected syncManager before reconnect");
    }
    const cursor = geode.syncManager.state?.getSyncCursor?.() ?? geode.getLastSeenSeq();
    geode.transport.start(
      geode.pluginSettings.serverUrl,
      geode.pluginSettings.vaultId,
      geode.pluginSettings.deviceId,
      geode.pluginSettings.deviceToken,
      cursor,
      geode.manifest.version,
    );
    return cursor;
  `);
}

export async function markLocalEdit(instance: Evaluatable, vaultPath: string): Promise<void> {
  await instance.eval(`
    app.plugins.plugins.geode.syncManager.markLocalEdit(${JSON.stringify(vaultPath)});
    return true;
  `);
}

export async function revealFileInExplorer(
  instance: Evaluatable,
  vaultPath: string,
): Promise<void> {
  await instance.eval(`
    const file = app.vault.getFileByPath(${JSON.stringify(vaultPath)});
    if (!file) {
      throw new Error("expected file in vault index: " + ${JSON.stringify(vaultPath)});
    }
    await app.workspace.getLeaf(true).openFile(file);
    await app.commands.executeCommandById("file-explorer:reveal-active-file");
    return true;
  `);
}
