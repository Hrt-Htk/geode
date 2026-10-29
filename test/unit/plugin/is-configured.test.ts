import { assertEquals } from "@std/assert";
import { DEFAULT_SETTINGS, isConfigured } from "../../../plugin/plumbing/settings-types.ts";

Deno.test("settings - isConfigured false when identity fields empty", () => {
  assertEquals(isConfigured(DEFAULT_SETTINGS), false);
});

Deno.test("settings - isConfigured true only when all three identity fields set", () => {
  const base = { ...DEFAULT_SETTINGS, serverUrl: "https://s", vaultId: "v", deviceToken: "t" };
  assertEquals(isConfigured(base), true);
  assertEquals(isConfigured({ ...base, deviceToken: "" }), false);
  assertEquals(isConfigured({ ...base, vaultId: "" }), false);
  assertEquals(isConfigured({ ...base, serverUrl: "" }), false);
});
