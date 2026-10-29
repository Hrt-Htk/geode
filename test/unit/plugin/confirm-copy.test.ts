import { assertEquals } from "@std/assert";
import {
  confirmKeepVersion,
  confirmLeaveVault,
  confirmPurgeExpired,
  confirmPurgeFile,
  confirmPurgeSelected,
  confirmResyncFromScratch,
  confirmRevokeDevice,
  countExpiredTrash,
  validateVaultName,
} from "../../../plugin/ui/confirm-copy.ts";

// #460: confirm-dialog + rename copy (owner rule: one line, no dashes, no fluff).

Deno.test("validateVaultName - trims and accepts", () => {
  assertEquals(validateVaultName("  My Vault "), { ok: true, name: "My Vault" });
});

Deno.test("validateVaultName - rejects empty and whitespace", () => {
  assertEquals(validateVaultName(""), { ok: false, error: "Enter a vault name." });
  assertEquals(validateVaultName("   "), { ok: false, error: "Enter a vault name." });
});

Deno.test("validateVaultName - rejects over 64 chars, accepts exactly 64", () => {
  assertEquals(validateVaultName("x".repeat(65)), {
    ok: false,
    error: "Use 64 characters or fewer.",
  });
  assertEquals(validateVaultName("x".repeat(64)), { ok: true, name: "x".repeat(64) });
});

Deno.test("confirmLeaveVault names the vault in the title", () => {
  assertEquals(confirmLeaveVault("Test Vault"), {
    title: "Leave Test Vault?",
    message: "Disconnects this device and clears its local sync state. Your notes stay.",
    confirmText: "Leave vault",
  });
});

Deno.test("confirmResyncFromScratch copy", () => {
  assertEquals(confirmResyncFromScratch(), {
    title: "Resync from scratch?",
    message: "Rebuilds this device's sync state from the server.",
    confirmText: "Resync",
  });
});

Deno.test("confirmPurgeFile names the file and its history (#582)", () => {
  assertEquals(confirmPurgeFile("Daily/2026-10-01.md"), {
    title: "Purge file?",
    message: '"Daily/2026-10-01.md" and its past versions are permanently deleted from the server.',
    confirmText: "Purge",
  });
});

Deno.test("confirmPurgeExpired names the count and the versions (#582)", () => {
  assertEquals(confirmPurgeExpired(2), {
    title: "Purge expired files?",
    message:
      "Permanently deletes 2 files past the retention period and the versions kept for them.",
    confirmText: "Purge 2 files",
  });
  assertEquals(confirmPurgeExpired(1), {
    title: "Purge expired files?",
    message: "Permanently deletes 1 file past the retention period and the versions kept for it.",
    confirmText: "Purge 1 file",
  });
});

Deno.test("confirmRevokeDevice names the device", () => {
  assertEquals(confirmRevokeDevice("Phone"), {
    title: "Revoke device?",
    message: '"Phone" loses access to this vault.',
    confirmText: "Revoke",
  });
});

Deno.test("confirmKeepVersion names the dropped side in one line", () => {
  assertEquals(confirmKeepVersion("Phone", "This laptop"), {
    title: "Keep Phone's version?",
    message: "Deletes the This laptop version. This can't be undone.",
    confirmText: "Keep Phone's version",
  });
});

Deno.test("countExpiredTrash counts only past-retention entries", () => {
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  const entries = [
    { trashed_at: now - 2 * DAY },
    { trashed_at: now - 31 * DAY },
    { trashed_at: now - 100 * DAY },
  ];
  assertEquals(countExpiredTrash(entries, 30), 2);
  assertEquals(countExpiredTrash([], 30), 0);
});

Deno.test("countExpiredTrash - strict boundary, matches the server purge-expired", () => {
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;
  // At exactly the cutoff the server keeps the entry (trashed_at < cutoff is strict),
  // so the confirm count agrees with the row label and the server.
  assertEquals(countExpiredTrash([{ trashed_at: now - 30 * DAY }], 30), 0);
  assertEquals(countExpiredTrash([{ trashed_at: now - 30 * DAY - 1 }], 30), 1);
});

Deno.test("confirmPurgeSelected names the selected count (singular/plural)", () => {
  assertEquals(confirmPurgeSelected(1), {
    title: "Purge selected files?",
    message: "Permanently deletes 1 selected file and its past versions.",
    confirmText: "Purge 1 file",
  });
  assertEquals(confirmPurgeSelected(3), {
    title: "Purge selected files?",
    message: "Permanently deletes 3 selected files and their past versions.",
    confirmText: "Purge 3 files",
  });
});
