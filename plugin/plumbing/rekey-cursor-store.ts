// #559: the re-key resume cursor as a JSON file in the plugin data dir,
// written through the device-gated state writer (#181). runRekey throttles the
// saves; this store only moves bytes and keeps the in-memory copy.
import type { RekeyCursor, RekeyCursorStore } from "../sync/rekey-run.ts";

export async function readRekeyCursor(
  read: (path: string) => Promise<ArrayBuffer | Uint8Array>,
  path: string,
): Promise<RekeyCursor | null> {
  let parsed: unknown;
  try {
    const raw = await read(path);
    const text = new TextDecoder().decode(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const c = parsed as Partial<RekeyCursor>;
  if (c.kind !== "change" && c.kind !== "rekey") return null;
  if (c.mode !== "copy" && c.mode !== "replace") return null;
  if (c.phase !== "blobs" && c.phase !== "rows" && c.phase !== "done") return null;
  if (typeof c.blobs_done !== "number" || typeof c.ops !== "number" || typeof c.mem !== "number") {
    return null;
  }
  return c as RekeyCursor;
}

export function makeRekeyCursorStore(
  write: (bytes: Uint8Array) => void,
  initial: RekeyCursor | null,
): RekeyCursorStore {
  let current: RekeyCursor | null = initial;
  return {
    load: () => current,
    save: (cursor) => {
      current = cursor;
      write(new TextEncoder().encode(JSON.stringify(cursor)));
    },
    clear: () => {
      current = null;
      write(new TextEncoder().encode("null"));
    },
  };
}
