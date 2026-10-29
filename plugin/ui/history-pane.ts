import type { App } from "obsidian";
import type { VaultKeys } from "../../core/crypto.ts";
import type { VersionRecord } from "../../core/protocol.ts";
import { loadVersionPreview, type VersionPreview } from "./history-preview.ts";
import {
  changeLines,
  DIFF_CAPTION,
  ERROR_TEXT,
  type HistoryView,
  LOADING_TEXT,
  previewState,
  RESTORE_BUTTON,
} from "./history-view.ts";
import { FilePreview } from "./preview-render.ts";

// #464: the history modal's right pane: the selected version (rendered markdown,
// an image, or a binary line), the Changes toggle, and the line diff against the
// newest live version. The modal hands it state and re-renders; this module owns the
// loaded preview, the diff baseline, and their disposal.

export type HistoryPaneDeps = {
  path: string;
  keys: VaultKeys;
  getBlob: (hash: string) => Promise<Uint8Array>;
  /** The diff baseline: newest version whose content still exists. */
  current: () => VersionRecord | null;
  /** An async load landed: re-render. */
  onChange: () => void;
  /** The toolbar toggle (the modal owns the view state). */
  onToggleDiff: () => void;
  /** #465: confirm, then commit this version's content as a new head version. */
  onRestore: () => void;
};

export class HistoryPane {
  private preview: VersionPreview | null = null;
  private failed = false;
  private currentText: string | null = null;
  private currentFailed = false;
  private currentLoading = false;
  private wanted: string | null = null;
  private file: FilePreview;

  constructor(app: App, private deps: HistoryPaneDeps) {
    this.file = new FilePreview(app);
  }

  /** Load a version's preview; the pane shows the loading note until it lands. */
  show(record: VersionRecord | null, key: string): void {
    this.wanted = key;
    this.preview = null;
    this.failed = !record;
    if (record) void this.load(record, key);
  }

  /** Fetch the diff baseline, once; a failed attempt is retried on the next ask. */
  ensureBaseline(): void {
    if (this.currentText !== null || this.currentLoading) return;
    const current = this.deps.current();
    if (!current) {
      this.currentFailed = true;
      return;
    }
    this.currentLoading = true;
    void this.loadBaseline(current);
  }

  render(container: HTMLElement, view: HistoryView, meta: string | null): void {
    this.file.dispose();
    const state = this.preview ? previewState(view, this.preview.kind) : null;
    const toolbar = container.createDiv({ cls: "geode-history-toolbar" });
    if (state?.toggle) {
      const toggle = toolbar.createEl("button", { text: state.toggle });
      toggle.dataset.testid = "geode-history-diff-toggle";
      toggle.onClickEvent(() => this.deps.onToggleDiff());
    }
    // #465: every loaded version holds content, so it can be restored.
    if (this.preview) {
      const restore = toolbar.createEl("button", { text: RESTORE_BUTTON, cls: "mod-cta" });
      restore.dataset.testid = "geode-history-restore";
      restore.onClickEvent(() => this.deps.onRestore());
    }
    const pane = container.createDiv({ cls: "geode-history-pane" });
    pane.dataset.testid = "geode-history-pane";
    this.renderPane(pane, state?.mode ?? "version");
    if (meta) pane.createDiv({ cls: "geode-history-meta", text: meta });
  }

  dispose(): void {
    this.file.dispose();
  }

  private async load(record: VersionRecord, key: string): Promise<void> {
    try {
      const preview = await loadVersionPreview(record, this.deps.keys, this.deps.getBlob);
      if (this.wanted !== key) return;
      this.preview = preview;
    } catch {
      if (this.wanted !== key) return;
      this.failed = true;
    }
    this.deps.onChange();
  }

  private async loadBaseline(record: VersionRecord): Promise<void> {
    try {
      const preview = await loadVersionPreview(record, this.deps.keys, this.deps.getBlob);
      this.currentText = preview.kind === "text" ? preview.text : null;
      this.currentFailed = this.currentText === null;
    } catch {
      this.currentFailed = true;
    }
    this.currentLoading = false;
    this.deps.onChange();
  }

  private renderPane(pane: HTMLElement, mode: "diff" | "version"): void {
    const preview = this.preview;
    if (!preview) {
      note(pane, this.failed ? ERROR_TEXT : LOADING_TEXT);
      return;
    }
    if (preview.kind === "text" && mode === "diff") {
      this.renderDiff(pane, preview.text);
      return;
    }
    if (preview.kind === "text") {
      this.file.markdown(pane, preview.text, this.deps.path).dataset.testid =
        "geode-history-markdown";
      return;
    }
    if (preview.kind === "image") {
      this.file.image(pane, preview.bytes, preview.mime).dataset.testid = "geode-history-image";
      return;
    }
    this.file.binary(pane, preview.line).dataset.testid = "geode-history-binary";
  }

  private renderDiff(pane: HTMLElement, versionText: string): void {
    pane.createDiv({ cls: "geode-history-diff-caption", text: DIFF_CAPTION });
    if (this.currentText === null) {
      note(pane, this.currentFailed ? ERROR_TEXT : LOADING_TEXT);
      return;
    }
    const box = pane.createDiv({ cls: "geode-history-diff" });
    box.dataset.testid = "geode-history-diff";
    for (const line of changeLines(versionText, this.currentText)) {
      const el = box.createDiv({
        cls: `geode-history-diff-line mod-${line.kind}`,
        text: line.text,
      });
      el.dataset.testid = "geode-history-diff-line";
      el.setAttr("data-kind", line.kind);
    }
  }
}

function note(container: HTMLElement, text: string): void {
  container.createDiv({ cls: "geode-history-note", text });
}
