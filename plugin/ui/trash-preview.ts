import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type { TrashApi, TrashEntry } from "../plumbing/trash-client.ts";
import { formatUserError } from "../plumbing/errors.ts";
import { FilePreview } from "./preview-render.ts";
import {
  binaryPreviewLine,
  deletedFromLabel,
  previewFetches,
  previewKind,
  restoredOneNotice,
  trashEntryLabel,
} from "./trash-format.ts";

// #455: read-only preview of a deleted file. Text notes render their markdown
// (MarkdownRenderer, owned by a dedicated Component: Modal is not a Component),
// images render the real attachment from the trashed blobs, other binaries show
// a "TYPE · size · preview not available" line with "Restore to open". The kind
// and size come from the already-decrypted list metadata, so a binary (or an
// oversized text/image) is shown as a line without downloading any content: a
// 200 MB video never fetches. Restore acts in place (Notion pattern): the row
// leaves the trash list, then the modal closes.

type PreviewDeps = {
  trash: TrashApi;
  entry: TrashEntry;
  deviceName: string;
  onRestored: () => void;
};

const OPEN_TIMEOUT_MS = 60_000;

export class PreviewModal extends Modal {
  private preview = new FilePreview(this.app);
  private disposed = false;
  private previewShown = false;

  constructor(app: App, private deps: PreviewDeps) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(trashEntryLabel(this.deps.entry));
    const c = this.contentEl;
    c.createDiv({ cls: "geode-preview-loading", text: "Loading…" });
    void this.loadContent(c);
  }

  onClose(): void {
    this.disposed = true;
    this.preview.dispose();
    this.contentEl.empty();
  }

  private async loadContent(c: HTMLElement): Promise<void> {
    const entry = this.deps.entry;
    const kind = previewKind(entry.path ?? "", entry.mime ?? "");
    // Size guard (#455): decide from the list metadata before any fetch. Binary
    // never fetches; text/image fetch only under their size cap.
    if (!previewFetches(kind, entry.size)) {
      if (this.disposed) return;
      c.empty();
      this.renderBinary(c, entry.path ?? "", entry.mime ?? "", entry.size);
      this.renderFooter(c);
      return;
    }
    let bytes: Uint8Array;
    let mime: string;
    try {
      const content = await this.deps.trash.preview(this.deps.entry.path_hash);
      bytes = content.bytes;
      mime = content.mime;
    } catch {
      if (this.disposed) return;
      c.empty();
      c.createDiv({ cls: "geode-trash-error", text: "Couldn't load this file." });
      this.renderFooter(c);
      return;
    }
    if (this.disposed) return;
    c.empty();
    this.previewShown = true;
    const sourcePath = this.deps.entry.path ?? "";
    const el = kind === "text"
      ? this.preview.markdown(c, new TextDecoder().decode(bytes), sourcePath)
      : this.preview.image(c, bytes, mime);
    el.dataset.testid = kind === "text" ? "geode-preview-markdown" : "geode-preview-image";
    this.renderFooter(c);
  }

  private renderBinary(c: HTMLElement, path: string, mime: string, size: number | undefined): void {
    this.preview.binary(c, binaryPreviewLine(path, mime, size)).dataset.testid =
      "geode-preview-binary";
  }

  private renderFooter(c: HTMLElement): void {
    const entry = this.deps.entry;
    new Setting(c)
      .setName(deletedFromLabel(entry.trashed_at, this.deps.deviceName))
      .addButton((b) => {
        b.setCta().setButtonText(this.previewShown ? "Restore" : "Restore to open");
        b.buttonEl.dataset.testid = "geode-preview-restore";
        b.onClick(() => void this.restore());
      })
      .addButton((b) => {
        b.setButtonText("Close");
        b.buttonEl.dataset.testid = "geode-preview-close";
        b.onClick(() => this.close());
      });
  }

  private async restore(): Promise<void> {
    const entry = this.deps.entry;
    try {
      await this.deps.trash.restore(entry.path_hash);
      new Notice(restoredOneNotice(trashEntryLabel(entry)));
      this.deps.onRestored();
      this.close();
      if (!this.previewShown && entry.path) void this.openAfterRestore(entry.path);
    } catch (err) {
      new Notice(`Failed to restore. ${formatUserError(err)}`, 10000);
    }
  }

  /** Unpreviewable files restore to open: wait for the synced file, then open it. */
  private async openAfterRestore(path: string): Promise<void> {
    const file = await waitForRestoredFile(this.app, path);
    if (file) await this.app.workspace.getLeaf(true).openFile(file);
  }
}

/** Resolve with the file once it exists (create event), or null after a minute. */
function waitForRestoredFile(app: App, path: string): Promise<TFile | null> {
  return new Promise((resolve) => {
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      resolve(existing);
      return;
    }
    const ref = app.vault.on("create", (file) => {
      if (file.path !== path) return;
      app.vault.offref(ref);
      clearTimeout(timer);
      resolve(file as TFile);
    });
    const timer = setTimeout(() => {
      app.vault.offref(ref);
      resolve(null);
    }, OPEN_TIMEOUT_MS);
  });
}
