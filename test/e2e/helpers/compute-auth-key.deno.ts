import { deriveAuthKey, deriveKeys } from "../../../core/crypto.ts";
import { toHex } from "../../../core/hash.ts";
import { b64decode } from "../../../core/protocol.ts";

// args: <passphrase> <saltB64> <ops> <mem>
const [passphrase, saltB64, opsStr, memStr] = Deno.args;
const keys = await deriveKeys(passphrase, b64decode(saltB64), {
  opsLimit: Number(opsStr),
  memLimit: Number(memStr),
});
console.log(toHex(deriveAuthKey(keys)));
