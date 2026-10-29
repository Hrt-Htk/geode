import { Notice, Setting } from "obsidian";
import { type LogEntry, subscribeLog } from "../plumbing/log.ts";
import {
  connectionLabel,
  filterLogEntries,
  formatLogLine,
  LOG_FILTERS,
  LOG_LINE_LIMIT,
  logDetailsText,
  type LogFilter,
} from "./log-format.ts";

/** The plugin surface the Logs section reads live. */
export type LogsSectionHost = {
  getTransportState: () => string;
  getLastSeenSeq: () => number;
  getPendingCount: () => number;
  getRecentLog: () => LogEntry[];
  exportLog: () => string;
};

/** #453/#434: Logs section fields: details line, filter tabs, ring-buffer log box, Copy logs. */
export class SettingsLogsSection {
  private filter: LogFilter = "all";
  private detailsEl!: HTMLElement;
  private boxEl!: HTMLElement;
  private tabs: HTMLElement[] = [];
  private unsubscribe: () => void;

  constructor(private fields: HTMLElement, private host: LogsSectionHost) {
    this.render();
    this.unsubscribe = subscribeLog((entry) => this.appendLine(entry));
  }

  private render(): void {
    this.fields.empty();
    this.detailsEl = this.fields.createDiv({ cls: "geode-log-details" });
    this.detailsEl.dataset.testid = "geode-log-details";
    this.refreshDetails();

    const tabsEl = this.fields.createDiv({ cls: "geode-activity-tabs geode-log-tabs" });
    for (const f of LOG_FILTERS) {
      const tab = tabsEl.createDiv({
        cls: "geode-activity-tab" + (this.filter === f.id ? " is-active" : ""),
        text: f.label,
      });
      tab.dataset.testid = `geode-log-filter-${f.id}`;
      tab.onClickEvent(() => {
        this.filter = f.id;
        for (const t of this.tabs) t.toggleClass("is-active", t === tab);
        this.renderBox();
      });
      this.tabs.push(tab);
    }

    this.boxEl = this.fields.createDiv({ cls: "geode-log-box" });
    this.boxEl.dataset.testid = "geode-log-box";
    this.renderBox();

    new Setting(this.fields)
      .setName("Copy logs")
      .setDesc("Copy the recent Geode log to share in a bug report.")
      .addButton((btn) => {
        btn.setButtonText("Copy logs").setTooltip("Copy log to clipboard");
        btn.buttonEl.dataset.testid = "geode-log-copy";
        btn.onClick(async () => {
          try {
            await navigator.clipboard.writeText(this.host.exportLog());
            new Notice("Logs copied");
          } catch {
            new Notice("Failed to copy logs");
          }
        });
      });
  }

  /** In-place details-line update; called on the settings tab's status tick. */
  refreshDetails(): void {
    const text = logDetailsText({
      state: connectionLabel(this.host.getTransportState()),
      seq: this.host.getLastSeenSeq(),
      pending: this.host.getPendingCount(),
    });
    if (this.detailsEl.textContent === text) return;
    this.detailsEl.setText(text);
  }

  /** Full box render from the ring snapshot (initial + filter change). */
  private renderBox(): void {
    const entries = filterLogEntries(this.host.getRecentLog(), this.filter).slice(-LOG_LINE_LIMIT);
    this.boxEl.empty();
    for (const entry of entries) this.appendEntry(entry);
    this.boxEl.scrollTop = this.boxEl.scrollHeight;
  }

  /** Append one line (live subscription); drop the oldest past the limit. */
  private appendLine(entry: LogEntry): void {
    if (this.filter !== "all" && entry.level !== this.filter) return;
    this.appendEntry(entry);
    while (this.boxEl.children.length > LOG_LINE_LIMIT) this.boxEl.firstElementChild?.remove();
  }

  private appendEntry(entry: LogEntry): void {
    const line = this.boxEl.createEl("div", { cls: `geode-log-line geode-log-${entry.level}` });
    line.setText(formatLogLine(entry));
  }

  destroy(): void {
    this.unsubscribe();
  }
}
