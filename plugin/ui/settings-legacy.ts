import {
  Setting,
  type SettingControl,
  type SettingDefinitionControl,
  type SettingDefinitionRender,
} from "obsidian";
import { type CollapsibleSection, createCollapsibleSection } from "./collapsible-section.ts";
import { numberControlChange, type TreeSection } from "./settings-tree.ts";

/** A render row's body. The definitions contract also hands over a `SettingGroup` that this path
 * does not build, so the row declares the one argument both hosts give it. */
type RowRender = (setting: Setting) => void | (() => void);

/** One settings row: a definition on Obsidian 1.13+, a Setting this file builds before that. */
export type SettingsRow =
  | (Omit<SettingDefinitionRender, "render"> & { render: RowRender })
  | SettingDefinitionControl;

type ControlStore = {
  getControlValue(key: string): unknown;
  setControlValue(key: string, value: unknown): void | Promise<void>;
};

type Visibility = { el: HTMLElement; visible?: boolean | (() => boolean) };

/** #16: Obsidian < 1.13 renders the settings tree here, sections collapsible (#134). The
 * subset of the definitions API Geode uses: render rows, number and toggle controls,
 * `visible`, and the cleanup a render row returns. */
export class LegacySettingsView {
  private visibility: Visibility[] = [];
  private cleanups: (() => void)[] = [];

  constructor(private store: ControlStore, private collapsed: Set<string>) {}

  render(container: HTMLElement, sections: TreeSection<SettingsRow>[]): void {
    this.dispose();
    for (const s of sections) {
      const section = s.heading ? this.headed(container, s.id, s.heading) : null;
      const fieldsEl = section?.fieldsEl ?? container.createDiv();
      this.visibility.push({ el: section?.sectionEl ?? fieldsEl, visible: s.visible });
      for (const row of s.rows) this.renderRow(fieldsEl, row);
    }
    this.refreshVisibility();
  }

  /** The display() counterpart of `refreshDomState()`: re-evaluate every `visible`. */
  refreshVisibility(): void {
    for (const { el, visible } of this.visibility) {
      const shown = typeof visible === "function" ? visible() : visible ?? true;
      el.toggleClass("geode-hidden", !shown);
    }
  }

  dispose(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.visibility = [];
  }

  private headed(container: HTMLElement, id: string, heading: string): CollapsibleSection {
    return createCollapsibleSection(container, heading, {
      open: !this.collapsed.has(id),
      onToggle: (open) => {
        if (open) this.collapsed.delete(id);
        else this.collapsed.add(id);
      },
    });
  }

  private renderRow(fields: HTMLElement, row: SettingsRow): void {
    const setting = new Setting(fields).setName(row.name);
    if (row.desc) setting.setDesc(row.desc);
    this.visibility.push({ el: setting.settingEl, visible: row.visible });
    if (row.render) {
      const cleanup = row.render(setting);
      if (cleanup) this.cleanups.push(cleanup);
    } else if (row.control) {
      this.renderControl(setting, row.control);
    }
  }

  private renderControl(setting: Setting, control: SettingControl): void {
    const value = this.store.getControlValue(control.key);
    const commit = async (next: unknown): Promise<void> => {
      await this.store.setControlValue(control.key, next);
      this.refreshVisibility();
    };
    if (control.type === "toggle") {
      setting.addToggle((t) => t.setValue(value === true).onChange((v) => void commit(v)));
    } else if (control.type === "number") {
      setting.addText((t) => {
        t.inputEl.type = "number";
        if (control.min !== undefined) t.inputEl.min = String(control.min);
        t.setValue(String(value));
        const errorEl = setting.descEl.createDiv({ cls: "geode-error" });
        errorEl.toggleClass("geode-hidden", true);
        t.inputEl.addEventListener("change", () => {
          const stored = this.store.getControlValue(control.key) as number;
          void numberControlChange(control.validate, t.inputEl.value, stored).then((change) => {
            // A rejected value leaves the row honest: the stored value is back and the reason
            // shows (Obsidian renders the same message on 1.13+).
            t.inputEl.value = String(change.value);
            errorEl.setText(change.error ?? "");
            errorEl.toggleClass("geode-hidden", change.error === undefined);
            if (change.error === undefined) void commit(change.value);
          });
        });
      });
    }
  }
}
