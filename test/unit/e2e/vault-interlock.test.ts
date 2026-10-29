// #535: a destructive test-vault reset must refuse when the vault Obsidian has
// open is not the one GEODE_PHONE_VAULT names. Tests the pure comparison and the
// env-backed guard that every wipe site calls.
import { assertEquals, assertThrows } from "@std/assert";
import { assertTestVault, vaultNameProblem } from "../../e2e/vault-interlock.ts";

Deno.test("vaultNameProblem: the vault GEODE_PHONE_VAULT names passes", () => {
  assertEquals(vaultNameProblem("TestVault", "/storage/emulated/0/Documents/TestVault"), null);
});

Deno.test("vaultNameProblem: another open vault is refused, naming both", () => {
  const problem = vaultNameProblem("Personal", "/storage/emulated/0/Documents/TestVault");
  assertEquals(problem?.includes("GEODE_PHONE_RESET interlock"), true);
  assertEquals(problem?.includes('"Personal"'), true);
  assertEquals(problem?.includes('"TestVault"'), true);
  assertEquals(problem?.includes("refusing to reset"), true);
});

Deno.test("assertTestVault: refuses to reset when GEODE_PHONE_VAULT names another vault", () => {
  const prev = Deno.env.get("GEODE_PHONE_VAULT");
  Deno.env.set("GEODE_PHONE_VAULT", "/storage/emulated/0/Documents/TestVault");
  try {
    assertTestVault("TestVault");
    assertThrows(() => assertTestVault("Personal"), Error, "refusing to reset");
  } finally {
    if (prev === undefined) Deno.env.delete("GEODE_PHONE_VAULT");
    else Deno.env.set("GEODE_PHONE_VAULT", prev);
  }
});
