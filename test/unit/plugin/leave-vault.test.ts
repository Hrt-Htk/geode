import { assertEquals, assertNotEquals } from "@std/assert";
import { clearedVaultSettings, DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";
import type { PluginSettings } from "../../../plugin/plumbing/settings-types.ts";

Deno.test("clearedVaultSettings - resets identity fields, preserves prefs, does not mutate input", () => {
  // Build a fully-configured settings with non-default prefs
  const input: PluginSettings = {
    serverUrl: "https://geode.example.com",
    vaultId: "vault-abc123",
    vaultName: "My Vault",
    deviceId: "device-xyz789",
    deviceToken: "tok-000111222",
    salt: "YWJjZGVmZ2hpamtsbW5vcA==",
    verifier: "dmVyaWZpZXItYmFzZTY0",
    argon2Params: { ops: 5, mem: 134217728 },
    unlockTimeoutHours: 5,
    syncedPlugins: ["dataview"],
    trashRetentionDays: 7,
    debugLogging: true,
    syncObsidianConfig: true,
  };

  // Capture original prefs before the call
  const orig = {
    unlockTimeoutHours: input.unlockTimeoutHours,
    syncedPlugins: [...input.syncedPlugins],
    trashRetentionDays: input.trashRetentionDays,
    debugLogging: input.debugLogging,
    syncObsidianConfig: input.syncObsidianConfig,
  };

  const result = clearedVaultSettings(input);

  // 1. Identity fields are blank
  assertEquals(result.serverUrl, "");
  assertEquals(result.vaultId, "");
  assertEquals(result.vaultName, "");
  assertEquals(result.deviceId, "");
  assertEquals(result.deviceToken, "");
  assertEquals(result.salt, "");
  assertEquals(result.verifier, "");

  // 2. argon2Params reset to defaults
  assertEquals(result.argon2Params.ops, DEFAULT_SETTINGS.argon2Params.ops);
  assertEquals(result.argon2Params.mem, DEFAULT_SETTINGS.argon2Params.mem);

  // 3. Non-identity prefs preserved
  assertEquals(result.unlockTimeoutHours, orig.unlockTimeoutHours);
  assertEquals(result.syncedPlugins, orig.syncedPlugins);
  assertEquals(result.trashRetentionDays, orig.trashRetentionDays);
  assertEquals(result.debugLogging, orig.debugLogging);
  assertEquals(result.syncObsidianConfig, orig.syncObsidianConfig);

  // 4. Input NOT mutated (purity)
  assertNotEquals(input.vaultId, "");
  assertNotEquals(input.serverUrl, "");

  // 5. Result is a shallow copy (different object)
  assertNotEquals(result, input);
});
