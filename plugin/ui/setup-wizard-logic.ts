import { formatUserError } from "../plumbing/errors.ts";

// Obsidian-free setup-wizard logic (#441, #459): step machine, create-form
// validation, encryption-strength → argon2 params (#457), and error mapping.
// Copy rule: plain, no hyphens or dashes.

export type EncryptionLevel = "lower" | "standard" | "higher";

// The argon2 params a new vault is created with per level. Standard is the
// default and equals NEW_VAULT_ARGON2_PARAMS. Numbers from
// docs/crypto/encryption-chunking.md (#457 bench): Lower 3/64 MiB, Standard
// 3/256 MiB, Higher 4/512 MiB.
export const ENCRYPTION_PARAMS: Record<EncryptionLevel, { ops: number; mem: number }> = {
  lower: { ops: 3, mem: 64 * 1024 * 1024 },
  standard: { ops: 3, mem: 256 * 1024 * 1024 },
  higher: { ops: 4, mem: 512 * 1024 * 1024 },
};

export const STRENGTH_OPTIONS: Record<EncryptionLevel, string> = {
  lower: "Lower",
  standard: "Standard (default)",
  higher: "Higher",
};

export const STRENGTH_DETAIL: Record<EncryptionLevel, string> = {
  lower: "3 passes, 64 MB. Fastest on phones.",
  standard: "3 passes, 256 MB",
  higher: "4 passes, 512 MB. May fail on older phones.",
};

export const STRENGTH_NOTE = "Applies to every device on this vault.";

export type WizardStep =
  | "choose"
  | "create-server"
  | "create-vault"
  | "join-server"
  | "join-vault"
  | "done";
export type WizardFlow = "create" | "join";

export function wizardTitle(flow: WizardFlow | null): string {
  if (flow === "create") return "Create new Geode vault";
  if (flow === "join") return "Join existing Geode vault";
  return "Set up Geode";
}

export function backStep(step: WizardStep): WizardStep | null {
  switch (step) {
    case "create-server":
      return "choose";
    case "create-vault":
      return "create-server";
    case "join-server":
      return "choose";
    case "join-vault":
      return "join-server";
    default:
      return null;
  }
}

export function validateCreateForm(values: {
  vaultName: string;
  passphrase: string;
  confirm: string;
}): string | null {
  if (!values.vaultName.trim()) return "Enter a vault name.";
  if (values.passphrase !== values.confirm) return "Passphrases don't match.";
  if (values.passphrase.length < 12) return "Passphrase is too short.";
  return null;
}

export type ServerCheckError = "unreachable" | "invalid-token" | "server-error";

export function classifyServerError(error: unknown): ServerCheckError {
  const msg = error instanceof Error ? error.message : String(error);
  const match = /failed:\s*(\d+)/.exec(msg);
  if (match) {
    const status = Number(match[1]);
    if (status === 401 || status === 403) return "invalid-token";
    if (status >= 500) return "server-error";
    return "unreachable";
  }
  return "unreachable";
}

export function serverErrorText(kind: ServerCheckError, host: string): string {
  if (kind === "invalid-token") return "That admin token isn't valid.";
  if (kind === "server-error") return "Server error. Try again later.";
  return `Couldn't reach the server at ${host}.`;
}

export function mapJoinError(error: unknown, host: string): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg === "incorrect passphrase") return "That passphrase doesn't match this vault.";
  const match = /failed:\s*(\d+)/.exec(msg);
  if (!match || match[1] === "0") return `Couldn't reach the server at ${host}.`;
  return formatUserError(error);
}

// #701: a join that lands on an old copy of this vault: say so before it runs, and
// report where the differing files went afterwards. Plain, one line, no dashes (#479).
export function rejoinWarningText(): string {
  return "Joining keeps the server version. Files that differ go to Geode backup.";
}

export function rejoinFailedNotice(): string {
  return "Geode: the join did not finish and sync is paused. Join again, or leave the vault and rejoin.";
}

export function rejoinResultText(count: number, folder: string): string {
  return `Kept ${count} ${count === 1 ? "file" : "files"} in ${folder}.`;
}
