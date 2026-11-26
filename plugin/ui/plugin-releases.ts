import { App, ItemView, Notice, requireApiVersion, WorkspaceLeaf } from "obsidian";
import { RELEASE_NOTES } from "../_generated/release-notes.ts";
import { formatError, log } from "../plumbing/log.ts";
import { fetchAvailableReleaseVersion } from "../plumbing/release-client.ts";
import type { PluginSettings } from "../plumbing/settings-types.ts";
import {
  type BundledReleaseNote,
  GEODE_COMMUNITY_PLUGIN_URL,
  PLUGIN_UPDATE_NOTICE_LINK,
  type PluginVersionRowInput,
  shouldNotifyForRelease,
  whatsNewStartupAction,
} from "./release-check-logic.ts";
import { WHATS_NEW_VIEW_TYPE, WhatsNewView } from "./whats-new-view.ts";

type ReleaseHost = {
  app: App;
  manifest: { version: string };
  pluginSettings: PluginSettings;
  settingTab: { updatePluginVersionRow(): void } | null;
  registerView(type: string, creator: (leaf: WorkspaceLeaf) => ItemView): void;
  saveSettings(): Promise<void>;
};

/** #93: owns the startup GitHub check, update Notice, and once-per-update What's new tab. */
export class PluginReleaseController {
  releaseNotes: readonly BundledReleaseNote[] = RELEASE_NOTES;
  checked = false;
  availableVersion: string | null = null;
  private disposed = false;

  constructor(private host: ReleaseHost) {}

  register(): void {
    this.host.registerView(
      WHATS_NEW_VIEW_TYPE,
      (leaf) => new WhatsNewView(leaf, () => this.host.manifest.version, () => this.releaseNotes),
    );
  }

  onLayoutReady(): void {
    this.host.app.workspace.onLayoutReady(() => {
      if (this.disposed) return;
      void this.checkWhatsNewOnStartup();
      void this.checkForUpdates();
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  rowInput(): PluginVersionRowInput {
    return {
      own: this.host.manifest.version,
      checkEnabled: this.host.pluginSettings.checkForUpdates,
      checked: this.checked,
      available: this.availableVersion,
    };
  }

  openCommunityPlugins(): void {
    window.open(GEODE_COMMUNITY_PLUGIN_URL, "_blank");
  }

  async openWhatsNew(): Promise<void> {
    (this.host.app as unknown as { setting?: { close(): void } }).setting?.close();
    const existing = this.host.app.workspace.getLeavesOfType(WHATS_NEW_VIEW_TYPE)[0];
    const leaf = existing ?? this.host.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: WHATS_NEW_VIEW_TYPE, active: true });
    await this.host.app.workspace.revealLeaf(leaf);
    if (existing && leaf.view instanceof WhatsNewView) await leaf.view.render();
  }

  async checkWhatsNewOnStartup(): Promise<void> {
    const action = whatsNewStartupAction(
      this.host.manifest.version,
      this.host.pluginSettings.lastSeenVersion,
    );
    if (action.kind === "none") return;
    this.host.pluginSettings.lastSeenVersion = action.version;
    await this.host.saveSettings();
    if (action.kind === "open" && !this.disposed) {
      await this.openWhatsNew();
    }
  }

  async checkForUpdates(): Promise<void> {
    if (!this.host.pluginSettings.checkForUpdates) return;
    try {
      const available = await fetchAvailableReleaseVersion({
        currentVersion: this.host.manifest.version,
        canRunMinAppVersion: requireApiVersion,
      });
      if (this.disposed) return;
      this.checked = true;
      this.availableVersion = available;
      this.host.settingTab?.updatePluginVersionRow();
      if (
        shouldNotifyForRelease(
          this.host.manifest.version,
          available,
          this.host.pluginSettings.lastNotifiedReleaseVersion,
        )
      ) {
        this.host.pluginSettings.lastNotifiedReleaseVersion = available;
        await this.host.saveSettings();
        if (!this.disposed) this.showUpdateNotice(available);
      }
    } catch (error) {
      log.debug("plugin release check failed", { error: formatError(error) });
    }
  }

  private showUpdateNotice(version: string): void {
    const fragment = createFragment();
    fragment.appendText(`Geode ${version} is available. `);
    const link = fragment.createEl("a", {
      text: PLUGIN_UPDATE_NOTICE_LINK,
      href: GEODE_COMMUNITY_PLUGIN_URL,
      cls: "geode-notice-link",
    });
    link.dataset.testid = "geode-plugin-update-notice-link";
    link.addEventListener("click", (event) => {
      event.preventDefault();
      this.openCommunityPlugins();
    });
    new Notice(fragment, 15_000);
  }
}
