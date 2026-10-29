// #460: user-facing copy for the confirm dialog and rename-vault modal.
// Owner copy rule: one line, plain, no hyphens or dashes of any kind, no
// reassurance fluff.
import { plural, retention } from "./trash-format.ts";

export function validateVaultName(raw: string):
  | { ok: true; name: string }
  | { ok: false; error: string } {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, error: "Enter a vault name." };
  if (name.length > 64) return { ok: false, error: "Use 64 characters or fewer." };
  return { ok: true, name };
}

export type ConfirmDialogSpec = {
  title: string;
  message: string;
  confirmText: string;
};

export function confirmLeaveVault(vaultName: string): ConfirmDialogSpec {
  return {
    title: `Leave ${vaultName}?`,
    message: "Disconnects this device and clears its local sync state. Your notes stay.",
    confirmText: "Leave vault",
  };
}

export function confirmResyncFromScratch(): ConfirmDialogSpec {
  return {
    title: "Resync from scratch?",
    message: "Rebuilds this device's sync state from the server.",
    confirmText: "Resync",
  };
}

export function confirmPurgeFile(label: string): ConfirmDialogSpec {
  return {
    title: "Purge file?",
    message: `"${label}" and its past versions are permanently deleted from the server.`,
    confirmText: "Purge",
  };
}

export function confirmPurgeExpired(count: number): ConfirmDialogSpec {
  return {
    title: "Purge expired files?",
    message: `Permanently deletes ${count} ${
      plural(count, "file")
    } past the retention period and the versions kept for ${count === 1 ? "it" : "them"}.`,
    confirmText: `Purge ${count} ${plural(count, "file")}`,
  };
}

export function confirmPurgeSelected(count: number): ConfirmDialogSpec {
  return {
    title: "Purge selected files?",
    message: `Permanently deletes ${count} selected ${plural(count, "file")} and ${
      count === 1 ? "its" : "their"
    } past versions.`,
    confirmText: `Purge ${count} ${plural(count, "file")}`,
  };
}

export function confirmNewVaultFromNotes(): ConfirmDialogSpec {
  return {
    title: "Start a new vault from your notes?",
    message: "Your notes on this device stay. The server copy is lost.",
    confirmText: "Start new vault",
  };
}

// #432: Keep mine / Keep theirs delete the other version, so they confirm.
export function confirmKeepVersion(keepDevice: string, dropDevice: string): ConfirmDialogSpec {
  return {
    title: `Keep ${keepDevice}'s version?`,
    message: `Deletes the ${dropDevice} version. This can't be undone.`,
    confirmText: `Keep ${keepDevice}'s version`,
  };
}

export function confirmRevokeDevice(deviceName: string): ConfirmDialogSpec {
  return {
    title: "Revoke device?",
    message: `"${deviceName}" loses access to this vault.`,
    confirmText: "Revoke",
  };
}

/** #465: a restore is non-destructive, so its confirm is not warning styled. */
export function confirmRestoreVersion(): ConfirmDialogSpec {
  return {
    title: "Restore this version?",
    message: "The current content stays in history as a version.",
    confirmText: "Restore",
  };
}

/** Trash entries past the retention period, derived from retention() so the row
 * label, the confirm count and the server's purge-expired all agree. */
export function countExpiredTrash(
  entries: { trashed_at: number }[],
  retentionDays: number,
): number {
  const now = Math.floor(Date.now() / 1000);
  return entries.filter((entry) => retention(entry.trashed_at, retentionDays, now).expired).length;
}
