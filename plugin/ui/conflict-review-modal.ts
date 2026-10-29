// #435: one conflict, reviewed on its own: the two versions compared line by
// line (shared lines plain, each version's own lines in its color with a margin
// bar), the two names as the color key with their device, date and time, and the
// keep actions plus Back to the list. Notes only: the list keeps binaries with
// their thumbnails. A conflict file deleted on another device leaves nothing to
// compare or keep, so the window says so and offers only Back.

import { App, Modal } from "obsidian";
import type { ConflictRow } from "../sync/conflict-list.ts";
import type { ResolutionAction } from "../sync/conflict-resolve.ts";
import {
  BACK_BUTTON,
  type ComparedLine,
  comparedLines,
  CONFLICT_GONE,
  KEEP_BOTH_BUTTON,
  KEEP_CONFLICT_BUTTON,
  KEEP_ORIGINAL_BUTTON,
  keepActions,
  LOADING_TEXT,
  READ_FAILED,
  reviewKeys,
  reviewTitle,
} from "./conflict-review-view.ts";

export type ConflictReviewDeps = {
  row: ConflictRow;
  /** The list's confirm, resolve and reload flow; true once it is resolved. */
  resolve: (action: ResolutionAction) => Promise<boolean>;
};

export class ConflictReviewModal extends Modal {
  private lines: ComparedLine[] | null = null;
  /** The conflict file is gone, so there is no version to keep. */
  private gone = false;
  private failed = false;
  private busy = false;

  constructor(app: App, private deps: ConflictReviewDeps) {
    super(app);
    this.modalEl.addClass("geode-conflict-review-modal");
  }

  onOpen(): void {
    this.setTitle(reviewTitle(this.deps.row.path));
    this.render();
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** The two files are read apart: a missing conflict file means the conflict
   * resolved itself elsewhere, an unreadable original only costs the comparison. */
  private async load(): Promise<void> {
    const { path, conflictPath } = this.deps.row;
    const [original, conflict] = await Promise.allSettled([
      this.app.vault.adapter.read(path),
      this.app.vault.adapter.read(conflictPath),
    ]);
    if (conflict.status === "rejected") this.gone = true;
    else if (original.status === "rejected") this.failed = true;
    else this.lines = comparedLines(original.value, conflict.value);
    this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    this.renderKeys(c);
    this.renderBody(c.createDiv({ cls: "geode-conflict-review-body" }));
    this.renderActions(c);
  }

  private renderKeys(parent: HTMLElement): void {
    const box = parent.createDiv({ cls: "geode-conflict-key" });
    const { original, conflict } = reviewKeys(this.deps.row);
    for (const [side, key] of [["original", original], ["conflict", conflict]] as const) {
      const col = box.createDiv({ cls: `geode-conflict-key-item mod-${side}` });
      col.dataset.testid = `geode-conflict-key-${side}`;
      col.createDiv({ cls: "geode-conflict-key-label", text: key.label });
      col.createDiv({
        cls: "geode-conflict-key-name",
        text: key.name,
        attr: { title: key.path },
      });
      col.createDiv({ cls: "geode-conflict-key-meta", text: `${key.device} · ${key.when}` });
    }
  }

  private renderBody(body: HTMLElement): void {
    if (this.gone || !this.lines) {
      const note = body.createDiv({
        cls: "geode-conflict-note",
        text: this.gone ? CONFLICT_GONE : this.failed ? READ_FAILED : LOADING_TEXT,
      });
      if (this.gone) note.dataset.testid = "geode-conflict-gone";
      return;
    }
    const diff = body.createDiv({ cls: "geode-conflict-diff" });
    diff.dataset.testid = "geode-conflict-diff";
    for (const line of this.lines) {
      const el = diff.createDiv({
        cls: `geode-conflict-diff-line mod-${line.kind}`,
        text: line.text,
      });
      el.dataset.testid = "geode-conflict-diff-line";
      el.setAttr("data-kind", line.kind);
    }
  }

  private renderActions(parent: HTMLElement): void {
    const actions = parent.createDiv({ cls: "geode-conflict-review-actions" });
    if (!this.gone) {
      const keep = keepActions(this.deps.row);
      const buttons: Array<[string, string, ResolutionAction]> = [
        [KEEP_ORIGINAL_BUTTON, "geode-conflict-keep-original", keep.original],
        [KEEP_CONFLICT_BUTTON, "geode-conflict-keep-conflict", keep.conflict],
        [KEEP_BOTH_BUTTON, "geode-conflict-keep-both", "keep-both"],
      ];
      for (const [text, testid, action] of buttons) {
        this.button(actions, text, testid, () => this.keep(action));
      }
    }
    this.button(
      actions,
      BACK_BUTTON,
      "geode-conflict-back",
      () => this.close(),
      "geode-conflict-back",
    );
  }

  private button(
    parent: HTMLElement,
    text: string,
    testid: string,
    run: () => void | Promise<void>,
    cls?: string,
  ): void {
    const el = parent.createEl("button", { text, cls });
    el.dataset.testid = testid;
    el.onClickEvent(() => void run());
  }

  /** A confirmed keep leaves the review, a cancelled or failed one stays open;
   * one resolution at a time, so a second click before it settles is ignored. */
  private async keep(action: ResolutionAction): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (await this.deps.resolve(action)) this.close();
    } finally {
      this.busy = false;
    }
  }
}
