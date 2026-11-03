import { ButtonComponent, setIcon, Setting } from "obsidian";
import type { SettingsRow } from "./settings-legacy.ts";

/** #601: one settings banner row (error, pause, hold): shown while it has a state, updated
 * in place, hidden when its state ends. Its place in the tab is fixed (#16). */
export type BannerState = {
  name: string;
  /** State classes for the name span (colour); the base class is always applied. */
  nameClasses?: string[];
  desc: string;
};

export class BannerRow {
  private setting: Setting | null = null;
  private nameEl: HTMLSpanElement | null = null;
  private appliedNameClasses: string[] = [];
  private state: BannerState | null = null;

  constructor(
    private opts: {
      /** The row's fixed name: its key among the definitions, never shown. */
      name: string;
      testid: string;
      icon: string;
      action: {
        label: string;
        testid: string;
        onClick: (btn: ButtonComponent) => void;
      };
    },
  ) {}

  row(): SettingsRow {
    return {
      name: this.opts.name,
      searchable: false,
      visible: () => this.state !== null,
      render: (setting) => this.render(setting),
    };
  }

  sync(state: BannerState | null): void {
    this.state = state;
    this.apply();
  }

  private render(setting: Setting): void {
    setting.settingEl.dataset.testid = this.opts.testid;
    setting.nameEl.empty();
    const icon = setting.nameEl.createSpan({ cls: "geode-banner-icon" });
    setIcon(icon, this.opts.icon);
    this.nameEl = setting.nameEl.createSpan({ cls: "geode-banner-name" });
    this.appliedNameClasses = [];
    setting.addButton((btn) => {
      btn.setCta().setButtonText(this.opts.action.label);
      btn.buttonEl.dataset.testid = this.opts.action.testid;
      btn.onClick(() => this.opts.action.onClick(btn));
    });
    this.setting = setting;
    this.apply();
  }

  private apply(): void {
    const { setting, nameEl, state } = this;
    if (!setting || !nameEl || !state) return;
    if (nameEl.textContent !== state.name) nameEl.textContent = state.name;
    for (const cls of this.appliedNameClasses) nameEl.classList.remove(cls);
    this.appliedNameClasses = state.nameClasses ?? [];
    for (const cls of this.appliedNameClasses) nameEl.addClass(cls);
    if (setting.descEl.textContent !== state.desc) setting.setDesc(state.desc);
  }
}
