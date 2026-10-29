import { ButtonComponent, setIcon, Setting } from "obsidian";

/** #601: one settings banner row (error, pause, hold): created on first use, updated in
 * place, removed when its state ends. Its fixed `order` keeps the slot when a row appears
 * after another one already exists. */
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

  constructor(
    private container: HTMLElement,
    private opts: {
      order: number;
      testid: string;
      icon: string;
      action: {
        label: string;
        testid: string;
        onClick: (btn: ButtonComponent) => void;
      };
    },
  ) {}

  sync(state: BannerState | null): void {
    if (!state) {
      this.setting?.settingEl.remove();
      this.setting = null;
      this.nameEl = null;
      this.appliedNameClasses = [];
      return;
    }
    if (!this.setting) this.create();
    const setting = this.setting!;
    const nameEl = this.nameEl!;
    if (nameEl.textContent !== state.name) nameEl.textContent = state.name;
    for (const cls of this.appliedNameClasses) nameEl.classList.remove(cls);
    this.appliedNameClasses = state.nameClasses ?? [];
    for (const cls of this.appliedNameClasses) nameEl.addClass(cls);
    if (setting.descEl.textContent !== state.desc) setting.setDesc(state.desc);
  }

  private create(): void {
    const setting = new Setting(this.container);
    setting.settingEl.dataset.testid = this.opts.testid;
    setting.settingEl.dataset.bannerOrder = String(this.opts.order);
    const icon = setting.nameEl.createSpan({ cls: "geode-banner-icon" });
    setIcon(icon, this.opts.icon);
    this.nameEl = setting.nameEl.createSpan({ cls: "geode-banner-name" });
    setting.addButton((btn) => {
      btn.setCta().setButtonText(this.opts.action.label);
      btn.buttonEl.dataset.testid = this.opts.action.testid;
      btn.onClick(() => this.opts.action.onClick(btn));
    });
    this.setting = setting;
    this.place(setting.settingEl);
  }

  /** Insert before the first row with a higher order (the version banner is order 3). */
  private place(el: HTMLElement): void {
    const next = [...this.container.children].find(
      (child) => Number((child as HTMLElement).dataset.bannerOrder ?? Infinity) > this.opts.order,
    );
    this.container.insertBefore(el, next ?? null);
  }
}
