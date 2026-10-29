import { assertEquals } from "@std/assert";
import { DEFAULT_SETTINGS, withVaultIdentity } from "../../../plugin/plumbing/settings-types.ts";
import { rejoinAction } from "../../../plugin/sync/rebuild-flow.ts";

// #701: two rules keep the incomplete rejoin marker from outliving the rejoin it belongs
// to: a new vault identity drops it, and every session start asks one tested function what
// to do with it.

Deno.test("vault-identity - a new identity drops an incomplete rejoin marker", () => {
  const settings = { ...DEFAULT_SETTINGS, vaultId: "vault-a", rejoinIncomplete: true };
  const next = withVaultIdentity(settings, {
    vaultId: "vault-b",
    deviceId: "device-b",
    deviceToken: "token-b",
  });
  assertEquals(next.vaultId, "vault-b");
  assertEquals(next.deviceId, "device-b");
  assertEquals(next.rejoinIncomplete, false, "a marker belongs to the vault it was set on");
  // Everything else is preserved.
  assertEquals(next.unlockTimeoutHours, settings.unlockTimeoutHours);
  assertEquals(next.excludedFolders, settings.excludedFolders);
});

Deno.test("vault-identity - a marker free settings change keeps the rest", () => {
  const settings = { ...DEFAULT_SETTINGS, vaultId: "vault-a" };
  const next = withVaultIdentity(settings, { deviceName: "renamed" });
  assertEquals(next.vaultName, settings.vaultName);
  assertEquals(next.rejoinIncomplete, false);
});

Deno.test("vault-identity - a new identity lifts the pause a failed rejoin left", () => {
  const paused = { ...DEFAULT_SETTINGS, vaultId: "vault-a", rejoinIncomplete: true, pauseAt: 1234 };
  assertEquals(withVaultIdentity(paused, { vaultId: "vault-a" }).pauseAt, 0);
});

Deno.test("vault-identity - a new identity keeps a pause the user chose", () => {
  const paused = { ...DEFAULT_SETTINGS, vaultId: "vault-a", pauseAt: 1234 };
  assertEquals(withVaultIdentity(paused, { vaultId: "vault-a" }).pauseAt, 1234);
});

Deno.test("vault-identity - the decision a session start makes", () => {
  assertEquals(rejoinAction({ ...DEFAULT_SETTINGS, rejoinIncomplete: false }), "normal");
  assertEquals(rejoinAction({ ...DEFAULT_SETTINGS, rejoinIncomplete: true }), "rejoin");
});
