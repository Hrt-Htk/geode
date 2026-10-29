import { App, ButtonComponent, Modal, Notice, SearchComponent, Setting } from "obsidian";
import { formatUserError, isAdminAuthFailure } from "../plumbing/errors.ts";
import type { TrashApi, TrashChainEntry, TrashEntry } from "../plumbing/trash-client.ts";
import { ConfirmModal } from "./confirm-modal.ts";
import {
  confirmPurgeExpired,
  confirmPurgeFile,
  confirmPurgeSelected,
  countExpiredTrash,
} from "./confirm-copy.ts";
import {
  deletedFromLabel,
  deviceNameLabel,
  IN_FLOOR_PURGE_ASK,
  IN_FLOOR_PURGE_CANCELLED,
  IN_FLOOR_PURGE_TITLE,
  keptLabel,
  PURGE_HISTORY_FAILED,
  purgedExpiredNotice,
  purgedOneNotice,
  purgedSelectedNotice,
  purgeNeedsAdmin,
  restoredNotice,
  restoredOneNotice,
  retentionLabel,
  trashEntryLabel,
} from "./trash-format.ts";
import {
  allVisibleSelected,
  pruneSelected,
  selectedPurgeLabel,
  selectionCountLabel,
  toggleAllSelected,
  visibleEntries,
} from "./trash-select.ts";
import { PreviewModal } from "./trash-preview.ts";
import { type AdminTokenHost, withAdminToken } from "./admin-token-modal.ts";

// #446: trash as a modal (owner's choice over the side panel), ported 1:1
// from the mockup (minus the Mockup-only Trash-state control). Opened from
// Settings → Trash → Deleted files [View] and the status-bar menu. One shared
// state drives the modal and the settings-row live count; bulk select is keyed
// by path so it survives search filtering.

export type TrashModalDeps = {
  trash: TrashApi;
  retentionDays: () => number;
  deviceNames: () => Promise<Map<string, string> | null>;
  /** #583: the row's own name's history, capped at the version it was deleted at. */
  openHistory: (entry: TrashEntry) => void;
  /** #582: the names this file lived at, each with its ceiling: delete forever erases
   * them all. An empty list erases only the trashed name's own generation. */
  eraseChainFor: (entry: TrashEntry) => Promise<TrashChainEntry[]>;
  /** #677: the admin token gate: a purge inside the server's retention floor needs it. */
  adminHost: AdminTokenHost;
  /** Refresh the settings Deleted-files live count after any change. */
  onChanged: () => void;
};

type Status = "loading" | "loaded" | "error";

export class TrashModal extends Modal {
  private query = "";
  private selected = new Set<string>();
  private status: Status = "loading";
  private entries: TrashEntry[] = [];
  private bodyEl!: HTMLElement;
  private deviceNames: Map<string, string> | null = null;
  private disposed = false;

  constructor(app: App, private deps: TrashModalDeps) {
    super(app);
    this.modalEl.addClass("geode-trash-modal");
  }

  onOpen(): void {
    this.setTitle("Deleted files");
    const search = new SearchComponent(this.contentEl);
    search.setPlaceholder("Filter trash by path…");
    search.inputEl.dataset.testid = "geode-trash-search";
    search.onChange((v) => {
      this.query = v.trim().toLowerCase();
      this.render();
    });
    this.bodyEl = this.contentEl.createDiv({ cls: "geode-trash-body" });
    this.render();
    void this.deps.deviceNames().then((names) => {
      this.deviceNames = names;
      if (!this.disposed) this.render();
    });
    void this.load();
  }

  onClose(): void {
    this.disposed = true;
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    this.status = "loading";
    this.render();
    try {
      this.entries = await this.deps.trash.list();
      this.status = "loaded";
    } catch {
      this.status = "error";
    }
    if (this.disposed) return;
    this.render();
    this.deps.onChanged();
  }

  private retry(): void {
    void this.load();
  }

  private render(): void {
    const c = this.bodyEl;
    c.empty();
    this.selected = pruneSelected(this.selected, this.entries);
    const shown = visibleEntries(this.entries, this.query);
    const canAct = this.status === "loaded" && this.entries.length > 0;
    this.renderToolbar(c, shown, canAct);
    this.renderList(c, shown);
  }

  private renderToolbar(c: HTMLElement, shown: TrashEntry[], canAct: boolean): void {
    const toolbar = c.createDiv({ cls: "geode-trash-toolbar" });
    const selCb = toolbar.createEl("input", {
      type: "checkbox",
      attr: { "data-testid": "geode-trash-select-all" },
    });
    selCb.disabled = !canAct;
    selCb.checked = allVisibleSelected(this.selected, shown);
    selCb.addEventListener("change", () => {
      this.selected = toggleAllSelected(this.selected, shown, selCb.checked);
      this.render();
    });
    toolbar.createEl("label", { cls: "geode-trash-toolbar-select", text: "Select all" })
      .prepend(selCb);
    toolbar.createEl("span", {
      cls: "geode-trash-retention",
      text: keptLabel(this.deps.retentionDays()),
    });
    // #638: the count is the toolbar's own trailing item, not part of the actions
    // group, so the phone layout can keep it on the first line while the actions
    // share the second. Empty (and so invisible) with nothing selected.
    toolbar.createSpan({
      cls: "geode-trash-toolbar-count",
      text: this.selected.size > 0 ? selectionCountLabel(this.selected.size) : "",
      attr: { "data-testid": "geode-trash-count" },
    });

    const actions = toolbar.createDiv({ cls: "geode-trash-toolbar-actions" });
    if (this.selected.size > 0) {
      this.addAction(
        actions,
        "Restore selected",
        true,
        canAct,
        () => void this.restoreSelected(),
        "geode-trash-restore-selected",
      );
      this.addAction(
        actions,
        selectedPurgeLabel(this.selected.size),
        false,
        canAct,
        () => this.confirmPurgeSelected(),
        "geode-trash-purge-selected",
      );
    } else {
      this.addAction(
        actions,
        "Restore all",
        true,
        canAct,
        () => void this.restoreAll(),
        "geode-trash-restore-all",
      );
      this.addAction(
        actions,
        "Purge expired",
        false,
        canAct,
        () => this.confirmPurgeExpired(),
        "geode-trash-purge-expired",
      );
    }
  }

  private addAction(
    parent: HTMLElement,
    label: string,
    cta: boolean,
    enabled: boolean,
    onClick: () => void,
    testid?: string,
  ): void {
    const btn = new ButtonComponent(parent).setButtonText(label);
    if (cta) btn.setCta();
    else btn.setWarning();
    if (!enabled) btn.setDisabled(true);
    if (testid) btn.buttonEl.dataset.testid = testid;
    btn.onClick(onClick);
  }

  private renderList(c: HTMLElement, shown: TrashEntry[]): void {
    const list = c.createDiv({ cls: "geode-trash-list" });
    if (this.status === "loading") {
      const el = list.createEl("p", { cls: "geode-trash-loading", text: "Loading deleted files…" });
      el.dataset.testid = "geode-trash-loading";
    } else if (this.status === "error") {
      const err = list.createDiv({
        cls: "geode-trash-error",
        text: "Couldn't load the trash. The server didn't answer.",
      });
      err.dataset.testid = "geode-trash-error";
      new Setting(list).addButton((b) => {
        b.setCta().setButtonText("Retry");
        b.buttonEl.dataset.testid = "geode-trash-retry";
        b.onClick(() => this.retry());
      });
    } else if (this.entries.length === 0) {
      const el = list.createEl("p", { cls: "geode-trash-empty", text: "Trash is empty." });
      el.dataset.testid = "geode-trash-empty";
    } else if (shown.length === 0) {
      const el = list.createDiv({ cls: "geode-no-matches", text: "No matches." });
      el.dataset.testid = "geode-trash-no-matches";
    } else {
      for (const entry of shown) this.renderRow(list, entry);
    }
  }

  private renderRow(list: HTMLElement, entry: TrashEntry): void {
    const label = trashEntryLabel(entry);
    const frag = document.createDocumentFragment();
    frag.createDiv({
      text: deletedFromLabel(
        entry.trashed_at,
        deviceNameLabel(entry.deleted_by_device, this.deviceNames),
      ),
    });
    const r = retentionLabel(entry.trashed_at, this.deps.retentionDays());
    frag.createDiv({
      text: r,
      cls: r === "expired" ? "geode-trash-expired" : "geode-trash-purges",
    });
    const s = new Setting(list).setName(label).setDesc(frag);
    const key = entry.path ?? entry.path_hash;
    const cb = s.nameEl.createEl("input", {
      type: "checkbox",
      attr: { "data-testid": `geode-trash-check-${key}` },
    });
    cb.checked = this.selected.has(key);
    cb.addEventListener("change", () => {
      if (cb.checked) this.selected.add(key);
      else this.selected.delete(key);
      this.render();
    });
    s.nameEl.insertBefore(cb, s.nameEl.firstChild);
    // #583: the whole history of this name, so a rename no longer hides it. A name
    // the server could not decrypt has no title or preview to open.
    if (entry.path) {
      s.addButton((b) => {
        b.setButtonText("History");
        b.buttonEl.dataset.testid = "geode-trash-history";
        b.buttonEl.dataset.pathHash = entry.path_hash;
        b.onClick(() => this.deps.openHistory(entry));
      });
    }
    s.addButton((b) => {
      b.setButtonText("View");
      b.buttonEl.dataset.testid = "geode-trash-view";
      b.buttonEl.dataset.pathHash = entry.path_hash;
      b.onClick(() =>
        new PreviewModal(this.app, {
          trash: this.deps.trash,
          entry,
          deviceName: deviceNameLabel(entry.deleted_by_device, this.deviceNames),
          onRestored: () => {
            this.selected.delete(key);
            void this.load();
          },
        }).open()
      );
    });
    s.addButton((b) => {
      b.setButtonText("Restore");
      b.buttonEl.dataset.testid = "geode-trash-restore";
      b.buttonEl.dataset.pathHash = entry.path_hash;
      b.onClick(() => {
        void this.deps.trash.restore(entry.path_hash).then(() => {
          this.selected.delete(key);
          new Notice(restoredOneNotice(label));
          void this.load();
        }).catch((err: unknown) => new Notice(`Failed to restore. ${formatUserError(err)}`, 10000));
      });
    });
    s.addButton((b) => {
      b.setWarning().setButtonText("Purge");
      b.buttonEl.dataset.testid = "geode-trash-purge";
      b.buttonEl.dataset.pathHash = entry.path_hash;
      b.onClick(() => this.openPurgeFile(entry));
    });
  }

  /** #582: Delete forever: the History walk names every earlier name too, so the
   * server can erase the whole chain. A walk that fails aborts: the confirm promised
   * the past versions, so purging this name alone would be a lie. #677: a row inside
   * the server's retention floor needs the admin token first. */
  private openPurgeFile(entry: TrashEntry): void {
    const label = trashEntryLabel(entry);
    new ConfirmModal(this.app, {
      ...confirmPurgeFile(label),
      onConfirm: async () => {
        let chain: TrashChainEntry[];
        try {
          chain = await this.deps.eraseChainFor(entry);
        } catch {
          new Notice(PURGE_HISTORY_FAILED, 10000);
          return;
        }
        this.purgeWithAdmin([entry], async (adminToken) => {
          try {
            await this.deps.trash.purge(entry.path_hash, chain, adminToken);
            this.selected.delete(entry.path ?? entry.path_hash);
            new Notice(purgedOneNotice(label));
            void this.load();
          } catch (err) {
            // #677: a rotated admin token answers 401: drop it so the next attempt asks again.
            if (isAdminAuthFailure(err)) this.deps.adminHost.setAdminToken(null);
            new Notice(`Failed to purge. ${formatUserError(err)}`, 10000);
          }
        });
      },
    }).open();
  }

  /** #677: run `purge` with the admin token when a target row is inside the server's
   * retention floor (a device token is refused there), else with the device token. A
   * prompt dismissed without a token purges nothing and says so. */
  private purgeWithAdmin(
    target: TrashEntry[],
    purge: (adminToken?: string) => Promise<void>,
  ): void {
    if (!purgeNeedsAdmin(target, this.deps.trash.serverFloor())) {
      void purge();
      return;
    }
    withAdminToken(this.deps.adminHost, {
      title: IN_FLOOR_PURGE_TITLE,
      message: IN_FLOOR_PURGE_ASK,
      onCancel: () => new Notice(IN_FLOOR_PURGE_CANCELLED, 10000),
    }, (adminToken) => {
      void purge(adminToken);
    });
  }

  private async restoreAll(): Promise<void> {
    try {
      const { restored } = await this.deps.trash.restoreAll();
      new Notice(restoredNotice(restored));
      void this.load();
    } catch (err) {
      new Notice(`Failed to restore all. ${formatUserError(err)}`, 10000);
    }
  }

  private confirmPurgeExpired(): void {
    const count = countExpiredTrash(this.entries, this.deps.retentionDays());
    new ConfirmModal(this.app, {
      ...confirmPurgeExpired(count),
      onConfirm: () =>
        this.deps.trash.purgeExpired().then(({ purged }) => {
          new Notice(purgedExpiredNotice(purged));
          void this.load();
        }).catch((err: unknown) => {
          new Notice(`Failed to purge. ${formatUserError(err)}`, 10000);
        }),
    }).open();
  }

  private async restoreSelected(): Promise<void> {
    const target = this.selectedPaths();
    try {
      await Promise.all(target.map((h) => this.deps.trash.restore(h)));
      new Notice(restoredNotice(target.length));
      this.selected.clear();
      void this.load();
    } catch (err) {
      new Notice(`Failed to restore. ${formatUserError(err)}`, 10000);
    }
  }

  private confirmPurgeSelected(): void {
    const target = this.entries.filter((e) => this.selected.has(e.path ?? e.path_hash));
    new ConfirmModal(this.app, {
      ...confirmPurgeSelected(target.length),
      onConfirm: async () => {
        let chains: TrashChainEntry[][];
        try {
          // Every chain before any erase: one unreadable history must not leave the
          // rest half-purged.
          chains = await Promise.all(target.map((entry) => this.deps.eraseChainFor(entry)));
        } catch {
          new Notice(PURGE_HISTORY_FAILED, 10000);
          return;
        }
        this.purgeWithAdmin(target, async (adminToken) => {
          try {
            for (let i = 0; i < target.length; i++) {
              await this.deps.trash.purge(target[i].path_hash, chains[i], adminToken);
            }
            new Notice(purgedSelectedNotice(target.length));
            this.selected.clear();
            void this.load();
          } catch (err) {
            if (isAdminAuthFailure(err)) this.deps.adminHost.setAdminToken(null);
            new Notice(`Failed to purge. ${formatUserError(err)}`, 10000);
          }
        });
      },
    }).open();
  }

  private selectedPaths(): string[] {
    return this.entries
      .filter((e) => this.selected.has(e.path ?? e.path_hash))
      .map((e) => e.path_hash);
  }
}
