/** Which settings-tab sections/rows show per vault state: obsidian-free (deno-testable). */

export type TabState = "locked" | "unlocked" | "notset";

export type SectionId = "status" | "vault" | "devices" | "scope" | "trash" | "advanced";
export type StatusRowId = "status" | "storage" | "actions";
export type VaultRowId = "vault-name" | "vault-lock" | "autolock" | "passphrase";

export function tabStateOf(configured: boolean, unlocked: boolean): TabState {
  if (!configured) return "notset";
  return unlocked ? "unlocked" : "locked";
}

export type TabVisibility = {
  sections: SectionId[];
  statusRows: StatusRowId[];
  vaultRows: VaultRowId[];
};

export const NOT_SET_UP_STATUS_TEXT = "Not set up. No vault connected on this device.";
export const NOT_SET_UP_SETUP_NAME = "Set up";
// One line on desktop (the full sentence wraps); the short line keeps the CTA row tidy.
export const NOT_SET_UP_SETUP_DESC = "Connect this device to a Geode vault.";

/** Rows for notset are built by renderNotSetUp, not this map. */
export function tabVisibility(state: TabState): TabVisibility {
  switch (state) {
    case "notset":
      return { sections: ["status"], statusRows: [], vaultRows: [] };
    case "locked":
      return { sections: ["status", "vault"], statusRows: ["status"], vaultRows: ["vault-name"] };
    case "unlocked":
      return {
        sections: ["status", "vault", "devices", "scope", "trash", "advanced"],
        statusRows: ["status", "storage", "actions"],
        vaultRows: ["vault-name", "vault-lock", "autolock", "passphrase"],
      };
  }
}
