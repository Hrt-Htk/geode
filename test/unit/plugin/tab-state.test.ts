import { assertEquals } from "@std/assert";
import {
  NOT_SET_UP_SETUP_DESC,
  NOT_SET_UP_SETUP_NAME,
  NOT_SET_UP_STATUS_TEXT,
  tabStateOf,
  tabVisibility,
} from "../../../plugin/ui/tab-state.ts";

Deno.test("tab-state - tabStateOf maps config+unlock to locked/unlocked/notset", () => {
  assertEquals(tabStateOf(false, false), "notset");
  assertEquals(tabStateOf(false, true), "notset");
  assertEquals(tabStateOf(true, false), "locked");
  assertEquals(tabStateOf(true, true), "unlocked");
});

Deno.test("tab-state - tabVisibility per state", () => {
  assertEquals(tabVisibility("notset"), {
    sections: ["status"],
    statusRows: [],
    vaultRows: [],
  });
  assertEquals(tabVisibility("locked"), {
    sections: ["status", "vault"],
    statusRows: ["status"],
    vaultRows: ["vault-name"],
  });
  assertEquals(tabVisibility("unlocked"), {
    sections: ["status", "vault", "devices", "scope", "trash", "advanced", "logs"],
    statusRows: ["status", "storage", "actions"],
    // #559: the passphrase row is unlocked-only: rekeying needs the keys.
    vaultRows: ["vault-name", "vault-lock", "autolock", "passphrase"],
  });
});

// #64: reading the logs must not need a setting first: the Logs page is a page of the unlocked
// tab, whoever the vault is and whatever Debug logging says. Locked and not-set-up keep it out.
Deno.test("tab-state - the Logs page shows while unlocked, without any setting", () => {
  assertEquals(tabVisibility("unlocked").sections.includes("logs"), true);
  assertEquals(tabVisibility("locked").sections.includes("logs"), false);
  assertEquals(tabVisibility("notset").sections.includes("logs"), false);
});

Deno.test("tab-state - not-set-up copy", () => {
  assertEquals(NOT_SET_UP_STATUS_TEXT, "Not set up. No vault connected on this device.");
  assertEquals(NOT_SET_UP_SETUP_NAME, "Set up");
  assertEquals(NOT_SET_UP_SETUP_DESC, "Connect this device to a Geode vault.");
});
