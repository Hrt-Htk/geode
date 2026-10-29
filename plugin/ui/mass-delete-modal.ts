/** #601: the review window: one Delete switch per missing file, reachable from the
 * detection notice, the status icon menu and the settings rows. Closing it keeps the hold;
 * only the main button decides, and only deleting asks once more. */

import { App, ButtonComponent, Modal, Notice, Platform, setIcon, ToggleComponent } from "obsidian";
import type { MassDeleteHold } from "../sync/mass-delete-hold.ts";
import { formatUserError } from "../plumbing/errors.ts";
import {
  confirmMessage,
  confirmTitle,
  copyText,
  filesMissing,
  folderLabel,
  type FolderNode,
  folderState,
  formatCount,
  formatDay,
  HOLD_NOTE,
  holdNoticeText,
  mainAction,
  missingTree,
  recentFirst,
  rootFiles,
  rootState,
  selectAllFiles,
  selectRootFiles,
  selectSubtree,
  toggleFile,
  trashNote,
} from "./mass-delete-review.ts";
import { ConfirmModal } from "./confirm-modal.ts";

export type MassDeleteModalHost = {
  resolve: (deletePaths: string[]) => Promise<void>;
  notify: (message: string) => void;
  /** The effective retention the Trash window shows (#532): settings vs the server floor. */
  retentionDays: () => number;
};

export class MassDeleteModal extends Modal {
  private view: "folders" | "recent" = "folders";
  private selected = new Set<string>();
  // In-memory: the tree starts expanded, and the decision is per file only.
  private collapsed = new Set<string>();
  private totalEl!: HTMLElement;
  private subEl!: HTMLElement;
  private foldersTab!: HTMLElement;
  private recentTab!: HTMLElement;
  private selectAll!: ToggleComponent;
  private bodyEl!: HTMLElement;
  private mainBtn!: ButtonComponent;
  private errorEl!: HTMLElement;
  /** The effective retention, read once: footer and confirmation must agree. */
  private retention = 0;
  private busy = false;
  private confirming = false;
  /** Obsidian's ToggleComponent.setValue fires onChange, so a render must not answer the
   * select-all switch it just set (an all → partial set would clear the whole selection).
   * The row switches are set before their handlers exist, so they need no such guard. */
  private rendering = false;

  constructor(app: App, private hold: MassDeleteHold, private host: MassDeleteModalHost) {
    super(app);
    this.modalEl.addClass("geode-missing-modal");
  }

  onOpen(): void {
    this.retention = this.host.retentionDays();
    this.setTitle("Review missing files");
    const c = this.contentEl;
    const head = c.createDiv({ cls: "geode-missing-head" });
    this.totalEl = head.createDiv({ cls: "geode-missing-total" });
    this.subEl = head.createDiv({ cls: "geode-missing-sub" });
    const tabs = c.createDiv({ cls: "horizontal-tab-header geode-missing-tabs" });
    this.foldersTab = tabs.createDiv({ cls: "horizontal-tab-nav-item", text: "Folders" });
    this.foldersTab.dataset.testid = "geode-missing-tab-folders";
    this.recentTab = tabs.createDiv({ cls: "horizontal-tab-nav-item", text: "Recent" });
    this.recentTab.dataset.testid = "geode-missing-tab-recent";
    this.foldersTab.onClickEvent(() => this.setView("folders"));
    this.recentTab.onClickEvent(() => this.setView("recent"));
    // The column header doubles as select-all for the whole set, above both views
    // (the tree keeps the explorer look, so it has no header of its own).
    const column = tabs.createDiv({ cls: "geode-missing-selectall" });
    column.createSpan({ cls: "geode-missing-col-label", text: "Delete" });
    this.selectAll = new ToggleComponent(column);
    this.selectAll.toggleEl.dataset.testid = "geode-missing-select-all";
    this.selectAll.onChange((on) => {
      if (this.rendering) return;
      this.selected = new Set(selectAllFiles(this.hold.files, on));
      this.render();
    });
    this.bodyEl = c.createDiv({ cls: "geode-missing-body" });
    const foot = c.createDiv({ cls: "geode-missing-foot" });
    foot.createSpan({
      cls: "geode-missing-foot-note",
      text: trashNote(this.retention),
    });
    this.errorEl = foot.createDiv({ cls: "geode-missing-error geode-hidden" });
    this.errorEl.dataset.testid = "geode-missing-error";
    const actions = foot.createDiv({ cls: "geode-missing-foot-actions" });
    new ButtonComponent(actions).setButtonText("Copy list").onClick(() => this.copyList());
    this.mainBtn = new ButtonComponent(actions).onClick(() => this.decide());
    this.mainBtn.buttonEl.dataset.testid = "geode-missing-main";
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private setView(view: "folders" | "recent"): void {
    this.view = view;
    this.render();
  }

  private render(): void {
    this.rendering = true;
    try {
      const total = this.hold.files.length;
      const allSelected = this.selected.size === total;
      this.totalEl.setText(filesMissing(total));
      this.subEl.setText(`of ${formatCount(this.hold.totalTracked)} tracked. ${HOLD_NOTE}`);
      this.foldersTab.toggleClass("is-active", this.view === "folders");
      this.recentTab.toggleClass("is-active", this.view === "recent");
      this.selectAll.setValue(allSelected);
      this.selectAll.toggleEl.toggleClass("is-partial", this.selected.size > 0 && !allSelected);
      this.bodyEl.empty();
      if (this.view === "folders") this.renderFolders();
      else this.renderRecent();
      this.renderAction();
    } finally {
      this.rendering = false;
    }
  }

  private renderFolders(): void {
    const treeEl = this.bodyEl.createDiv({ cls: "geode-missing-tree" });
    for (const node of missingTree(this.hold.files, this.selected)) {
      this.folderRow(treeEl, node);
    }
    // Files at the vault root belong to no folder; they get their own row at the bottom.
    const roots = rootFiles(this.hold.files).length;
    if (roots > 0) this.rootRow(treeEl, roots);
  }

  private folderRow(parent: HTMLElement, node: FolderNode): void {
    // ON only when every file under the folder is selected: a partial folder shows OFF
    // with the partial track, so one tap selects the whole subtree.
    const state = folderState(node);
    const hasChildren = node.children.length > 0;
    const expanded = !this.collapsed.has(node.path);
    const item = parent.createDiv({ cls: "tree-item nav-folder" });
    if (!expanded) item.addClass("is-collapsed");
    const self = item.createDiv({
      cls: `tree-item-self nav-folder-title is-clickable${hasChildren ? " mod-collapsible" : ""}`,
    });
    if (hasChildren) {
      const arrow = self.createDiv({
        cls: `tree-item-icon collapse-icon${expanded ? "" : " is-collapsed"}`,
      });
      setIcon(arrow, "right-triangle");
    }
    self.createDiv({ cls: "tree-item-inner nav-folder-title-content", text: node.name });
    if (state === "partial") self.createSpan({ cls: "geode-missing-partial", text: "· partial" });
    const toggle = this.rowToggle(self, node.count, state === "all", state === "partial");
    toggle.toggleEl.dataset.testid = "geode-missing-folder-toggle";
    toggle.toggleEl.dataset.path = node.path;
    if (state === "all") item.addClass("geode-missing-del");
    toggle.onChange((on) => {
      this.selected = new Set(selectSubtree(this.hold.files, this.selected, node.path, on));
      this.render();
    });
    if (!hasChildren) return;
    self.onClickEvent((evt) => {
      if ((evt.target as HTMLElement).closest(".checkbox-container")) return;
      if (this.collapsed.has(node.path)) this.collapsed.delete(node.path);
      else this.collapsed.add(node.path);
      this.render();
    });
    if (!expanded) return;
    const kids = item.createDiv({ cls: "tree-item-children nav-folder-children" });
    for (const child of node.children) this.folderRow(kids, child);
  }

  private rootRow(parent: HTMLElement, count: number): void {
    const state = rootState(this.hold.files, this.selected);
    const item = parent.createDiv({ cls: "tree-item nav-folder" });
    const self = item.createDiv({ cls: "tree-item-self nav-folder-title" });
    self.createDiv({
      cls: "tree-item-inner nav-folder-title-content",
      text: `Root (${this.app.vault.getName()})`,
    });
    if (state === "partial") self.createSpan({ cls: "geode-missing-partial", text: "· partial" });
    const toggle = this.rowToggle(self, count, state === "all", state === "partial");
    toggle.toggleEl.dataset.testid = "geode-missing-root-toggle";
    if (state === "all") item.addClass("geode-missing-del");
    toggle.onChange((on) => {
      this.selected = new Set(selectRootFiles(this.hold.files, this.selected, on));
      this.render();
    });
  }

  /** The right-hand count + Delete switch every folder-like row shares. */
  private rowToggle(
    row: HTMLElement,
    count: number,
    on: boolean,
    partial: boolean,
  ): ToggleComponent {
    const right = row.createDiv({ cls: "geode-missing-row-right" });
    right.createSpan({ cls: "geode-missing-count", text: formatCount(count) });
    const toggle = new ToggleComponent(right);
    toggle.setValue(on);
    if (partial) toggle.toggleEl.addClass("is-partial");
    return toggle;
  }

  private renderRecent(): void {
    const list = this.bodyEl.createDiv({ cls: "geode-missing-list" });
    for (const file of recentFirst(this.hold.files)) {
      const del = this.selected.has(file.path);
      const row = list.createDiv({
        cls: `geode-missing-file${del ? " geode-missing-file-del" : ""}`,
      });
      row.createDiv({
        cls: "geode-missing-file-name",
        text: file.path.split("/").pop() ?? file.path,
        attr: { title: file.path },
      });
      const meta = row.createDiv({ cls: "geode-missing-file-meta" });
      meta.createSpan({ cls: "geode-missing-file-folder", text: folderLabel(file.path) });
      meta.createSpan({ cls: "geode-missing-file-date", text: formatDay(file.mtime) });
      const toggle = new ToggleComponent(row.createDiv({ cls: "geode-missing-file-toggle" }));
      toggle.toggleEl.dataset.testid = "geode-missing-file-toggle";
      toggle.toggleEl.dataset.path = file.path;
      toggle.setValue(del);
      toggle.onChange((on) => {
        this.selected = new Set(toggleFile(this.selected, file.path, on));
        this.render();
      });
    }
  }

  /** The label states the outcome of the current switches: keeping everything is the
   * accent restore, deleting anything the calmer destructive tint. */
  private renderAction(): void {
    const action = mainAction(this.hold.files.length, this.selected.size);
    this.mainBtn.setButtonText(action.label);
    this.mainBtn.buttonEl.toggleClass("mod-cta", action.tone === "restore");
    this.mainBtn.buttonEl.toggleClass("mod-destructive", action.tone === "delete");
    this.mainBtn.buttonEl.disabled = this.busy;
  }

  /** Nothing to delete restores straight away; deleting asks once, and neither the review's
   * main button nor the confirm defaults to the destructive one. */
  private decide(): void {
    if (this.busy || this.confirming) return;
    const deleting = this.selected.size;
    if (deleting === 0) {
      void this.apply();
      return;
    }
    this.confirming = true;
    new ConfirmModal(this.app, {
      title: confirmTitle(deleting),
      message: confirmMessage(this.hold.files.length - deleting, this.retention),
      confirmText: "Delete files",
      cancelText: "Go back",
      onConfirm: () => this.apply(),
      onClosed: () => {
        this.confirming = false;
      },
    }).open();
  }

  /** A decision can fail (sync paused, a restore that did not land): the window stays open
   * with the reason and the selection, so the user can resume sync and retry. */
  private async apply(): Promise<void> {
    this.busy = true;
    this.showError(null);
    this.renderAction();
    try {
      await this.host.resolve([...this.selected]);
    } catch (error) {
      this.showError(formatUserError(error));
      return;
    } finally {
      this.busy = false;
      this.renderAction();
    }
    this.host.notify("Sync resumed");
    this.close();
  }

  private showError(message: string | null): void {
    this.errorEl.setText(message ?? "");
    this.errorEl.toggleClass("geode-hidden", message === null);
  }

  private copyList(): void {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      this.showError("Could not copy the list. The clipboard is not available.");
      return;
    }
    clipboard.writeText(copyText(this.hold.files)).then(
      () => this.host.notify(`Copied ${formatCount(this.hold.files.length)} file paths.`),
      (error) => this.showError(`Could not copy the list. ${formatUserError(error)}`),
    );
  }
}

/** The whole notice opens the review, which is the only thing that lets sync move again. */
export function notifyMassDeleteHold(hold: MassDeleteHold, open: () => void): void {
  const notice = new Notice(holdNoticeText(hold.files.length, Platform.isMobile), 12000);
  notice.noticeEl.addClass("geode-missing-notice");
  notice.noticeEl.onClickEvent(open);
}
