/** #601: the review window's decisions: folder tree, per-folder state, the shared
 * per-file selection, the main button, and every string the window shows. No obsidian
 * import (safe for deno unit tests). */

import type { HeldFile } from "../sync/mass-delete-hold.ts";

export type FolderNode = {
  path: string;
  name: string;
  count: number;
  delCount: number;
  children: FolderNode[];
};

export type FolderState = "none" | "partial" | "all";

export type MainAction = { label: string; tone: "restore" | "delete" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Last known edit time, as the Recent list shows it. */
export function formatDay(mtime: number): string {
  const d = new Date(mtime);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** The folder a Recent row names; a root file has no folder of its own. */
export function folderLabel(path: string): string {
  const segs = path.split("/").slice(0, -1);
  return segs.length ? `${segs.join("/")}/` : "/";
}

/** Missing files grouped by folder, each node carrying the count and how many of them
 * are marked for deletion. A folder with no missing file below it has nothing to decide,
 * so it never appears; the Folders view and the Recent list share one per-file selection. */
export function missingTree(
  files: readonly HeldFile[],
  selected: ReadonlySet<string>,
): FolderNode[] {
  const byPath = new Map<string, FolderNode>();
  const roots: FolderNode[] = [];
  for (const file of files) {
    const hit = selected.has(file.path) ? 1 : 0;
    let siblings = roots;
    let prefix = "";
    for (const seg of file.path.split("/").slice(0, -1)) {
      prefix += `${seg}/`;
      let node = byPath.get(prefix);
      if (!node) {
        node = { path: prefix, name: seg, count: 0, delCount: 0, children: [] };
        byPath.set(prefix, node);
        siblings.push(node);
      }
      node.count += 1;
      node.delCount += hit;
      siblings = node.children;
    }
  }
  sortSiblings(roots);
  return roots;
}

function sortSiblings(nodes: FolderNode[]): void {
  nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  for (const node of nodes) sortSiblings(node.children);
}

/** None = keep the whole folder, all = delete it, partial = some of it (the switch stays
 * off with the light red track, so one tap still selects everything below). */
export function folderState(node: FolderNode): FolderState {
  if (node.delCount === 0) return "none";
  return node.delCount === node.count ? "all" : "partial";
}

/** Folder rows edit the same per-file set as the Recent list, one file at a time. */
export function selectSubtree(
  files: readonly HeldFile[],
  selected: ReadonlySet<string>,
  folderPath: string,
  on: boolean,
): string[] {
  const next = new Set(selected);
  for (const { path } of files) {
    if (!path.startsWith(folderPath)) continue;
    if (on) next.add(path);
    else next.delete(path);
  }
  return [...next];
}

export function toggleFile(selected: ReadonlySet<string>, path: string, on: boolean): string[] {
  const next = new Set(selected);
  if (on) next.add(path);
  else next.delete(path);
  return [...next];
}

export function selectAllFiles(held: readonly HeldFile[], on: boolean): string[] {
  return on ? held.map((f) => f.path) : [];
}

/** Held files at the vault root: they belong to no folder row, so the Folders view lists
 * them together at the bottom. */
export function rootFiles(held: readonly HeldFile[]): HeldFile[] {
  return held.filter((f) => !f.path.includes("/"));
}

export function selectRootFiles(
  held: readonly HeldFile[],
  selected: ReadonlySet<string>,
  on: boolean,
): string[] {
  const next = new Set(selected);
  for (const { path } of rootFiles(held)) {
    if (on) next.add(path);
    else next.delete(path);
  }
  return [...next];
}

export function rootState(
  held: readonly HeldFile[],
  selected: ReadonlySet<string>,
): FolderState {
  const roots = rootFiles(held);
  const marked = roots.filter((f) => selected.has(f.path)).length;
  if (marked === 0) return "none";
  return marked === roots.length ? "all" : "partial";
}

/** Recent: every held file, newest first (no cap; the list scrolls). */
export function recentFirst(files: readonly HeldFile[]): HeldFile[] {
  return [...files].sort((a, b) => b.mtime - a.mtime);
}

/** The label states the outcome of the current toggles, so the switches need no legend:
 * keeping everything is the accent restore, deleting anything is the calmer destructive. */
export function mainAction(total: number, deleting: number): MainAction {
  if (deleting === 0) return { label: `Restore ${fileCount(total)}`, tone: "restore" };
  if (deleting === total) return { label: `Delete ${fileCount(total)}`, tone: "delete" };
  return {
    label: `Delete ${fileCount(deleting)}, restore ${formatCount(total - deleting)}`,
    tone: "delete",
  };
}

export function confirmTitle(deleting: number): string {
  return `Delete ${fileCount(deleting)} on all devices?`;
}

/** The footer's trash promise, at the effective retention the Trash window shows. */
export function trashNote(days: number): string {
  return `Deleted files stay in the trash for ${dayCount(days)}.`;
}

/** The confirmation carries the same trash promise, plus what comes back when mixed. */
export function confirmMessage(keeping: number, days: number): string {
  const base = `They stay in the trash for ${dayCount(days)}.`;
  if (keeping === 0) return base;
  return `${base} ${fileCount(keeping)} ${keeping === 1 ? "is" : "are"} restored.`;
}

/** The second sentence of the hold, for headers that already show the count. */
export const HOLD_NOTE = "Sync is on hold.";

/** The banner, the window header and the icon tooltip share one sentence. */
export function holdSentence(count: number): string {
  return `${filesMissing(count)}. ${HOLD_NOTE}`;
}

export function holdNoticeText(count: number, isMobile: boolean): string {
  const action = isMobile ? "Tap to review." : "Click to review.";
  return `${holdSentence(count)} ${action}`;
}

/** "1,850 files missing": the banner, the window header and the icon tooltip. */
export function filesMissing(n: number): string {
  return `${fileCount(n)} missing`;
}

/** Copy list: every held path, sorted, one per line. */
export function copyText(held: readonly HeldFile[]): string {
  return [...held]
    .map((f) => f.path)
    .sort((a, b) => a.localeCompare(b))
    .join("\n");
}

function fileCount(n: number): string {
  return `${formatCount(n)} file${n === 1 ? "" : "s"}`;
}

function dayCount(days: number): string {
  return `${formatCount(days)} day${days === 1 ? "" : "s"}`;
}
