import { assert } from "@std/assert";

// #59: bytes this device did not type (a download, a merge result, a restore, a conflict
// sibling, a backup copy) must reach the vault only through `recordedWrite`, which records
// the path before the write so a kill mid-write is resolvable at the next start. This guard
// fails when a module writes vault bytes without going through it, which is how a fragment
// could be committed unnoticed.

/** Files allowed to touch the raw vault write helpers. */
const ALLOWED = new Set([
  // The write surface itself, and the helper that records around a write.
  "vault-io.ts",
  // The start pass removes files; it never writes content.
  "interrupted-writes.ts",
  // State files (plugin data) and the desktop rename primitive: not vault content.
  "session.ts",
  "atomic-write.ts",
  "export-writer.ts",
  // The vault adapter shim: conflict-resolve writes through it, recorded there.
  "conflicts-modal-host.ts",
]);

const RAW_WRITE = /writeVaultBinary\(|\.adapter\.writeBinary\(/;

Deno.test("untyped writes - every module that writes vault bytes goes through recordedWrite", async () => {
  const offenders: string[] = [];
  for await (const entry of Deno.readDir("plugin")) {
    if (!entry.isDirectory) continue;
    for await (const file of Deno.readDir(`plugin/${entry.name}`)) {
      if (!file.name.endsWith(".ts") || ALLOWED.has(file.name)) continue;
      const source = await Deno.readTextFile(`plugin/${entry.name}/${file.name}`);
      if (!RAW_WRITE.test(source)) continue;
      const guarded = source.includes("recordedWrite(") ||
        source.includes("import { recordedWrite }") ||
        source.includes("recordedWrite }");
      if (!guarded) offenders.push(`plugin/${entry.name}/${file.name}`);
    }
  }
  assert(
    offenders.length === 0,
    `these write vault bytes without recordedWrite (#59): ${offenders.join(", ")}`,
  );
});
