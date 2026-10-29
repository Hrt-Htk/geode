import {
  MASS_DELETE_MIN_FILES,
  MASS_DELETE_MIN_PERCENT,
  type MassDeleteGuard,
} from "../../plugin/sync/mass-delete-hold.ts";

/** Check byte-for-byte equality of two Uint8Arrays. */
export function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** #601: the reconciler's mass-delete guard, for tests that are not about the guard. */
export function massDeleteGuard(
  onHold: MassDeleteGuard["onHold"] = () => {},
  thresholds: { minFiles: number; minPercent: number } = {
    minFiles: MASS_DELETE_MIN_FILES,
    minPercent: MASS_DELETE_MIN_PERCENT,
  },
): MassDeleteGuard {
  return { thresholds: () => thresholds, onHold };
}
