import {
  type InFlightWrite,
  type LocalFileRow,
  openStateDB,
  type StateDB,
} from "../../plugin/plumbing/state.ts";

/** A StateDB wired as a live session has it (#59): the record of an untyped write can only
 * be made durable through a persist hook, and a write without a record must not happen. Unit
 * tests that apply versions therefore need one, exactly like the plugin. */
export function openSessionStateDB(
  rows?: LocalFileRow[] | null,
  cursor?: number | null,
  lastBackupAt?: number | null,
  record?: InFlightWrite[] | null,
): StateDB {
  const state = openStateDB(rows, cursor, lastBackupAt, record);
  state.setSyncCursorPersist(() => {});
  return state;
}
