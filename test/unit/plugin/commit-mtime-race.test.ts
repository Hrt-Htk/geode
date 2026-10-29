import { assertEquals } from "@std/assert";
import { blake3Hex } from "../../../core/hash.ts";
import { deriveKeys } from "../../../core/crypto.ts";
import { commitOp } from "../../../plugin/sync/commit.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";

// #630 review: the row a commit's ack writes must describe the bytes it hashed. Reading
// the body and THEN statting lets a writer outside the path lock (an apply's version
// write, a conflict-resolution executor, a history restore) land in between: the row
// keeps hash A with B's mtime, the reconciler's mtime fast path skips forever, and the
// device keeps a version its peers do not. Stat first: a writer that lands after the
// stat leaves row.mtime < disk.mtime, which the reconciler re-reads (drift).

const PATH = "notes.md";
const A = "head\nA\nbody\n";
const B = "head\nB\nbody\n";
const A_MTIME = 1_000;
const B_MTIME = 2_000;

Deno.test("a commit records the mtime of the bytes it hashed, not of a write that landed after them", async () => {
  const keys = await deriveKeys("test", new Uint8Array(16), { opsLimit: 1, memLimit: 8192 });
  const state = openStateDB();
  // The disk starts holding A; reading it is the moment the concurrent writer lands
  // (exactly the window between the commit's read and its stat).
  let content = A;
  let mtime = A_MTIME;
  const vault = {
    adapter: {
      stat: () => ({ size: content.length, mtime }),
      readBinary: () => {
        const body = content;
        content = B;
        mtime = B_MTIME;
        return new TextEncoder().encode(body);
      },
      writeBinary: async () => {},
      remove: async () => {},
    },
  };
  const transport = {
    headBlob: () => true,
    putBlob: async () => {},
    commit: () => ({ kind: "ack", version: 1 }),
  };

  const ok = await commitOp({ kind: "commit", path: PATH }, {
    vault: vault as never,
    state,
    keys,
    transport: transport as never,
    onConflict: () => {},
    pendingRenameTarget: () => undefined,
  } as never);

  assertEquals(ok, true, "the commit is acked");
  const row = state.getLocalFile(PATH)!;
  assertEquals(
    row.plaintext_hash,
    blake3Hex(new TextEncoder().encode(A)),
    "row hash = committed bytes",
  );
  assertEquals(row.mtime, A_MTIME, "row mtime = the mtime of the bytes the row describes");
  assertEquals(
    mtime,
    B_MTIME,
    "the later write kept its own mtime, so the reconciler sees the drift",
  );
  state.close();
});
