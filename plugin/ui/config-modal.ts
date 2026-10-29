import { App, Modal, Notice, SearchComponent, setIcon, Setting } from "obsidian";
import type { ConfigCategory, PluginSettings } from "../plumbing/settings-types.ts";
import { CONFIG_CATEGORIES, toggleCategory } from "./config-scope.ts";
import { computePluginRows, type PluginRow, togglePlugin } from "./plugin-sync-list.ts";

// #454: Config to sync modal, a 1:1 port of the mockup ConfigModal (#256
// layout v4.1): heading, sticky search, collapsible Settings + Community
// plugins sections (both open by default), a toggle per category / plugin, and
// Done. The modal never re-renders: search and collapse only toggle row
// visibility; toggles update settings in place and refresh the settings row's
// summary via onScopeChanged.

export type ConfigModalHost = {
  settings: () => PluginSettings;
  manifests: Record<string, { id: string; name: string }>;
  selfPluginId: string;
  saveSettings: () => Promise<void>;
  reconcileNow: () => Promise<void>;
  /** #454: a category was switched back on: pending + catch up to the server
   * heads (reuses the #342 folder catch-up). */
  catchUpCategory: (category: ConfigCategory) => Promise<void>;
  /** #454: a category was switched off: drop its pending catch-up prefixes so
   * a toggle on-then-off before catch-up completes leaves nothing pending. */
  dropCategory: (category: ConfigCategory) => Promise<void>;
  /** The settings "Config to sync" row's summary refreshes in place. */
  onScopeChanged: () => void;
};

type SectionRow = {
  kind: "category" | "plugin";
  key: string;
  name: string;
  desc?: string;
  checked: boolean;
};

type Section = {
  fields: HTMLElement;
  chevron: HTMLElement;
  noMatchEl: HTMLElement;
  rows: SectionRow[];
  rowEls: Setting[];
  collapsed: boolean;
};

export class ConfigModal extends Modal {
  private query = "";
  private listEl: HTMLElement | null = null;
  private sections: Record<string, Section> = {};

  constructor(app: App, private host: ConfigModalHost) {
    super(app);
    this.modalEl.addClass("geode-config-modal");
  }

  onOpen(): void {
    const c = this.contentEl;
    new Setting(c).setHeading().setName("Config to sync");
    // The search lives at the top of the scroll list and sticks while the rows
    // scroll; it shares the rows' width (the list's scrollbar gutter).
    this.listEl = c.createDiv({ cls: "geode-config-list" });
    const search = new SearchComponent(this.listEl);
    search.setPlaceholder("Filter settings and plugins…");
    search.inputEl.dataset.testid = "geode-config-search";
    search.onChange((v) => {
      this.query = v.trim().toLowerCase();
      this.applyQuery();
    });

    const s = this.host.settings();
    const categoryRows: SectionRow[] = CONFIG_CATEGORIES.map((c) => ({
      kind: "category",
      key: c.key,
      name: c.name,
      checked: s.configCategories.includes(c.key),
    }));
    this.buildSection("settings", "Settings", categoryRows);

    const pluginRows = computePluginRows(
      this.host.manifests,
      s.syncedPlugins,
      this.host.selfPluginId,
    ).map((p: PluginRow): SectionRow => ({
      kind: "plugin",
      key: p.id,
      name: p.name,
      desc: p.id,
      checked: p.checked,
    }));
    this.buildSection("plugins", "Community plugins", pluginRows);

    new Setting(c).addButton((b) => b.setButtonText("Done").setCta().onClick(() => this.close()));
    this.applyQuery();
  }

  /** A collapsible section: heading (chevron + click toggle) + a fields div
   * holding every row, built once. */
  private buildSection(id: string, title: string, rows: SectionRow[]): void {
    if (!this.listEl) return;
    const heading = new Setting(this.listEl).setHeading().setName(title);
    heading.settingEl.addClass("geode-config-heading");
    heading.settingEl.dataset.testid = `geode-config-${id}-heading`;
    const chevron = heading.nameEl.createSpan({ cls: "geode-section-chevron" });
    setIcon(chevron, "chevron-right");
    const noMatchEl = heading.nameEl.createSpan({
      cls: "geode-config-nomatch",
      text: "No matches",
    });
    const fields = this.listEl.createDiv({ cls: "geode-config-fields" });
    const rowEls = rows.map((row) => this.buildRow(fields, row));
    const section: Section = { fields, chevron, noMatchEl, rows, rowEls, collapsed: false };
    this.sections[id] = section;
    heading.settingEl.addEventListener("click", () => {
      section.collapsed = !section.collapsed;
      this.setSectionOpen(id, !section.collapsed);
    });
    this.setSectionOpen(id, true);
  }

  /** A native Setting row. Category toggles flip settings.configCategories;
   * plugin toggles flip settings.syncedPlugins (existing logic). */
  private buildRow(fields: HTMLElement, row: SectionRow): Setting {
    const st = row.desc
      ? new Setting(fields).setName(row.name).setDesc(row.desc)
      : new Setting(fields).setName(row.name);
    const testid = row.kind === "category"
      ? `geode-config-category-${row.key}`
      : `geode-config-plugin-${row.key}`;
    st.addToggle((t) => {
      t.toggleEl.dataset.testid = testid;
      t.setValue(row.checked).onChange((v) => {
        const s = this.host.settings();
        if (row.kind === "category") {
          s.configCategories = toggleCategory(s.configCategories, row.key as ConfigCategory, v);
          void this.host.saveSettings();
          if (v) void this.host.catchUpCategory(row.key as ConfigCategory);
          else void this.host.dropCategory(row.key as ConfigCategory);
        } else {
          s.syncedPlugins = togglePlugin(s.syncedPlugins, row.key, v);
          void this.host.saveSettings();
          void this.host.reconcileNow();
          new Notice(`Geode: ${v ? "added" : "removed"} ${row.name} to sync`);
        }
        this.host.onScopeChanged();
      });
    });
    return st;
  }

  private setSectionOpen(id: string, open: boolean): void {
    const sec = this.sections[id];
    if (!sec) return;
    sec.fields.classList.toggle("geode-collapsed", !open);
    sec.chevron.classList.toggle("geode-chevron-rotated", open);
  }

  /** While a query is active: sections with matches auto-expand and show only
   * the matching rows; sections without matches collapse and show "No matches".
   * Clearing the query restores the manual state. */
  private applyQuery(): void {
    const q = this.query;
    for (const id of Object.keys(this.sections)) {
      const sec = this.sections[id];
      const matches = q
        ? sec.rows.filter((r) =>
          r.name.toLowerCase().includes(q) ||
          Boolean(r.desc && r.desc.toLowerCase().includes(q))
        )
        : sec.rows;
      const hasMatches = matches.length > 0;
      sec.noMatchEl.style.display = q && !hasMatches ? "" : "none";
      for (let i = 0; i < sec.rowEls.length; i++) {
        sec.rowEls[i].settingEl.style.display = q && !matches.includes(sec.rows[i]) ? "none" : "";
      }
      this.setSectionOpen(id, q ? hasMatches : !sec.collapsed);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
