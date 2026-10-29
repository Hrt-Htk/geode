// #560: the re-key signal in server_hello_ack, decided obsidian-free:
// rekey flag → pause; verifier hash mismatch → passphrase changed elsewhere;
// match (or no local verifier) → normal.
import { assertEquals } from "@std/assert";
import { deriveKeys, makeVerifier } from "../../../core/crypto.ts";
import { b64encode } from "../../../core/protocol.ts";
import { helloRekeyDecision, localVerifierHash } from "../../../plugin/sync/rekey-signal.ts";

const FAST = { opsLimit: 1, memLimit: 8192 };

Deno.test("rekey-signal - the rekey flag pauses sync, hash irrelevant", () => {
  const verifierB64 = b64encode(new Uint8Array([1, 2, 3]));
  assertEquals(
    helloRekeyDecision({ rekey: true, verifier_hash: "abc" }, verifierB64),
    "rekey-in-progress",
  );
  assertEquals(helloRekeyDecision({ rekey: true }, ""), "rekey-in-progress");
});

Deno.test("rekey-signal - a foreign verifier hash means the passphrase changed elsewhere", async () => {
  const keys = await deriveKeys("pass", new Uint8Array(16), FAST);
  const verifierB64 = b64encode(await makeVerifier(keys));
  assertEquals(
    helloRekeyDecision({ verifier_hash: "deadbeef" }, verifierB64),
    "passphrase-changed",
  );
});

Deno.test("rekey-signal - a matching verifier hash is normal (the re-keying device)", async () => {
  const keys = await deriveKeys("pass", new Uint8Array(16), FAST);
  const verifierB64 = b64encode(await makeVerifier(keys));
  assertEquals(
    helloRekeyDecision({ verifier_hash: localVerifierHash(verifierB64) }, verifierB64),
    "ok",
  );
});

Deno.test("rekey-signal - no local verifier never reports a change", () => {
  assertEquals(helloRekeyDecision({ verifier_hash: "deadbeef" }, ""), "ok");
  assertEquals(helloRekeyDecision({}, ""), "ok");
});
