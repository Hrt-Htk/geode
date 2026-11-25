import { ItemView, MarkdownRenderer, WorkspaceLeaf } from "obsidian";
import { type BundledReleaseNote, selectWhatsNewContent } from "./release-check-logic.ts";
import { GEODE_RELEASES_URL } from "./server-update-logic.ts";
import { appendExternalLink } from "./server-update-modal.ts";

export const WHATS_NEW_VIEW_TYPE = "geode-whats-new";

/** #93: Workspace tab rendering bundled release notes for the installed Geode version. */
export class WhatsNewView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private installedVersion: () => string,
    private notes: () => readonly BundledReleaseNote[],
  ) {
    super(leaf);
  }

  getViewType(): string {
    return WHATS_NEW_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "What's new in Geode";
  }

  getIcon(): string {
    return "book-open";
  }

  override async onOpen(): Promise<void> {
    await this.render();
  }

  override onClose(): Promise<void> {
    this.contentEl.empty();
    return Promise.resolve();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("geode-whats-new-view");

    const container = contentEl.createDiv({ cls: "geode-whats-new-container" });
    container.dataset.testid = "geode-whats-new";

    const content = selectWhatsNewContent(this.installedVersion(), this.notes());
    if (content.kind === "empty") {
      container.createEl("h1", { text: "What's new in Geode" });
      container.createEl("p", {
        cls: "geode-whats-new-note",
        text: "No release notes are bundled with this version.",
      });
    } else {
      container.createEl("h1", { text: `What's new in Geode ${content.version}` });
      if (content.kind === "beta") {
        const note = container.createEl("p", { cls: "geode-whats-new-note" });
        note.appendText(
          `You are running beta ${content.installedVersion}. Showing notes for the latest final release. `,
        );
        appendExternalLink(
          note,
          "View beta notes on GitHub",
          GEODE_RELEASES_URL,
          "geode-whats-new-beta-link",
        );
      }
      const body = container.createDiv({ cls: "geode-whats-new-body markdown-rendered" });
      await MarkdownRenderer.render(this.app, content.body, body, "", this);
    }

    const footer = container.createDiv({ cls: "geode-whats-new-footer" });
    appendExternalLink(
      footer,
      content.kind === "empty" ? "View releases on GitHub" : "View all releases on GitHub",
      GEODE_RELEASES_URL,
      "geode-whats-new-releases",
    );
  }
}
