import { assertEquals } from "@std/assert";
import { reconcileVaultName } from "../../../plugin/sync/vault-name-heal.ts";

Deno.test("reconcileVaultName - received non-empty differing name wins (server is source of truth)", () => {
  assertEquals(reconcileVaultName("old-name", "new-name"), "new-name");
  assertEquals(reconcileVaultName("", "server-name"), "server-name");
});

Deno.test("reconcileVaultName - received equals current → null (no change)", () => {
  assertEquals(reconcileVaultName("same", "same"), null);
});

Deno.test("reconcileVaultName - empty received → null (don't wipe a good local name)", () => {
  assertEquals(reconcileVaultName("my-vault", ""), null);
});

Deno.test("reconcileVaultName - undefined received (old protocol/absent) → null", () => {
  assertEquals(reconcileVaultName("my-vault", undefined), null);
});
