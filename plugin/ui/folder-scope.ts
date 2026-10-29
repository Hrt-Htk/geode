import { isPathInScope, isRejoinBackupPath } from "../plumbing/settings-types.ts";

// #342: pure folder-scope logic for the "Sync folders" row and Manage tree.
//
// Model: two minimal lists of normalized folder prefixes (trailing slash):
//   excluded: folders switched off
//   included: folders switched on inside a switched off ancestor (exceptions)
// A path is in scope when the DEEPEST list entry covering it is an inclusion,
// or when no entry covers it (default: everything syncs). Switching a folder
// off/on drops every entry underneath it, so the lists stay minimal and the
// deepest-entry rule is total.

export type FolderNode = { path: string; name: string; folders: FolderNode[] };
export type NodeSync = "on" | "off" | "partial";

/** Build the vault folder tree from file paths (root files contribute no folders). */
export function buildFolderTree(paths: string[]): FolderNode[] {
  const root: FolderNode = { path: "", name: "", folders: [] };
  for (const p of paths) {
    if (isRejoinBackupPath(p)) continue; // #701: never syncs, nothing to switch on
    const parts = p.split("/");
    if (parts.length < 2 || !parts[0]) continue; // skip root files and the vault root entry
    let node = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i];
      let child = node.folders.find((f) => f.path === prefix);
      if (!child) {
        child = { path: prefix, name: parts[i], folders: [] };
        node.folders.push(child);
      }
      node = child;
    }
  }
  sortTree(root);
  return root.folders;
}

function sortTree(node: FolderNode): void {
  node.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  for (const child of node.folders) sortTree(child);
}

// The single scope decision lives in settings-types.ts (isPathInScope): the
// sync engine and the UI tree must agree on it.

/** Sync state of a tree node: on (in scope), off (out, no in-scope child),
 * partial (out, but a switched on descendant makes some children sync). */
export function nodeSync(excluded: string[], included: string[], node: FolderNode): NodeSync {
  const folder = node.path + "/"; // node paths carry no trailing slash
  if (isPathInScope(folder, excluded, included)) return "on";
  return node.folders.some((c) => isPathInScope(c.path + "/", excluded, included))
    ? "partial"
    : "off";
}

/** Tab-row summary in tree order: fully-off folders (skipping those covered by an
 * off ancestor) + partial folders with the child names that still sync. */
export function folderSummary(
  excluded: string[],
  included: string[],
  tree: FolderNode[],
): { off: string[]; partials: { path: string; on: string[] }[] } {
  const off: string[] = [];
  const partials: { path: string; on: string[] }[] = [];
  // Off children of a partial parent are implied by the "partly (… only)" clause,
  // so they are not listed again in `off`.
  const walk = (nodes: FolderNode[], parentOff: boolean, underPartial: boolean): void => {
    for (const n of nodes) {
      const sync = nodeSync(excluded, included, n);
      if (sync === "partial") {
        partials.push({
          path: n.path + "/",
          on: n.folders.filter((c) => nodeSync(excluded, included, c) !== "off").map((c) =>
            c.name + "/"
          ),
        });
        walk(n.folders, false, true);
      } else if (sync === "off") {
        if (!parentOff && !underPartial) off.push(n.path + "/");
        walk(n.folders, true, underPartial);
      } else {
        walk(n.folders, false, underPartial);
      }
    }
  };
  walk(tree, false, false);
  return { off, partials };
}

function folderOf(path: string): string {
  return path.endsWith("/") ? path : path + "/";
}

function withoutSubtree(entries: string[], folder: string): string[] {
  return entries.filter((e) => !(e === folder || e.startsWith(folder)));
}

/** Switch a folder off: exclude it and drop every entry underneath (subsumed). */
export function turnOff(
  excluded: string[],
  included: string[],
  path: string,
): { excluded: string[]; included: string[] } {
  const folder = folderOf(path);
  return {
    excluded: [...withoutSubtree(excluded, folder), folder],
    included: withoutSubtree(included, folder),
  };
}

/** Switch a folder on: drop it and every entry underneath; if an off ancestor
 * still covers it, record it as an included exception (only that path syncs). */
export function turnOn(
  excluded: string[],
  included: string[],
  path: string,
): { excluded: string[]; included: string[] } {
  const folder = folderOf(path);
  const nextExcluded = withoutSubtree(excluded, folder);
  const nextIncluded = withoutSubtree(included, folder);
  const covered = nextExcluded.some((e) => folder === e || folder.startsWith(e));
  if (covered) nextIncluded.push(folder);
  return { excluded: nextExcluded, included: nextIncluded };
}
