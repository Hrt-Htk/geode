export type StorageState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "data"; total: number; free: number; used: number; vault_used?: number };

export type StorageLevel = "normal" | "warning" | "error" | "loading" | "unavailable";

export interface StorageDescription {
  text: string;
  level: StorageLevel;
  /** Meter segment widths: this vault's share of the disk, then the rest of the used space. */
  vaultPct: number | null;
  otherPct: number | null;
}

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const KB = 1024;
const WARNING_FREE_FRACTION = 0.1;
const WARNING_FREE_FLOOR = 5 * GB;
const MIN_VAULT_PCT = 2;

function fmtBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1).replace(/\.0$/, "")} GB`;
  if (n >= MB) return `${Math.round(n / MB)} MB`;
  return `${Math.round(n / KB)} KB`;
}

function pctOf(part: number, total: number): number {
  return Math.min(100, Math.max(0, Math.round((part / total) * 100)));
}

export function describeStorage(state: StorageState): StorageDescription {
  if (state.kind === "loading") {
    return { text: "Checking storage…", level: "loading", vaultPct: 0, otherPct: 0 };
  }
  if (state.kind === "unavailable") {
    return {
      text: "Storage info unavailable. The server didn't answer.",
      level: "unavailable",
      vaultPct: null,
      otherPct: null,
    };
  }
  const vault = state.vault_used ?? 0;
  // Keep a small vault's slice visible on the meter.
  const vaultPct = vault > 0 ? Math.max(MIN_VAULT_PCT, pctOf(vault, state.total)) : 0;
  const otherPct = pctOf(state.used - vault, state.total);
  // Older servers don't send vault_used: keep the disk-level texts.
  const known = state.vault_used !== undefined;
  const prefix = known ? `This vault ${fmtBytes(vault)} · ` : "";
  if (state.free === 0) {
    const text = known
      ? `${prefix}Server full, uploads paused`
      : "Server storage is full. Uploads resume when space frees up.";
    return { text, level: "error", vaultPct, otherPct };
  }
  if (state.free < state.total * WARNING_FREE_FRACTION || state.free < WARNING_FREE_FLOOR) {
    return {
      text: `${prefix}Low on server space. ${fmtBytes(state.free)} free.`,
      level: "warning",
      vaultPct,
      otherPct,
    };
  }
  const usedText = known ? `This vault ${fmtBytes(vault)}` : `${fmtBytes(state.used)} used`;
  return {
    text: `${usedText} · ${fmtBytes(state.free)} free`,
    level: "normal",
    vaultPct,
    otherPct,
  };
}
