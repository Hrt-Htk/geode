// #432/#435: the Conflicts list: one compact row per open conflict: the file
// name over its folder, a type icon, Review opening the per file comparison,
// and Open both as the manual merge path. Notes are reviewed there; images,
// PDFs and other binaries keep their thumbnails and in row keep actions. The
// confirm, resolve, notice and reload flow lives here, shared with the review
// window: keep actions always name the file they keep, never mine/theirs.

import { App, Modal, Notice, Platform, SearchComponent, setIcon, Setting, TFile } from "obsidian";
import {
  type ConflictRow,
  filterConflictRows,
  formatSize,
  typeLabel,
} from "../sync/conflict-list.ts";
import { type ResolutionAction, resolutionLabel } from "../sync/conflict-resolve.ts";
import { formatUserError } from "../plumbing/errors.ts";
import { confirmKeepVersion } from "./confirm-copy.ts";
import { ConfirmModal } from "./confirm-modal.ts";
import { ConflictReviewModal } from "./conflict-review-modal.ts";
import {
  dateStamp,
  fileName,
  folderLine,
  KEEP_BOTH_BUTTON,
  KEEP_CONFLICT_BUTTON,
  KEEP_ORIGINAL_BUTTON,
  keepActions,
  NO_DATE,
  OPEN_BOTH_LINK,
  REVIEW_BUTTON,
  versionSides,
} from "./conflict-review-view.ts";

export interface ConflictsModalDeps {
  loadRows: (deviceNames: Map<string, string> | null) => Promise<ConflictRow[]>;
  /** Executes the resolution; returns the kept copy path for keep both. */
  resolve: (row: ConflictRow, action: ResolutionAction) => Promise<string | null>;
  deviceName: () => string;
  /** One-shot deviceId→name fetch; null on failure keeps the neutral labels. */
  remoteNames?: () => Promise<Map<string, string> | null>;
}

export class ConflictsModal extends Modal {
  private query = "";
  private rows: ConflictRow[] = [];
  private deviceNames: Map<string, string> | null = null;
  private bodyEl!: HTMLElement;

  constructor(app: App, private deps: ConflictsModalDeps) {
    super(app);
    this.modalEl.addClass("geode-conflicts-modal");
  }

  onOpen(): void {
    this.setTitle("Conflicts");
    // Kept outside render so typing never loses focus.
    const search = new SearchComponent(this.contentEl);
    search.setPlaceholder("Filter by file path…");
    search.inputEl.dataset.testid = "geode-conflicts-search";
    search.onChange((v) => {
      this.query = v.trim();
      this.render();
    });
    this.bodyEl = this.contentEl.createDiv({ cls: "geode-conflicts-body" });
    new Setting(this.contentEl).addButton((b) => {
      b.setCta().setButtonText("Done");
      b.buttonEl.dataset.testid = "geode-conflicts-done";
      b.onClick(() => this.close());
    });
    this.render();
    void this.reload();
    // Rows render "Another device" until the device list lands, then re-render.
    void this.deps.remoteNames?.().then((names) => {
      if (names) {
        this.deviceNames = names;
        void this.reload();
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async reload(): Promise<void> {
    this.rows = await this.deps.loadRows(this.deviceNames);
    this.render();
  }

  private render(): void {
    const c = this.bodyEl;
    c.empty();
    const shown = filterConflictRows(this.rows, this.query);
    const scroll = c.createDiv({ cls: "geode-conflicts-scroll" });
    if (this.rows.length === 0) {
      this.renderEmpty(scroll);
    } else if (shown.length === 0) {
      const nomatch = scroll.createDiv({ cls: "geode-no-matches", text: "No matches." });
      nomatch.dataset.testid = "geode-conflicts-no-matches";
    } else {
      for (const row of shown) this.renderRow(scroll, row);
    }
  }

  private renderRow(parent: HTMLElement, row: ConflictRow): void {
    const el = parent.createDiv({ cls: "geode-conflict-row" });
    el.dataset.testid = "geode-conflict-row";
    el.setAttr("data-path", row.path);
    const head = el.createDiv({ cls: "geode-conflict-head" });
    const icon = head.createSpan({ cls: "geode-conflict-icon" });
    setIcon(icon, row.type === "image" ? "image" : "file-text");
    const text = head.createDiv({ cls: "geode-conflict-text" });
    text.createDiv({
      cls: "geode-conflict-name",
      text: fileName(row.path),
      attr: { title: row.path },
    });
    const folder = folderLine(row.path);
    if (folder) text.createDiv({ cls: "geode-conflict-folder", text: folder });
    // The icon already carries the type; the tag stays only on rows with no diff.
    if (row.type !== "note") {
      head.createSpan({ cls: "geode-conflict-type", text: typeLabel(row.type) });
      this.renderBinary(el, row);
    }
    const actions = el.createDiv({ cls: "geode-conflict-actions" });
    if (row.type === "note") {
      const review = actions.createEl("button", { text: REVIEW_BUTTON, cls: "mod-cta" });
      review.dataset.testid = "geode-conflict-review";
      review.onClickEvent(() => this.review(row));
    } else {
      this.renderKeep(actions, row, "original", KEEP_ORIGINAL_BUTTON);
      this.renderKeep(actions, row, "conflict", KEEP_CONFLICT_BUTTON);
      const both = actions.createEl("button", { text: KEEP_BOTH_BUTTON });
      both.dataset.testid = "geode-conflict-keep-both";
      both.onClickEvent(() => void this.resolveAction(row, "keep-both"));
    }
    const subtle = actions.createDiv({ cls: "geode-conflict-subtle" });
    const openBoth = subtle.createEl("a", { href: "#", text: OPEN_BOTH_LINK });
    openBoth.dataset.testid = "geode-conflict-open-both";
    openBoth.onClickEvent((e) => {
      e.preventDefault();
      this.openBoth(row);
    });
  }

  /** Images, PDFs and other binaries: the two versions' cards, thumbnail first. */
  private renderBinary(parent: HTMLElement, row: ConflictRow): void {
    const { original, conflict } = versionSides(row);
    const versions = parent.createDiv({ cls: "geode-conflict-versions" });
    for (const [path, side] of [[row.path, original], [row.conflictPath, conflict]] as const) {
      const card = versions.createDiv({ cls: "geode-conflict-version" });
      if (row.type === "image") {
        const file = this.app.vault.getAbstractFileByPath(path);
        const src = file instanceof TFile ? this.app.vault.getResourcePath(file) : "";
        card.createDiv({ cls: "geode-conflict-thumb" }).createEl("img", { attr: { src } });
      }
      card.createDiv({ cls: "geode-conflict-device", text: side.device });
      const when = side.time === null ? NO_DATE : dateStamp(side.time);
      const size = side.size !== null ? ` · ${formatSize(side.size)}` : "";
      card.createDiv({ cls: "geode-conflict-meta", text: when + size });
    }
  }

  private renderKeep(
    actions: HTMLElement,
    row: ConflictRow,
    side: "original" | "conflict",
    text: string,
  ): void {
    const button = actions.createEl("button", { text });
    button.dataset.testid = `geode-conflict-keep-${side}`;
    button.onClickEvent(() => void this.resolveAction(row, keepActions(row)[side]));
  }

  private renderEmpty(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: "geode-conflicts-empty" });
    box.dataset.testid = "geode-conflicts-empty";
    setIcon(box.createDiv({ cls: "geode-conflicts-empty-icon" }), "git-merge");
    box.createDiv({ cls: "geode-conflicts-empty-title", text: "No conflicts." });
  }

  private review(row: ConflictRow): void {
    new ConflictReviewModal(this.app, {
      row,
      resolve: (action) => this.resolveAction(row, action),
    }).open();
  }

  private resolveAction(row: ConflictRow, action: ResolutionAction): Promise<boolean> {
    return action === "keep-both" ? this.keepBoth(row) : this.keepOne(row, action);
  }

  // Keep original / Keep conflict delete the other version: destructive, so a
  // one line confirm first (Keep both does not).
  private keepOne(row: ConflictRow, action: "keep-mine" | "keep-theirs"): Promise<boolean> {
    const keep = action === "keep-mine" ? row.mine : row.theirs;
    const drop = action === "keep-mine" ? row.theirs : row.mine;
    return new Promise((done) => {
      let resolved = false;
      new ConfirmModal(this.app, {
        ...confirmKeepVersion(keep.device, drop.device),
        onClosed: () => done(resolved),
        onConfirm: async () => {
          try {
            await this.deps.resolve(row, action);
          } catch (e) {
            new Notice(formatUserError(e));
            await this.reload();
            return;
          }
          resolved = true;
          new Notice(
            `Resolved · ${resolutionLabel(action, this.deps.deviceName(), row.theirs.device)}`,
          );
          await this.reload();
        },
      }).open();
    });
  }

  // Keep both is non-destructive: the conflict file stays, renamed so it is no
  // longer flagged: the Notice says exactly that.
  private async keepBoth(row: ConflictRow): Promise<boolean> {
    let keptPath: string | null;
    try {
      keptPath = await this.deps.resolve(row, "keep-both");
    } catch (e) {
      new Notice(formatUserError(e));
      await this.reload();
      return false;
    }
    new Notice(keptPath ? `Kept both. "${keptPath}" is next to the original.` : "Kept both.");
    await this.reload();
    return true;
  }

  // Manual merge: original in the current leaf, the conflict file in a real
  // vertical split to its right; an already-open file is revealed, never
  // duplicated. Phones have no split panes: new tab + a switch-tabs notice.
  private openBoth(row: ConflictRow): void {
    const orig = this.app.vault.getAbstractFileByPath(row.path);
    const cf = this.app.vault.getAbstractFileByPath(row.conflictPath);
    if (!(orig instanceof TFile) || !(cf instanceof TFile)) return;
    const leafFor = (file: TFile) => {
      for (const type of ["markdown", "image", "pdf", "canvas"]) {
        const found = this.app.workspace
          .getLeavesOfType(type)
          .find((l) => (l.view as { file?: TFile } | null)?.file?.path === file.path);
        if (found) return found;
      }
      return null;
    };
    let left = leafFor(orig);
    if (!left) {
      left = this.app.workspace.getLeaf(false);
      void left.openFile(orig);
    }
    let right = leafFor(cf);
    if (!right) {
      if (Platform.isMobile) {
        right = this.app.workspace.getLeaf(true);
        void right.openFile(cf);
        new Notice("Opened both. Switch tabs to compare.");
      } else {
        this.app.workspace.setActiveLeaf(left, { focus: true });
        right = this.app.workspace.getLeaf("split", "vertical");
        void right.openFile(cf);
      }
    }
    this.app.workspace.setActiveLeaf(right, { focus: true });
    this.close();
  }
}
