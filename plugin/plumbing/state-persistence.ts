import type { LocalFileRow, StateDB } from "./state.ts";

export interface StatePaths {
  localFiles: string;
  cursor: string;
}

export interface PersistedState {
  persisted: LocalFileRow[] | null;
  persistedCursor: number | null;
  lastBackupAt: number;
}

type ReadFn = (path: string) => Promise<ArrayBuffer | Uint8Array>;
type WriteFn = (path: string, bytes: Uint8Array) => void;

function readJsonFile<T>(read: ReadFn, path: string): Promise<T | null> {
  return (async (): Promise<T | null> => {
    const raw = await read(path);
    const text = new TextDecoder().decode(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
    return JSON.parse(text) as T;
  })().catch(() => null);
}

function parseLastBackupAt(cursorObj: { last_backup_at?: unknown } | null): number {
  const v = cursorObj?.last_backup_at;
  return typeof v === "number" ? v : 0;
}

export async function loadPersistedState(
  read: ReadFn,
  paths: StatePaths,
): Promise<PersistedState> {
  const [localFiles, cursorObj] = await Promise.all([
    readJsonFile<LocalFileRow[]>(read, paths.localFiles),
    readJsonFile<{ last_seen_seq?: unknown; last_backup_at?: unknown } | null>(read, paths.cursor),
  ]);

  const persistedCursor: number | null =
    cursorObj?.last_seen_seq !== undefined && typeof cursorObj.last_seen_seq === "number"
      ? cursorObj.last_seen_seq
      : null;

  return {
    persisted: localFiles,
    persistedCursor,
    lastBackupAt: parseLastBackupAt(cursorObj),
  };
}

/** Read just the last-backup stamp from the cursor file (plain JSON): for
 *  showing it before the vault is unlocked, when StateDB doesn't exist yet. */
export async function readLastBackupAt(read: ReadFn, cursorPath: string): Promise<number> {
  return parseLastBackupAt(
    await readJsonFile<{ last_backup_at?: unknown } | null>(read, cursorPath),
  );
}

export function wireStatePersistence(
  state: StateDB,
  write: WriteFn,
  paths: StatePaths,
): void {
  state.setPersist((json) => write(paths.localFiles, new TextEncoder().encode(json)));
  state.setSyncCursorPersist((json) => write(paths.cursor, new TextEncoder().encode(json)));
}
