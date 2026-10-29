import { App, Modal, SearchComponent, setIcon, Setting, ToggleComponent } from "obsidian";
import { buildFolderTree, type FolderNode, nodeSync } from "./folder-scope.ts";

// #342: Manage modal: the vault folder tree styled like the File explorer
// (chevrons, indent guide) with a toggle per folder. Pure logic in folder-scope.ts.

export type FoldersModalHost = {
  getScope: () => { excluded: string[]; included: string[] };
  /** Called after the settings are saved for a toggle; re-renders the row in place. */
  onToggled: (path: string, on: boolean) => void;
};

export class FoldersModal extends Modal {
  private query = "";
  private expanded = new Set<string>();
  private treeEl: HTMLElement | null = null;
  private tree: FolderNode[] = [];

  constructor(app: App, private host: FoldersModalHost) {
    super(app);
    this.modalEl.addClass("geode-folders-modal");
  }

  onOpen(): void {
    const c = this.contentEl;
    new Setting(c).setHeading().setName("Sync folders");
    const search = new SearchComponent(c);
    search.setPlaceholder("Filter folders…");
    search.inputEl.dataset.testid = "geode-folder-search";
    search.onChange((v) => {
      this.query = v.trim().toLowerCase();
      this.renderTree();
    });
    this.treeEl = c.createDiv({ cls: "geode-folders-tree" });
    this.tree = buildFolderTree(this.app.vault.getAllLoadedFiles().map((f) => f.path));
    this.renderTree();
    new Setting(c).addButton((b) => b.setButtonText("Done").setCta().onClick(() => this.close()));
  }

  // Does this node or any descendant match the live query? (keeps matches' ancestors visible)
  private hasMatch(node: FolderNode): boolean {
    const q = this.query;
    if (!q) return true;
    if (node.name.toLowerCase().includes(q)) return true;
    return node.folders.some((c) => this.hasMatch(c));
  }

  private renderTree(): void {
    if (!this.treeEl) return;
    this.treeEl.empty();
    let visible = 0;
    for (const node of this.tree) visible += this.folderRow(this.treeEl, node);
    if (this.query && visible === 0) {
      this.treeEl.createDiv({ cls: "geode-folders-no-matches", text: "No matching folders." });
    }
  }

  // One row of the tree, built with the file explorer's own DOM/classes so
  // Obsidian's app.css styles it (chevron, indent guide, row height, hover).
  private folderRow(parent: HTMLElement, node: FolderNode): number {
    if (!this.hasMatch(node)) return 0;
    const hasChildren = node.folders.length > 0;
    const { excluded, included } = this.host.getScope();
    const sync = nodeSync(excluded, included, node);
    const expanded = this.query
      ? hasChildren && node.folders.some((c) => this.hasMatch(c))
      : hasChildren && this.expanded.has(node.path);

    const item = parent.createDiv({
      cls: "tree-item nav-folder" + (expanded ? "" : " is-collapsed"),
    });
    const self = item.createDiv({
      cls: "tree-item-self nav-folder-title is-clickable" + (hasChildren ? " mod-collapsible" : ""),
    });
    self.dataset.testid = "geode-folder-row";
    self.dataset.path = node.path;
    if (hasChildren) {
      setIcon(
        self.createDiv({ cls: "tree-item-icon collapse-icon" + (expanded ? "" : " is-collapsed") }),
        "right-triangle",
      );
    }
    self.createDiv({ cls: "tree-item-inner nav-folder-title-content", text: node.name });
    if (sync === "partial") self.createSpan({ cls: "geode-folder-partial", text: "· partial" });
    const toggle = new ToggleComponent(self.createDiv({ cls: "geode-folder-toggle" }));
    toggle.toggleEl.dataset.testid = "geode-folder-toggle";
    toggle.toggleEl.dataset.path = node.path;
    toggle.setValue(sync !== "off");
    if (sync === "off") item.addClass("geode-folder-off");
    toggle.onChange((v) => {
      this.host.onToggled(node.path, v);
      this.renderTree();
    });
    if (hasChildren) {
      self.onClickEvent((evt) => {
        if ((evt.target as HTMLElement | null)?.closest(".checkbox-container")) return;
        if (this.expanded.has(node.path)) this.expanded.delete(node.path);
        else this.expanded.add(node.path);
        this.renderTree();
      });
    }
    if (expanded) {
      const kids = item.createDiv({ cls: "tree-item-children nav-folder-children" });
      for (const child of node.folders) this.folderRow(kids, child);
    }
    return 1;
  }
}
