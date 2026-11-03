import { type ButtonComponent, setIcon, type Setting } from "obsidian";
import type { PluginSettings } from "../plumbing/settings-types.ts";
import { blockedCopy, describeVersionHint, type VersionStatus } from "../sync/version-state.ts";
import { BannerRow } from "./banner-row.ts";
import { filesMissing } from "./mass-delete-review.ts";
import { describePauseBanner } from "./pause.ts";
import type { SettingsRow } from "./settings-legacy.ts";
import type { TreeSection } from "./settings-tree.ts";
import { describeErrorBanner } from "./sync-banner.ts";
import type { SyncStatusInput } from "./sync-status.ts";

export type BannersHost = {
  settings: () => PluginSettings;
  getUnlocked: () => boolean;
  getStatusInput: () => SyncStatusInput;
  getPausedAt: () => number;
  versionStatus: () => VersionStatus;
  openMassDeleteReview: () => void;
  retrySync: (btn: ButtonComponent) => Promise<void>;
  resumeSync: () => Promise<void>;
};

type VersionRow = { setting: Setting; name: HTMLElement; icon: HTMLElement };

/** The banners above the Status rows, in a fixed order: a version refusal (a hard stop), the
 * held mass delete, the sync error, the pause, then an update hint (advisory). One headless
 * section whose array order is that order; each row hides itself, so a hidden one leaves no gap.
 * All update in place. */
export class SettingsBanners {
  private hold: BannerRow;
  private error: BannerRow;
  private pause: BannerRow;
  private versionRows: { blocked: VersionRow | null; hint: VersionRow | null } = {
    blocked: null,
    hint: null,
  };

  constructor(private host: BannersHost) {
    this.hold = new BannerRow({
      name: "Sync on hold",
      testid: "geode-settings-hold-banner",
      icon: "file-warning",
      action: {
        label: "Review",
        testid: "geode-settings-review-missing",
        onClick: () => host.openMassDeleteReview(),
      },
    });
    this.error = new BannerRow({
      name: "Sync error",
      testid: "geode-settings-error-banner",
      icon: "triangle-alert",
      action: {
        label: "Retry",
        testid: "geode-settings-error-retry",
        onClick: (btn) => void host.retrySync(btn),
      },
    });
    this.pause = new BannerRow({
      name: "Sync paused",
      testid: "geode-settings-pause-banner",
      icon: "pause",
      action: {
        label: "Resume",
        testid: "geode-settings-resume",
        onClick: () => void host.resumeSync(),
      },
    });
  }

  sections(): TreeSection<SettingsRow>[] {
    this.update();
    const rows = [
      this.versionRow("blocked"),
      this.hold.row(),
      this.error.row(),
      this.pause.row(),
      this.versionRow("hint"),
    ];
    return [{ id: "banners", heading: "", kind: "lead", rows }];
  }

  /** Re-describe the state banners (status tick); the caller re-evaluates `visible`. */
  update(): void {
    const unlocked = this.host.getUnlocked();
    // #601: the held mass delete is the only state that keeps sync from moving at all.
    const hold = unlocked ? this.host.settings().massDeleteHold : null;
    this.hold.sync(
      hold
        ? {
          name: "Sync on hold",
          nameClasses: ["geode-hold-banner-name"],
          desc: filesMissing(hold.files.length),
        }
        : null,
    );
    const error = describeErrorBanner(
      this.host.getStatusInput(),
      Date.now(),
      this.host.settings().serverUrl,
    );
    this.error.sync(error ? { name: error.name, desc: error.desc } : null);
    // #443: name + age desc + [Resume], ticking with the status.
    const pause = unlocked ? describePauseBanner(this.host.getPausedAt(), Date.now()) : null;
    this.pause.sync(
      pause
        ? {
          name: "Sync paused",
          nameClasses: [`geode-pause-banner-${pause.color}`],
          desc: pause.desc,
        }
        : null,
    );
  }

  /** A version change rewrites the version rows in place. */
  updateVersion(): void {
    this.describeVersion("blocked");
    this.describeVersion("hint");
  }

  /** The version rows have no action and a trailing icon; the kind picks the slot. */
  private versionRow(kind: "blocked" | "hint"): SettingsRow {
    return {
      name: kind === "blocked" ? "Version refused" : "Update available",
      searchable: false,
      visible: () => this.host.versionStatus().kind === kind,
      render: (setting) => {
        // The icon and the name live in their own spans: setName()/setDesc() would replace
        // them on every update (BannerRow keeps its name the same way).
        setting.nameEl.empty();
        const name = setting.nameEl.createSpan();
        const icon = setting.nameEl.createSpan({ cls: "geode-version-warning-icon" });
        this.versionRows[kind] = { setting, name, icon };
        this.describeVersion(kind);
      },
    };
  }

  private describeVersion(kind: "blocked" | "hint"): void {
    const row = this.versionRows[kind];
    const vs = this.host.versionStatus();
    if (!row || vs.kind !== kind) return;
    const copy = vs.kind === "blocked" ? blockedCopy(vs.side) : null;
    row.name.setText(copy ? copy.title : "Update available");
    row.setting.setDesc(
      copy
        ? copy.bannerDesc
        : vs.kind === "hint"
        ? describeVersionHint(vs.own, vs.server) ?? ""
        : "",
    );
    row.icon.toggleClass("mod-error", copy !== null);
    setIcon(row.icon, copy ? "triangle-alert" : "info");
  }
}
