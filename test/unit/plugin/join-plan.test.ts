import { assertEquals } from "@std/assert";
import { isRejoin } from "../../../plugin/sync/join-plan.ts";

// #701: the detection rule: a join is a rejoin when this device was already joined to
// the same vault AND its old state is still there (rows, or a cursor above zero). Every
// other join is a first join, and a first join into a folder of unrelated notes keeps
// uploading them.

const VAULT = "vault-a";

function plan(previousVaultId: string, rowCount: number, cursor: number): boolean {
  return isRejoin({ previousVaultId, vaultId: VAULT, rowCount, cursor });
}

Deno.test("join-plan - a device with no vault is a first join", () => {
  assertEquals(plan("", 0, 0), false);
  assertEquals(plan("", 40, 900), false);
});

Deno.test("join-plan - joining another vault is a first join for that vault", () => {
  assertEquals(plan("vault-b", 40, 900), false);
  assertEquals(plan("vault-b", 0, 0), false);
});

Deno.test("join-plan - the same vault with no old state is a first join", () => {
  assertEquals(plan(VAULT, 0, 0), false);
});

Deno.test("join-plan - the same vault with rows is a rejoin", () => {
  assertEquals(plan(VAULT, 1, 0), true);
  assertEquals(plan(VAULT, 40, 900), true);
});

Deno.test("join-plan - the same vault with a cursor above zero is a rejoin", () => {
  assertEquals(plan(VAULT, 0, 8266), true);
});

Deno.test("join-plan - the row table and the cursor fail independently", () => {
  // The reported device: local-files.json lost, sync-cursor.json survived
  // (test/unit/plugin/state-persistence.test.ts pins that split).
  assertEquals(plan(VAULT, 0, 8266), true);
  assertEquals(plan(VAULT, 40, 0), true);
});
