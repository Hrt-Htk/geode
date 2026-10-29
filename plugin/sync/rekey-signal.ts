// #560: the re-key signal in server_hello_ack, decided obsidian-free.
// rekey flag → pause; verifier hash mismatch → passphrase changed elsewhere;
// match (or no local verifier) → normal. The device that ran the re-key
// already stores the new verifier, so its hash matches.
import { blake3Hex } from "../../core/hash.ts";
import { b64decode } from "../../core/protocol.ts";

export type HelloRekeyDecision = "ok" | "rekey-in-progress" | "passphrase-changed";

export function localVerifierHash(verifierB64: string): string | null {
  if (!verifierB64) return null;
  return blake3Hex(b64decode(verifierB64));
}

export function helloRekeyDecision(
  ack: { rekey?: boolean; verifier_hash?: string },
  verifierB64: string,
): HelloRekeyDecision {
  if (ack.rekey) return "rekey-in-progress";
  const local = localVerifierHash(verifierB64);
  if (ack.verifier_hash && local !== null && ack.verifier_hash !== local) {
    return "passphrase-changed";
  }
  return "ok";
}
