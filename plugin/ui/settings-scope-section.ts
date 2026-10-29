import { App as ObsidianApp, Notice, Setting } from "obsidian";
import type { ConfigCategory, PluginSettings } from "../plumbing/settings-types.ts";
import { configCategoryScopePrefixes } from "../plumbing/settings-types.ts";
import {
  catchUpOrDefer,
  dropPendingCatchUp,
  dropPendingEntries,
} from "../plumbing/scope-pending.ts";
import { ConfigModal } from "./config-modal.ts";
import { configSummary } from "./config-scope.ts";
import { computePluginRows } from "./plugin-sync-list.ts";
import { FoldersModal } from "./folders-modal.ts";
import {
  buildFolderTree,
  type FolderNode,
  folderSummary,
  turnOff,
  turnOn,
} from "./folder-scope.ts";

export type ScopeSectionHost = {
  app: ObsidianApp;
  settings: () => PluginSettings;
  selfPluginId: string;
  /** #454: the vault's config dir (vault.configDir), passed to the category scope. */
  configDir: string;
  saveSettings: () => Promise<void>;
  setSyncObsidianConfig: (value: boolean) => void;
  reconcileNow: () => Promise<void>;
  /** #342: fetch server heads for folders just switched back on. */
  catchUpFolders: (folders: string[]) => Promise<void>;
};

/** Sync scope section: folder scope row + config-folder toggle + the
 * "Config to sync" row with its Manage modal (shown/hidden in place). */
export class SettingsScopeSection {
  private listWrap: HTMLElement | null = null;
  private foldersDesc: HTMLElement | null = null;
  private configDesc: HTMLElement | null = null;

  constructor(private fields: HTMLElement, private host: ScopeSectionHost) {
    this.renderFoldersRow();
    this.renderConfigToggle();
    this.listWrap = this.fields.createEl("div");
    this.renderConfigRow();
  }

  /** The "Sync folders" row: one-line summary + [Manage]. The summary updates in
   * place (no tab re-render) when the Manage modal changes the scope. */
  private renderFoldersRow(): void {
    const row = new Setting(this.fields).setName("Sync folders");
    row.settingEl.dataset.testid = "geode-settings-folders-row";
    this.foldersDesc = row.descEl;
    this.renderFoldersDesc();
    row.addButton((b) => {
      b.setButtonText("Manage");
      b.buttonEl.dataset.testid = "geode-settings-folders-manage";
      b.onClick(() => {
        new FoldersModal(this.host.app, {
          getScope: () => {
            const s = this.host.settings();
            return { excluded: s.excludedFolders, included: s.includedFolders };
          },
          onToggled: (path, on) => void this.handleFolderToggled(path, on),
        }).open();
      });
    });
  }

  private vaultFolders(): FolderNode[] {
    return buildFolderTree(this.host.app.vault.getAllLoadedFiles().map((f) => f.path));
  }

  private renderFoldersDesc(): void {
    if (!this.foldersDesc) return;
    this.foldersDesc.empty();
    const s = this.host.settings();
    const { off, partials } = folderSummary(
      s.excludedFolders,
      s.includedFolders,
      this.vaultFolders(),
    );
    if (off.length === 0 && partials.length === 0) {
      this.foldersDesc.appendText("All folders sync");
      return;
    }
    const names = [...off, ...partials.map((p) => p.path)];
    this.foldersDesc.appendText(`All folders sync except ${names.length}: `);
    names.forEach((f, i) => {
      if (i) this.foldersDesc!.appendText(", ");
      this.foldersDesc!.createEl("code", { text: f });
    });
    for (const p of partials) {
      this.foldersDesc.appendText("; ");
      this.foldersDesc.createEl("code", { text: p.path });
      this.foldersDesc.appendText(" partly (");
      p.on.forEach((o, i) => {
        if (i) this.foldersDesc!.appendText(", ");
        this.foldersDesc!.createEl("code", { text: o });
      });
      this.foldersDesc.appendText(" only)");
    }
  }

  private async handleFolderToggled(path: string, on: boolean): Promise<void> {
    const s = this.host.settings();
    const folder = path + "/";
    const next = on
      ? turnOn(s.excludedFolders, s.includedFolders, path)
      : turnOff(s.excludedFolders, s.includedFolders, path);
    if (on && !s.pendingCatchUpFolders.includes(folder)) {
      // #342: record the re-include as pending BEFORE the folder is in scope,
      // so the reconciler can never see an in-scope file that is missing (deleted
      // while excluded) and turn it into a delete before the server heads apply.
      s.pendingCatchUpFolders.push(folder);
    }
    s.excludedFolders = next.excluded;
    s.includedFolders = next.included;
    await this.host.saveSettings();
    this.renderFoldersDesc();
    if (on) {
      // #342: catch up to the server heads now. On failure the folder stays
      // pending, a notice tells the user, and the next reconnect retries.
      await catchUpOrDefer(
        {
          settings: s,
          saveSettings: () => this.host.saveSettings(),
          catchUpFolders: (folders) => this.host.catchUpFolders(folders),
        },
        [folder],
        (message) => new Notice(message),
      );
    } else {
      // #342: no catch-up for an excluded folder; drop it from the pending list.
      await dropPendingCatchUp(s, folder, () => this.host.saveSettings());
    }
  }

  private renderConfigToggle(): void {
    const syncConfigSetting = new Setting(this.fields).setName("Sync config folder");
    syncConfigSetting.setDesc("");
    syncConfigSetting.descEl.appendText("Include the vault's config folder (default ");
    syncConfigSetting.descEl.createEl("code", { text: ".obsidian/" });
    syncConfigSetting.descEl.appendText(") in sync.");
    syncConfigSetting.addToggle((t) => {
      t.toggleEl.dataset.testid = "geode-settings-toggle-sync-obsidian";
      t.setValue(this.host.settings().syncObsidianConfig).onChange((v) => {
        this.host.settings().syncObsidianConfig = v;
        void this.host.saveSettings();
        this.host.setSyncObsidianConfig(v);
        void this.host.reconcileNow();
        this.renderConfigRow();
      });
    });
  }

  private manifests(): Record<string, { id: string; name: string }> {
    return (this.host.app as unknown as {
      plugins?: { manifests?: Record<string, { id: string; name: string }> };
    })
      .plugins?.manifests ?? {};
  }

  /** The "Config to sync" row: one-line summary + [Manage] → ConfigModal.
   * Hidden while the config-folder toggle is off; appears in place when on. */
  private renderConfigRow(): void {
    if (!this.listWrap) return;
    this.listWrap.empty();
    if (!this.host.settings().syncObsidianConfig) return;
    const row = new Setting(this.listWrap).setName("Config to sync");
    row.settingEl.dataset.testid = "geode-settings-config-row";
    this.configDesc = row.descEl;
    this.renderConfigDesc();
    row.addButton((b) => {
      b.setButtonText("Manage");
      b.buttonEl.dataset.testid = "geode-settings-config-manage";
      b.onClick(() => {
        new ConfigModal(this.host.app, {
          settings: () => this.host.settings(),
          manifests: this.manifests(),
          selfPluginId: this.host.selfPluginId,
          saveSettings: () => this.host.saveSettings(),
          reconcileNow: () => this.host.reconcileNow(),
          catchUpCategory: (c) => this.catchUpCategory(c),
          dropCategory: (c) => this.dropCategory(c),
          onScopeChanged: () => this.renderConfigDesc(),
        }).open();
      });
    });
  }

  private renderConfigDesc(): void {
    if (!this.configDesc) return;
    this.configDesc.empty();
    const s = this.host.settings();
    const rows = computePluginRows(this.manifests(), s.syncedPlugins, this.host.selfPluginId);
    const on = rows.filter((r) => r.checked).length;
    this.configDesc.appendText(configSummary(s.configCategories, on, rows.length));
  }

  /** #454: a category was switched back on: record its path prefixes as pending
   * and catch up to the server heads (the #342 folder mechanism, reused). */
  private catchUpCategory(category: ConfigCategory): Promise<void> {
    const s = this.host.settings();
    return catchUpOrDefer(
      {
        settings: s,
        saveSettings: () => this.host.saveSettings(),
        catchUpFolders: (folders) => this.host.catchUpFolders(folders),
      },
      configCategoryScopePrefixes(category, this.host.configDir),
      (message) => new Notice(message),
    );
  }

  /** #454: a category was switched off: drop its path prefixes from the pending
   * list so a toggle on-then-off before catch-up completes leaves nothing pending. */
  private dropCategory(category: ConfigCategory): Promise<void> {
    const s = this.host.settings();
    return dropPendingEntries(
      s,
      configCategoryScopePrefixes(category, this.host.configDir),
      () => this.host.saveSettings(),
    );
  }
}
