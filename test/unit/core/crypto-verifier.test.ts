import { checkVerifier, deriveKeys, makeVerifier } from "../../../core/crypto.ts";
import { assertEquals } from "@std/assert";

const TEST_SALT = new Uint8Array(16).fill(0x42);

Deno.test({
  name: "crypto-verifier - makeVerifier + checkVerifier roundtrip with correct key",
  async fn() {
    const keys = await deriveKeys("right", TEST_SALT);
    const verifier = await makeVerifier(keys);
    const ok = await checkVerifier(keys, verifier);
    assertEquals(ok, true);
  },
});

Deno.test({
  name: "crypto-verifier - checkVerifier returns false with wrong passphrase",
  async fn() {
    const rightKeys = await deriveKeys("right", TEST_SALT);
    const verifier = await makeVerifier(rightKeys);
    const wrongKeys = await deriveKeys("wrong", TEST_SALT);
    const ok = await checkVerifier(wrongKeys, verifier);
    assertEquals(ok, false);
  },
});

Deno.test({
  name: "crypto-verifier - checkVerifier returns false for too-short blob",
  async fn() {
    const keys = await deriveKeys("right", TEST_SALT);
    const ok = await checkVerifier(keys, new Uint8Array(10));
    assertEquals(ok, false);
  },
});
