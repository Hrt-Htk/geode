export type PluginRow = { id: string; name: string; checked: boolean };

export function computePluginRows(
  manifests: Record<string, { id: string; name: string }>,
  syncedPlugins: string[],
  selfId: string,
): PluginRow[] {
  const rows: PluginRow[] = [];
  for (const [, manifest] of Object.entries(manifests)) {
    if (manifest.id === selfId) continue;
    rows.push({
      id: manifest.id,
      name: manifest.name,
      checked: syncedPlugins.includes(manifest.id),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return rows;
}

export function togglePlugin(syncedPlugins: string[], id: string, on: boolean): string[] {
  const next = [...syncedPlugins];
  if (on) {
    if (!next.includes(id)) next.push(id);
  } else {
    const idx = next.indexOf(id);
    if (idx !== -1) next.splice(idx, 1);
  }
  return next;
}
