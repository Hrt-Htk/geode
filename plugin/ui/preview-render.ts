import { App, Component, MarkdownRenderer } from "obsidian";
import { toArrayBuffer } from "../plumbing/bytes.ts";

// #455 / #464: the one content renderer for a preview surface (a trashed file,
// a past version): the Component MarkdownRenderer needs (a Modal is not one) and
// the object URL an image owns, so both callers dispose identically.

export class FilePreview {
  private component: Component | null = null;
  private objectUrl: string | null = null;

  constructor(private app: App) {}

  markdown(container: HTMLElement, text: string, sourcePath: string): HTMLElement {
    this.component?.unload();
    const md = container.createDiv({ cls: "geode-preview-md" });
    this.component = new Component();
    void MarkdownRenderer.render(this.app, text, md, sourcePath, this.component);
    return md;
  }

  image(container: HTMLElement, bytes: Uint8Array, mime: string): HTMLElement {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: mime }));
    const wrap = container.createDiv({ cls: "geode-preview-image" });
    wrap.createEl("img", { attr: { src: this.objectUrl } });
    return wrap;
  }

  binary(container: HTMLElement, line: string): HTMLElement {
    return container.createDiv({ cls: "geode-preview-binary", text: line });
  }

  dispose(): void {
    this.component?.unload();
    this.component = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}
