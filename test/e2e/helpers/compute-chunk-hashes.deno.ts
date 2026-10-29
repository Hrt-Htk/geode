// #493: compute the per-chunk plaintext hashes a file's content produces, using the real
// core/ chunker + hash (same code path as plugin/sync/commit.ts).
// args: path to a JSON file containing [{ path, content }, ...] → stdout: JSON { path: [hexHash, ...] }
import { chunk } from "../../../core/chunker.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";

const items = JSON.parse(await Deno.readTextFile(Deno.args[0])) as {
  path: string;
  content: string;
}[];
const out: Record<string, string[]> = {};
for (const { path, content } of items) {
  const normalized = normalizeForHash(path, new TextEncoder().encode(content));
  out[path] = [...chunk(normalized)].map((c) => blake3Hex(c));
}
await Deno.stdout.write(new TextEncoder().encode(`${JSON.stringify(out)}\n`));
