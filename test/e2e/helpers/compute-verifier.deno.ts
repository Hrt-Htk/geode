import { deriveKeys, makeVerifier } from "../../../core/crypto.ts";
import { b64decode, b64encode } from "../../../core/protocol.ts";

// args: <passphrase> <saltB64> <ops> <mem>
const [passphrase, saltB64, opsStr, memStr] = Deno.args;
const salt = b64decode(saltB64);
const keys = await deriveKeys(passphrase, salt, {
  opsLimit: Number(opsStr),
  memLimit: Number(memStr),
});
const verifier = await makeVerifier(keys);
console.log(b64encode(verifier));
