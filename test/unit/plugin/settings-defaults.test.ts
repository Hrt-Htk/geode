import { assert, assertEquals } from "@std/assert";
import { clearedVaultSettings, DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";

Deno.test("settings - default argon2 ops >= 3 (MODERATE)", () => {
  assert(
    DEFAULT_SETTINGS.argon2Params.ops >= 3,
    `ops is ${DEFAULT_SETTINGS.argon2Params.ops}, expected >= 3`,
  );
});

Deno.test("settings - default argon2 mem >= 67108864 (64 MiB INTERACTIVE)", () => {
  assert(
    DEFAULT_SETTINGS.argon2Params.mem >= 67108864,
    `mem is ${DEFAULT_SETTINGS.argon2Params.mem}, expected >= 67108864`,
  );
});

Deno.test("settings - default deviceName is empty", () => {
  assertEquals(DEFAULT_SETTINGS.deviceName, "");
});

Deno.test("settings - clearedVaultSettings clears deviceName", () => {
  const s = { ...DEFAULT_SETTINGS, deviceId: "d1", deviceName: "Desktop-Otter" };
  assertEquals(clearedVaultSettings(s).deviceName, "");
});
