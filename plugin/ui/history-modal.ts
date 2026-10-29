import { App, Modal, Platform, setIcon, Setting } from "obsidian";
import type { VaultKeys } from "../../core/crypto.ts";
import { hashPathHex } from "../../core/hash.ts";
import type { VersionRecord } from "../../core/protocol.ts";
import { type HistorySource, HistoryWalk, saveKey } from "../sync/history-fetch.ts";
import {
  RestoreBusy,
  type RestoreOutcome,
  RestorePaused,
  RestoreUnsynced,
} from "../sync/history-restore.ts";
import { confirmRestoreVersion } from "./confirm-copy.ts";
import { ConfirmModal } from "./confirm-modal.ts";
import {
  buildHistory,
  eventLabel,
  gapLabel,
  type HistoryEvent,
  type HistoryItem,
  type HistoryPeriod,
  periodLabel,
  savesLabel,
  timeLabel,
} from "./history-periods.ts";
import { HistoryPane } from "./history-pane.ts";
import {
  BACK_BUTTON,
  backToList,
  DONE_BUTTON,
  EMPTY_DESC,
  EMPTY_TITLE,
  ERROR_TEXT,
  historySubtitle,
  historyTitle,
  type HistoryView,
  initialView,
  LOADING_TEXT,
  markerLabel,
  NAME_CAPPED_TEXT,
  newestLive,
  OLDER_BUTTON,
  OLDER_ERROR_TEXT,
  periodKey,
  previewCaption,
  RESTORE_BUSY_NOTICE,
  RESTORE_FAILED_NOTICE,
  RESTORE_NOTICE,
  RESTORE_PAUSED_NOTICE,
  RESTORE_UNCHANGED_NOTICE,
  RESTORE_UNSYNCED_NOTICE,
  RETRY_BUTTON,
  selectedRow,
  selectSave,
  showOlder,
  toggleDiff,
  toggleExpanded,
  visibleRows,
} from "./history-view.ts";
import { deviceNameLabel } from "./trash-format.ts";

// #464: one file's history: editing periods on the left (a period expands into
// its save times, Show older pages the server chain), the selected version on
// the right with a Changes diff against the newest live version. Restore is
// #465. Entry points: the Sync activity row, the file menu, the "Show file
// history" command, and a trash row's History: all through modals.ts → main.ts,
// which also closes this on lock (history cannot decrypt without keys).
// #583: the chain is a walk across renames: one generation per name with a
// marker row between them, loaded a name at a time by Show older.

export type HistoryDeps = {
  path: string;
  /** The server's key for `path`; the trash passes its own row's hash. */
  pathHash?: string;
  /** Open at this version and no newer: a trash row's History (#583). */
  ceiling?: number;
  keys: VaultKeys;
  /** The unlocked client: version chain pages plus blob fetch (#463). */
  source: HistorySource & { getBlob(hash: string): Promise<Uint8Array> };
  /** This device, so its own saves are named before the device list lands. */
  localDevice: { id: string; name: string };
  remoteNames: () => Promise<Map<string, string> | null>;
  /** #465: commit the selected version's content as a new head version. */
  restore: (record: VersionRecord) => Promise<RestoreOutcome>;
  /** Notices (a restore's outcome, or why it could not run). */
  notify: (message: string) => void;
  /** Clears the host's single open-history slot on close. */
  onClosed: () => void;
};

function note(container: HTMLElement, text: string): void {
  container.createDiv({ cls: "geode-history-note", text });
}

/** Each refusal has its own line; the log carries the rest. */
function restoreFailure(error: unknown): string {
  if (error instanceof RestorePaused) return RESTORE_PAUSED_NOTICE;
  if (error instanceof RestoreBusy) return RESTORE_BUSY_NOTICE;
  if (error instanceof RestoreUnsynced) return RESTORE_UNSYNCED_NOTICE;
  return RESTORE_FAILED_NOTICE;
}

export class FileHistoryModal extends Modal {
  private walk: HistoryWalk;
  private names: Map<string, string>;
  private loaded = false;
  private loadFailed = false;
  private olderLoading = false;
  private olderFailed = false;
  private view: HistoryView | null = null;
  private listScroll = 0;
  private disposed = false;
  private pathHash: string;
  private pane: HistoryPane;

  constructor(app: App, private deps: HistoryDeps) {
    super(app);
    this.modalEl.addClass("geode-history-modal");
    this.names = new Map([[deps.localDevice.id, deps.localDevice.name]]);
    this.pathHash = deps.pathHash ?? hashPathHex(deps.keys.mac_key, deps.path);
    this.walk = this.newWalk();
    this.pane = new HistoryPane(app, {
      path: deps.path,
      keys: deps.keys,
      getBlob: (hash) => deps.source.getBlob(hash),
      current: () => newestLive(this.walk.rows()),
      onChange: () => this.render(),
      onToggleDiff: () => this.toggleDiff(),
      onRestore: () => this.confirmRestore(),
    });
  }

  onOpen(): void {
    this.setTitle(historyTitle(this.deps.path));
    void this.load();
    void this.loadNames();
  }

  onClose(): void {
    this.disposed = true;
    this.pane.dispose();
    this.contentEl.empty();
    this.deps.onClosed();
  }

  /** The walk from this name; a retry starts it over. */
  private newWalk(): HistoryWalk {
    return new HistoryWalk(this.deps.source, this.deps.keys, this.pathHash, this.deps.ceiling);
  }

  private items(): HistoryItem[] {
    return buildHistory(this.walk.segments, this.names);
  }

  private async load(): Promise<void> {
    this.loadFailed = false;
    this.render();
    this.walk = this.newWalk();
    try {
      await this.walk.next();
      if (this.disposed) return;
      this.loaded = true;
      // A deleted file's head is a tombstone: open on the newest live version.
      const selected = newestLive(this.walk.rows());
      this.view = selected
        ? initialView(this.items(), saveKey(selected.path_hash, selected.version))
        : null;
      if (this.view && this.walk.opensWithHistory()) this.showSelected();
    } catch {
      if (this.disposed) return;
      this.loadFailed = true;
    }
    this.render();
  }

  /** Remote saves read "Another device" until the device list lands. */
  private async loadNames(): Promise<void> {
    const names = await this.deps.remoteNames();
    if (!names || this.disposed) return;
    for (const [id, name] of names) this.names.set(id, name);
    this.render();
  }

  private showSelected(): void {
    const view = this.view;
    if (!view || !this.walk.opensWithHistory()) return;
    this.pane.show(this.walk.record(view.selected), view.selected);
  }

  private older(): void {
    const view = this.view;
    if (!view || this.olderLoading) return;
    if (visibleRows(this.items(), view.shown).morePeriods) {
      this.view = showOlder(view);
      this.render();
      return;
    }
    if (this.walk.done) return;
    void this.loadOlder();
  }

  /** One more page of the walk, keeping the loaded list and preview on failure. */
  private async loadOlder(): Promise<void> {
    this.olderLoading = true;
    this.olderFailed = false;
    this.render();
    try {
      await this.walk.next();
      if (this.disposed) return;
      if (this.view) this.view = showOlder(this.view);
    } catch {
      if (this.disposed) return;
      this.olderFailed = true;
    }
    this.olderLoading = false;
    this.render();
  }

  private render(): void {
    if (this.disposed) return;
    const c = this.contentEl;
    const view = this.view;
    const head = this.walk.segments[0]?.versions[0];
    c.empty();
    if (view && head && this.walk.opensWithHistory()) {
      c.createDiv({
        cls: "geode-history-sub",
        text: historySubtitle(this.deps.path, deviceNameLabel(head.device_id, this.names)),
      });
      if (this.deps.ceiling !== undefined) {
        c.createDiv({ cls: "geode-history-capped", text: NAME_CAPPED_TEXT });
      }
    }
    const body = c.createDiv({ cls: "geode-history-body" });
    if (!this.loaded) {
      if (this.loadFailed) {
        this.renderRetry(body, ERROR_TEXT, "geode-history-retry", () => void this.load());
      } else {
        note(body, LOADING_TEXT);
      }
    } else if (!view || !this.walk.opensWithHistory()) {
      this.renderEmpty(body);
    } else if (Platform.isMobile) {
      this.renderMobile(body, view);
    } else {
      this.renderList(body.createDiv({ cls: "geode-history-list" }), view);
      this.pane.render(body.createDiv({ cls: "geode-history-preview" }), view, this.meta());
    }
    new Setting(c).addButton((b) => {
      b.setCta().setButtonText(DONE_BUTTON);
      b.buttonEl.dataset.testid = "geode-history-done";
      b.onClick(() => this.close());
    });
  }

  private meta(): string | null {
    const view = this.view;
    if (!view) return null;
    const selected = selectedRow(this.items(), view.selected);
    return selected ? previewCaption(selected) : null;
  }

  private renderEmpty(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: "geode-history-empty" });
    box.dataset.testid = "geode-history-empty";
    setIcon(box.createDiv({ cls: "geode-history-empty-icon" }), "history");
    box.createDiv({ cls: "geode-history-empty-title", text: EMPTY_TITLE });
    box.createDiv({ cls: "geode-history-empty-desc", text: EMPTY_DESC });
  }

  /** Phone: the list, then one version with Back: stacked, never side by side. */
  private renderMobile(parent: HTMLElement, view: HistoryView): void {
    if (view.pane === "list") {
      this.renderList(parent.createDiv({ cls: "geode-history-list" }), view);
      return;
    }
    const preview = parent.createDiv({ cls: "geode-history-preview" });
    const back = preview.createDiv({ cls: "geode-history-back" });
    back.dataset.testid = "geode-history-back";
    setIcon(back.createSpan(), "arrow-left");
    back.createSpan({ text: BACK_BUTTON });
    back.onClickEvent(() => {
      this.view = backToList(view);
      this.render();
    });
    this.pane.render(preview, view, this.meta());
  }

  private renderList(listEl: HTMLElement, view: HistoryView): void {
    const { rows, morePeriods } = visibleRows(this.items(), view.shown);
    for (const item of rows) {
      if (item.kind === "period") this.renderPeriod(listEl, view, item);
      else if (item.kind === "marker") this.renderMarker(listEl, item.from);
      else if (item.kind === "event") this.renderEvent(listEl, view, item);
      else listEl.createDiv({ cls: "geode-history-note is-faint", text: gapLabel() });
    }
    this.renderOlder(listEl, morePeriods);
    // Selecting a save re-renders the modal; the list must not jump.
    listEl.scrollTop = this.listScroll;
    listEl.addEventListener("scroll", () => {
      this.listScroll = listEl.scrollTop;
    });
  }

  /** #583: the boundary between two names: the rows under it live at `from`. */
  private renderMarker(listEl: HTMLElement, from: string): void {
    const row = listEl.createDiv({ cls: "geode-history-marker" });
    row.dataset.testid = "geode-history-marker";
    row.createSpan({ cls: "geode-history-marker-label", text: markerLabel(from) });
  }

  /** #691: a deletion or a restore between two periods. Both rows are one line, cut
   * with an ellipsis; a tap shows the rest. Only the restore row holds content, so only
   * it previews: the chevron is the one thing that says which row does (#691). */
  private renderEvent(listEl: HTMLElement, view: HistoryView, event: HistoryEvent): void {
    const restorable = event.event === "restored";
    const active = restorable && event.key === view.selected;
    const expanded = view.expanded.has(event.key);
    const row = listEl.createDiv({
      cls: "geode-history-event" + (active ? " is-active" : "") +
        (expanded ? " is-expanded" : ""),
    });
    row.dataset.testid = "geode-history-event";
    row.setAttr("data-event", event.event);
    row.setAttr("data-version", String(event.version));
    row.createSpan({ cls: "geode-history-event-label", text: eventLabel(event) });
    if (restorable) {
      const chevron = row.createSpan({ cls: "geode-history-chevron" });
      chevron.dataset.testid = "geode-history-event-chevron";
      setIcon(chevron, "chevron-right");
      row.onClickEvent(() => this.select(event.key));
      return;
    }
    // A deletion holds no content to preview: the tap only shows the text it cut off.
    row.onClickEvent(() => {
      this.view = toggleExpanded(view, event.key);
      this.render();
    });
  }

  private renderOlder(listEl: HTMLElement, morePeriods: boolean): void {
    if (this.olderLoading) {
      note(listEl, LOADING_TEXT);
      return;
    }
    if (this.olderFailed) {
      this.renderRetry(listEl, OLDER_ERROR_TEXT, "geode-history-older-retry", () => this.older());
      return;
    }
    if (!morePeriods && this.walk.done) return;
    const older = listEl.createDiv({ cls: "geode-history-older", text: OLDER_BUTTON });
    older.dataset.testid = "geode-history-older";
    older.onClickEvent(() => this.older());
  }

  private renderPeriod(listEl: HTMLElement, view: HistoryView, period: HistoryPeriod): void {
    const key = periodKey(period);
    const active = period.saves.some((save) => save.key === view.selected);
    const row = listEl.createDiv({ cls: "geode-history-period" + (active ? " is-active" : "") });
    const head = row.createDiv({ cls: "geode-history-period-head" });
    head.dataset.testid = "geode-history-period";
    head.setAttr("data-period", key);
    const chevron = head.createSpan({
      cls: "geode-history-chevron" + (view.expanded.has(key) ? " is-open" : ""),
    });
    chevron.dataset.testid = "geode-history-chevron";
    setIcon(chevron, "chevron-right");
    head.createSpan({ cls: "geode-history-period-label", text: periodLabel(period) });
    head.createSpan({ cls: "geode-history-period-count", text: savesLabel(period.saves.length) });
    head.onClickEvent(() => this.select(period.saves[period.saves.length - 1].key));
    chevron.onClickEvent((event) => {
      event.stopPropagation();
      this.view = toggleExpanded(view, key);
      this.render();
    });
    if (!view.expanded.has(key)) return;
    for (const save of period.saves) {
      const el = row.createDiv({
        cls: "geode-history-version" + (save.key === view.selected ? " is-active" : ""),
        text: timeLabel(save.at),
      });
      el.dataset.testid = "geode-history-save";
      el.setAttr("data-version", String(save.version));
      el.onClickEvent(() => this.select(save.key));
    }
  }

  /** A failed load: the error inline where it belongs, with a working retry. */
  private renderRetry(
    container: HTMLElement,
    text: string,
    testid: string,
    retry: () => void,
  ): void {
    const box = container.createDiv({ cls: "geode-history-note" });
    box.createDiv({ text });
    const button = box.createEl("button", { text: RETRY_BUTTON });
    button.dataset.testid = testid;
    button.onClickEvent(retry);
  }

  private select(key: string): void {
    const view = this.view;
    if (!view) return;
    this.view = selectSave(view, key);
    this.showSelected();
    this.render();
  }

  private toggleDiff(): void {
    const view = this.view;
    if (!view) return;
    this.view = toggleDiff(view);
    this.render();
    if (this.view.showDiff) this.pane.ensureBaseline();
  }

  /** #465: a restore confirms first (append only, so the confirm is not a
   * warning), then the content lands as a new head version. */
  private confirmRestore(): void {
    const record = this.view ? this.walk.record(this.view.selected) : null;
    if (!record) return;
    new ConfirmModal(this.app, {
      ...confirmRestoreVersion(),
      warning: false,
      onConfirm: () => this.runRestore(record),
    }).open();
  }

  private async runRestore(record: VersionRecord): Promise<void> {
    try {
      const outcome = await this.deps.restore(record);
      this.deps.notify(outcome === "unchanged" ? RESTORE_UNCHANGED_NOTICE : RESTORE_NOTICE);
      if (outcome !== "restored") return;
      // The file is live again, so a trash row's cap no longer applies: reload the
      // whole window, whose head is now the restored version.
      this.deps.ceiling = undefined;
      await this.load();
    } catch (error) {
      this.deps.notify(restoreFailure(error));
    }
  }
}
