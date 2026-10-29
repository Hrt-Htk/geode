// User-facing trash copy + formatting (mockup #446/#455). Obsidian-free,
// everything here is unit-testable under deno test. Owner copy rule: plain,
// concise, no hyphens or dashes of any kind.

export function relativeTime(
  epochSeconds: number,
  now = Math.floor(Date.now() / 1000),
): string {
  const diffSec = now - epochSeconds;
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} minutes ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hours ago`;
  return `${Math.floor(diffSec / 86400)} days ago`;
}

export function shortPathHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

export function trashEntryLabel(entry: { path?: string; path_hash: string }): string {
  return entry.path ?? shortPathHash(entry.path_hash);
}

export type TrashCount =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; count: number };

/** Settings Deleted-files row desc (mockup #446): live trash count label. */
export function trashCountLabel(state: TrashCount): string {
  if (state.status === "loading") return "Checking trash…";
  if (state.status === "error") return "Couldn't check the trash";
  if (state.count === 0) return "Trash is empty";
  return `${state.count} ${plural(state.count, "file")} in trash`;
}

/** "Deleted 2 days ago from Phone": the trash-row and preview-footer device line. */
export function deletedFromLabel(
  trashedAt: number,
  deviceName: string,
  now = Math.floor(Date.now() / 1000),
): string {
  return `Deleted ${relativeTime(trashedAt, now)} from ${deviceName}`;
}

/** The device id → name for the "from <device>" suffix; "Another device" when unknown. */
export function deviceNameLabel(
  deviceId: string,
  names?: Map<string, string> | null,
): string {
  const name = names?.get(deviceId);
  return name && name.trim() ? name : "Another device";
}

export type RetentionInfo = { daysLeft: number; expired: boolean };

/** Strict expiry, exactly matching the server's purge-expired cutoff
 * (`trashed_at < floor(now/1000) - retention*86400`). Days left is for the row
 * label: 0 once expired, else at least 1 so it never reads "0 days". */
export function retention(
  trashedAt: number,
  retentionDays: number,
  now = Math.floor(Date.now() / 1000),
): RetentionInfo {
  const elapsedDays = (now - trashedAt) / DAY_SECONDS;
  const expired = now - trashedAt > retentionDays * DAY_SECONDS;
  const daysLeft = expired ? 0 : Math.max(1, Math.ceil(retentionDays - elapsedDays));
  return { daysLeft, expired };
}

const DAY_SECONDS = 86400;

/** "purges in 28 days" (muted) or "expired" (warning colour). */
export function retentionLabel(
  trashedAt: number,
  retentionDays: number,
  now = Math.floor(Date.now() / 1000),
): string {
  const { daysLeft, expired } = retention(trashedAt, retentionDays, now);
  if (expired) return "expired";
  return daysLeft === 1 ? "purges in 1 day" : `purges in ${daysLeft} days`;
}

/** Pinned-toolbar retention safety-net line (mockup #446). */
export function keptLabel(days: number): string {
  return days === 1 ? "Kept 1 day" : `Kept ${days} days`;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${trimZero(mb.toFixed(1))} MB`;
  return `${trimZero((mb / 1024).toFixed(1))} GB`;
}

function trimZero(s: string): string {
  return s.replace(/\.0$/, "");
}

/** Singular for 1, plural with `s` otherwise: the one pluralizer. */
export function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

export type PreviewKind = "text" | "image" | "binary";

/** What a deleted file preview can show: markdown text, an image, or a dead line. */
export function previewKind(path: string, mime: string): PreviewKind {
  if (mime === "text/markdown" || mime === "text/plain") return "text";
  if (mime.startsWith("image/")) return "image";
  // Unknown mime (e.g. a locked-session list): fall back to the path extension.
  if (!mime || mime === "application/octet-stream") {
    const ext = (path.split(".").pop() ?? "").toLowerCase();
    if (ext === "md" || ext === "markdown" || ext === "txt") return "text";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  }
  return "binary";
}

/** Preview size caps: under the cap we fetch and show content, at/over it the line. */
const PREVIEW_MAX_BYTES = { text: 5 * 1024 * 1024, image: 20 * 1024 * 1024 } as const;

/** Whether a preview must fetch content. Binary never fetches; text/image fetch
 * only under their size cap; with no size metadata (locked list) we fetch. */
export function previewFetches(kind: PreviewKind, size: number | undefined): boolean {
  if (kind === "binary") return false;
  if (size === undefined) return true;
  return size <= PREVIEW_MAX_BYTES[kind];
}

/** The binary line's type, from the path extension or the mime subtype. */
export function fileTypeLabel(path: string, mime: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot > 0 ? path.slice(dot + 1) : "";
  if (ext && ext.length <= 6 && /^[a-z0-9]+$/i.test(ext)) return ext.toUpperCase();
  const sub = mime.split("/")[1] ?? "";
  if (sub === "" || sub === "octet-stream") return "File";
  return sub.toUpperCase();
}

/** "PDF · 240 KB · preview not available": middle dots, never dashes. */
export function binaryPreviewLine(path: string, mime: string, size?: number): string {
  const type = fileTypeLabel(path, mime);
  return size === undefined
    ? `${type} · preview not available`
    : `${type} · ${formatBytes(size)} · preview not available`;
}

/** #677: a row inside the server's retention floor is refused for a device token, so the
 * trash modal asks for the admin token before purging it. One protected row is enough
 * for a batch: the same token purges them all. */
export function purgeNeedsAdmin(
  entries: Array<{ trashed_at: number }>,
  serverFloorDays: number | null,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (serverFloorDays === null) return false;
  return entries.some((entry) => !retention(entry.trashed_at, serverFloorDays, now).expired);
}

// Action-result notices (mockup #446). No dashes.
export function restoredNotice(n: number): string {
  return `Geode: restored ${n} ${plural(n, "file")}`;
}

export function restoredOneNotice(label: string): string {
  return `Geode: restored "${label}"`;
}

/** #582: delete forever aborts when the history walk failed: erasing one name while
 * the confirm promised the past versions would be a lie. */
export const PURGE_HISTORY_FAILED = "Could not read this file's history. Nothing was deleted.";

export function purgedExpiredNotice(n: number): string {
  return `Geode: purged ${n} expired ${plural(n, "file")}`;
}

export function purgedOneNotice(label: string): string {
  return `Geode: purged "${label}"`;
}

export function purgedSelectedNotice(n: number): string {
  return `Geode: purged ${n} ${plural(n, "file")}`;
}

/** #677: the admin token prompt for a purge inside the server's retention floor. */
export const IN_FLOOR_PURGE_TITLE = "Admin token required";
export const IN_FLOOR_PURGE_ASK =
  "Purging inside the retention window needs the admin token. Not saved, asked again next session.";
export const IN_FLOOR_PURGE_CANCELLED = "Nothing was deleted. This purge needs the admin token.";
