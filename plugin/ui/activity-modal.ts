import { App, Modal, SearchComponent, setIcon, Setting } from "obsidian";
import {
  ActivityFilter,
  ActivityGroup,
  ActivityRecorder,
  ActivityRow,
  buildRows,
} from "../sync/activity-log.ts";
import { describeSyncStatus, DOT_CLASS, type SyncStatusInput } from "./sync-status.ts";

/** Live sync status for the footer: the same input the settings row describes. */
type ActivityStatusSource = {
  getStatusInput: () => SyncStatusInput;
  /** Status-bar ticks (1 s); returns the unsubscribe. */
  subscribe: (onChange: () => void) => () => void;
};

// #431: the Sync activity modal, ported 1:1 from the #448 mockup (minus the
// mockup-only Empty-activity control). One row per file, latest activity;
// deletes/conflicts/errors are their own rows with absolute clock time;
// All/Conflicts/Errors tabs; live file-name search with a "No matches." state.
// A row opens that file's history (#340 via #464).
export class ActivityModal extends Modal {
  private filter: ActivityFilter = "all";
  private query = "";
  private bodyEl!: HTMLElement;
  private dotEl!: HTMLElement;
  private statusTextEl!: HTMLElement;
  private unsubscribe: (() => void) | null = null;
  private deviceNames: Map<string, string> | null = null;

  constructor(
    app: App,
    private log: ActivityRecorder,
    /** Row click opens that file's history (#464). */
    private onOpenHistory: (path: string) => void,
    /** One-shot deviceId→name fetch; null on failure keeps the neutral labels. */
    private remoteNames: () => Promise<Map<string, string> | null>,
    /** #522: footer status line: same text + dot as the settings row. */
    private status: ActivityStatusSource,
  ) {
    super(app);
    this.modalEl.addClass("geode-activity-modal");
  }

  onOpen(): void {
    this.setTitle("Sync activity");
    const search = new SearchComponent(this.contentEl);
    search.setPlaceholder("Filter by file name…");
    search.inputEl.dataset.testid = "geode-activity-search";
    search.onChange((v) => {
      this.query = v.trim();
      this.render();
    });
    this.bodyEl = this.contentEl.createDiv({ cls: "geode-activity-modal-body" });
    this.renderFooter();
    this.render();
    this.unsubscribe = this.status.subscribe(() => this.updateStatus());
    // Remote rows render as "Another device" until the device list lands, then re-render.
    void this.remoteNames().then((names) => {
      if (names) {
        this.deviceNames = names;
        this.render();
      }
    });
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
  }

  /** Footer row: status line next to Done on desktop, under it on phone (styles.css). */
  private renderFooter(): void {
    const footer = new Setting(this.contentEl);
    footer.settingEl.addClass("geode-activity-footer");
    footer.settingEl.dataset.testid = "geode-activity-footer";
    const line = footer.nameEl.createDiv({ cls: "geode-activity-status" });
    line.dataset.testid = "geode-activity-status";
    this.dotEl = line.createSpan({ cls: "geode-sync-dot geode-sync-dot-hidden" });
    this.statusTextEl = line.createSpan();
    footer.addButton((b) => {
      b.setCta().setButtonText("Done");
      b.buttonEl.dataset.testid = "geode-activity-done";
      b.onClick(() => this.close());
    });
    this.updateStatus();
  }

  /** Re-describe the footer line in place: the list never re-renders on a status tick. */
  private updateStatus(): void {
    const { text, dot } = describeSyncStatus(this.status.getStatusInput(), Date.now());
    this.statusTextEl.setText(text);
    this.statusTextEl.setAttr("title", text);
    for (const cls of Object.values(DOT_CLASS)) this.dotEl.classList.remove(cls);
    this.dotEl.classList.toggle("geode-sync-dot-hidden", !dot);
    if (dot) this.dotEl.addClass(DOT_CLASS[dot]);
  }

  private render(): void {
    const c = this.bodyEl;
    c.empty();
    const tabs = c.createDiv({ cls: "geode-activity-tabs" });
    for (
      const [id, label] of [["all", "All"], ["conflict", "Conflicts"], [
        "error",
        "Errors",
      ]] as Array<
        [ActivityFilter, string]
      >
    ) {
      const tab = tabs.createDiv({
        cls: "geode-activity-tab" + (this.filter === id ? " is-active" : ""),
        text: label,
      });
      tab.dataset.testid = `geode-activity-filter-${id}`;
      tab.onClickEvent(() => {
        this.filter = id;
        this.render();
      });
    }
    const groups = buildRows(this.log.entries.values(), {
      filter: this.filter,
      query: this.query,
      now: Date.now(),
      deviceNames: this.deviceNames ?? undefined,
    });
    const scroll = c.createDiv({ cls: "geode-activity-scroll" });
    if (groups.length === 0) {
      if (this.query) {
        const nomatch = scroll.createDiv({ cls: "geode-no-matches", text: "No matches." });
        nomatch.dataset.testid = "geode-activity-no-matches";
      } else {
        this.renderEmpty(scroll);
      }
    } else {
      for (const group of groups) this.renderGroup(scroll, group);
    }
  }

  private renderGroup(parent: HTMLElement, group: ActivityGroup): void {
    parent.createDiv({ cls: "geode-activity-header", text: group.label });
    const list = parent.createDiv({ cls: "geode-activity-list" });
    for (const row of group.rows) this.renderRow(list, row);
  }

  private renderRow(parent: HTMLElement, row: ActivityRow): void {
    const item = parent.createDiv({ cls: "geode-activity-row" });
    item.dataset.testid = "geode-activity-row";
    item.setAttr("data-path", row.entry.path);
    item.setAttr("data-kind", row.entry.kind);
    item.onClickEvent(() => this.onOpenHistory(row.entry.path));
    const icon = item.createSpan({
      cls: "geode-activity-icon" + (row.mod ? ` ${row.mod}` : ""),
    });
    setIcon(icon, row.icon);
    const body = item.createDiv({ cls: "geode-activity-body" });
    body.createDiv({ cls: "geode-activity-name", text: row.name });
    body.createDiv({ cls: "geode-activity-desc", text: row.detail });
    item.createSpan({
      cls: "geode-activity-time" + (row.mod ? ` ${row.mod}` : ""),
      text: row.time,
    });
  }

  private renderEmpty(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: "geode-activity-empty" });
    box.dataset.testid = "geode-activity-empty";
    setIcon(box.createDiv({ cls: "geode-activity-empty-icon" }), "activity");
    box.createDiv({ cls: "geode-activity-empty-title", text: "No sync activity yet" });
  }
}
