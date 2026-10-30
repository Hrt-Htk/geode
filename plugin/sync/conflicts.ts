// #432: conflict file naming. The name embeds the device that made the losing
// edit so both versions are easy to compare in the file list:
// "a (conflict Laptop 2026-10-12 140205).md" (second-granular so two conflicts
// on one path within a minute can't collide). The old ".conflict-<timestamp>"
// form and the earlier minute-only "(conflict … HHMM)" form stay recognized
// and mapped back, because users' disks and servers already hold such files.
// A uniqueness counter inside the marker ("… 140205 2)") disambiguates two
// conflicts generated within the same second.

const OLD_STAMP_RE = /\.conflict-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/;
/** date + HHMM or HHMMSS time + optional uniqueness counter, inside the marker. */
const NEW_NAME_RE = /\(conflict .+? \d{4}-\d{2}-\d{2} \d{4,6}( \d+)?\)/;
const OLD_DETECT = /\.conflict-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(\.[^.]+)?$/;
const NEW_DETECT = /\(conflict .+? \d{4}-\d{2}-\d{2} \d{4,6}( \d+)?\)(\.[^.]+)?$/;
const FORBIDDEN_CHARS = /[/\\:*?"<>|]/g;
/** Device names embeddable in a file name; long names are truncated. */
const MAX_DEVICE_NAME_LEN = 40;

/** The device label embedded in a conflict name: sanitized, blank falls back.
 * Shared by naming and attribution so a name that sanitizes to empty (e.g.
 * "///") embeds and compares the same "This device" label (#432). */
export function conflictDeviceLabel(deviceName: string): string {
  return sanitizeDeviceName(deviceName) || "This device";
}

/** "Notes/a.md" → { stem: "Notes/a", ext: ".md" }; the last dot after the last slash wins. */
export function splitExt(path: string): { stem: string; ext: string } {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot === -1 || dot < slash) return { stem: path, ext: "" };
  return { stem: path.slice(0, dot), ext: path.slice(dot) };
}

/** Strip characters illegal on Windows/Android file systems, trim, and cap. */
export function sanitizeDeviceName(name: string): string {
  return name.replace(FORBIDDEN_CHARS, " ").replace(/\s+/g, " ").trim().slice(
    0,
    MAX_DEVICE_NAME_LEN,
  ).trim();
}

/** "a (conflict Laptop 2026-10-12 140205).md"; the device name is sanitized,
 * blank falls back. `n >= 2` appends the uniqueness counter (two conflicts on
 * one path within the same second). */
export function generateConflictPath(
  originalPath: string,
  deviceName: string,
  ts: Date = new Date(),
  n = 0,
): string {
  const { stem, ext } = splitExt(originalPath);
  const name = conflictDeviceLabel(deviceName);
  const stamp = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())} ` +
    `${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}` +
    (n >= 2 ? ` ${n}` : "");
  return `${stem} (conflict ${name} ${stamp})${ext}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** True for both the new "(conflict …)" form and the old ".conflict-<stamp>" form. */
export function isConflictPath(path: string): boolean {
  return OLD_DETECT.test(path) || NEW_DETECT.test(path);
}

/** Recover the original path from either conflict form; null when not a conflict path. */
export function originalPathOf(conflictPath: string): string | null {
  const m = conflictPath.match(OLD_STAMP_RE) ?? conflictPath.match(NEW_NAME_RE);
  if (!m || m.index === undefined) return null;
  // The new form is "name (conflict …)": the space before the paren is part of
  // the marker and must go too. The old form's leading dot is inside the match.
  const start = conflictPath[m.index - 1] === " " ? m.index - 1 : m.index;
  return conflictPath.slice(0, start) + conflictPath.slice(m.index + m[0].length);
}

/** The creator's device label embedded in a new-form conflict name; null otherwise. */
export function conflictDeviceName(conflictPath: string): string | null {
  const m = conflictPath.match(/\(conflict (.+?) \d{4}-\d{2}-\d{2} \d{4,6}( \d+)?\)/);
  return m ? m[1] : null;
}
