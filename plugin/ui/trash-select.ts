// #446 (sign-off): bulk-select model + live path filter, obsidian-free. The
// selection is keyed by path, so it survives search filtering: Select all
// toggles the visible (filtered) rows only, and the selected count keeps its
// full value while filtered-out rows stay hidden.

export type TrashRowLike = { path?: string; path_hash: string };

export function visibleEntries<T extends TrashRowLike>(entries: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => (e.path ?? e.path_hash).toLowerCase().includes(q));
}

/** Drop selected paths that are no longer in the trash (restored/purged rows). */
export function pruneSelected(
  selected: Set<string>,
  entries: TrashRowLike[],
): Set<string> {
  const live = new Set(entries.map((e) => e.path ?? e.path_hash));
  return new Set([...selected].filter((p) => live.has(p)));
}

/** Select-all toggle over the visible rows only; hidden rows keep their state. */
export function toggleAllSelected(
  selected: Set<string>,
  visible: TrashRowLike[],
  check: boolean,
): Set<string> {
  const out = new Set(selected);
  for (const e of visible) {
    const key = e.path ?? e.path_hash;
    if (check) out.add(key);
    else out.delete(key);
  }
  return out;
}

/** Select-all checkbox state: every visible row is selected (and at least one). */
export function allVisibleSelected(
  selected: Set<string>,
  visible: TrashRowLike[],
): boolean {
  if (visible.length === 0) return false;
  return visible.every((e) => selected.has(e.path ?? e.path_hash));
}

/** "2 selected": the toolbar count line ("selected" never pluralizes). */
export function selectionCountLabel(n: number): string {
  return `${n} selected`;
}

/** "Purge selected (2)": the bulk purge button label. */
export function selectedPurgeLabel(n: number): string {
  return `Purge selected (${n})`;
}
