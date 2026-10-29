// #675: a vault's *first* auth_hash and its NULL verifier are admin-gated
// writes: the admin token rides x-geode-admin-token while the bearer stays the
// device token. The later (device-only) writes must not send it.
import { assertEquals, assertRejects } from "@std/assert";
import { putVerifier, setHttpImpl } from "../../../plugin/plumbing/provisioning-client.ts";
import { putVaultAuth } from "../../../plugin/plumbing/rekey-client.ts";

type Captured = { url: string; method: string; headers: Record<string, string>; body?: string };

const ADMIN = "admin-secret";
const DEVICE_TOKEN = "device-token";

function capture(status = 200): () => Captured {
  let captured: Captured | null = null;
  setHttpImpl((req) => {
    captured = req;
    return Promise.resolve({ status, text: '{"ok":true}' });
  });
  return () => {
    if (!captured) throw new Error("no request captured");
    return captured;
  };
}

Deno.test("putVaultAuth - sends the admin token in x-geode-admin-token, bearer stays the device token", async () => {
  const last = capture();
  await putVaultAuth("https://geode.example.com", "vault-1", DEVICE_TOKEN, "ab".repeat(32), ADMIN);
  const req = last();
  assertEquals(req.method, "PUT");
  assertEquals(req.url, "https://geode.example.com/vaults/vault-1/auth");
  assertEquals(req.headers["Authorization"], `Bearer ${DEVICE_TOKEN}`);
  assertEquals(req.headers["x-geode-admin-token"], ADMIN);
});

Deno.test("putVaultAuth - an unlock re-registration sends no admin header", async () => {
  const last = capture();
  await putVaultAuth("https://geode.example.com", "vault-1", DEVICE_TOKEN, "ab".repeat(32));
  assertEquals(last().headers["x-geode-admin-token"], undefined);
});

Deno.test("putVaultAuth - a refused registration carries the HTTP status", async () => {
  capture(403);
  const error = await assertRejects(
    () => putVaultAuth("https://geode.example.com", "vault-1", DEVICE_TOKEN, "ab".repeat(32)),
  );
  assertEquals((error as { status?: number }).status, 403);
});

Deno.test("putVerifier - a first (NULL) verifier carries the admin token", async () => {
  const last = capture();
  await putVerifier(
    "https://geode.example.com",
    "vault-1",
    DEVICE_TOKEN,
    "verifier-b64",
    undefined,
    ADMIN,
  );
  const req = last();
  assertEquals(req.headers["Authorization"], `Bearer ${DEVICE_TOKEN}`);
  assertEquals(req.headers["x-geode-admin-token"], ADMIN);
});

Deno.test("putVerifier - the params backfill on a set verifier stays device-only", async () => {
  const last = capture();
  await putVerifier("https://geode.example.com", "vault-1", DEVICE_TOKEN, "verifier-b64", {
    ops: 2,
    mem: 16 * 1024 * 1024,
  });
  const req = last();
  assertEquals(req.headers["x-geode-admin-token"], undefined);
  assertEquals(JSON.parse(req.body ?? "{}").argon2_ops, 2);
});
