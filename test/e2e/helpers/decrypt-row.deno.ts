// #561: decrypt a re-keyed version row (or trash head) with a passphrase, using
// the real core/ crypto (same code path as the plugin). Proves the row and its
// blobs are readable under the NEW keys after a re-key.
// args: path to a JSON file containing
//   { dataDir, vaultId, passphrase, saltB64, ops, mem,
//     pathHash, encMetadata, pathCiphertext?, chunkHashes: string[], expected? }
// → stdout: JSON { path, bytes, matches? } (matches = decrypted chunks reassemble
// the expected content, markdown-normalized like the chunker sees it).
import { decryptChunk, decryptMetadata, decryptPath, deriveKeys } from "../../../core/crypto.ts";
import { b64decode } from "../../../core/protocol.ts";
import { normalizeForHash } from "../../../core/normalize.ts";

const input = JSON.parse(await Deno.readTextFile(Deno.args[0])) as {
  dataDir: string;
  vaultId: string;
  passphrase: string;
  saltB64: string;
  ops: number;
  mem: number;
  pathHash: string;
  encMetadata: string;
  pathCiphertext?: string | null;
  chunkHashes: string[];
  expected?: string;
};

const keys = await deriveKeys(input.passphrase, b64decode(input.saltB64), {
  opsLimit: input.ops,
  memLimit: input.mem,
});

const meta = await decryptMetadata(b64decode(input.encMetadata), keys, input.pathHash);
let pathCiphertext: string | null = null;
if (input.pathCiphertext) {
  pathCiphertext = await decryptPath(b64decode(input.pathCiphertext), keys, input.pathHash);
}

const parts: Uint8Array[] = [];
let bytes = 0;
for (const hash of input.chunkHashes) {
  const blobPath = `${input.dataDir}/blobs/${input.vaultId}/${hash.slice(0, 2)}/${hash.slice(2)}`;
  const ct = await Deno.readFile(blobPath);
  parts.push(await decryptChunk(ct, keys, hash));
  bytes += ct.length;
}
const total = parts.reduce((n, p) => n + p.length, 0);
const all = new Uint8Array(total);
let offset = 0;
for (const p of parts) {
  all.set(p, offset);
  offset += p.length;
}
const content = new TextDecoder().decode(all);

const out: { path: string; pathCiphertext: string | null; bytes: number; matches?: boolean } = {
  path: meta.path,
  pathCiphertext,
  bytes,
};
if (input.expected !== undefined) {
  const expected = new TextDecoder().decode(
    normalizeForHash(meta.path, new TextEncoder().encode(input.expected)),
  );
  out.matches = content === expected;
}
await Deno.stdout.write(new TextEncoder().encode(`${JSON.stringify(out)}\n`));
