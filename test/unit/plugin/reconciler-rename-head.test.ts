import { assert, assertEquals } from "@std/assert";
import { massDeleteGuard } from "../../helpers/bytes.ts";
import { type ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB, type StateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { RENAME_MARKER } from "../../../core/protocol.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { normalizeForHash } from "../../../core/normalize.ts";

// #583 PR 3: the server's head decides whether a vanished tracked name is a delete at
// all: a marker means the name was renamed away (never a delete), an unreachable head
// means the move cannot be verified (fall back to the plain delete, never to a lost one).

function hashOf(path: string, body: string): string {
  return blake3Hex(normalizeForHash(path, new TextEncoder().encode(body)));
}

function seed(vault: FakeVault, state: StateDB, path: string, body: string): void {
  state.upsertLocalFile({
    path,
    path_hash: `${path}_hash`,
    size: body.length,
    mtime: vault.mtimes.get(path) ?? Date.now(),
    plaintext_hash: hashOf(path, body),
    last_seen_version: 1,
    chunk_hashes: [],
    deleted: false,
  });
}

function removeSilently(vault: FakeVault, path: string): void {
  vault.files.delete(path);
  vault.mtimes.delete(path);
}

type Head = { rename_mark?: number } | null;

/** One reconcile pass (the constructor's own start-up pass), captured from onOps. */
async function reconcile(
  vault: FakeVault,
  state: StateDB,
  renameHead?: (pathHash: string) => Promise<Head>,
  pendingRenameTarget?: (path: string) => string | undefined,
): Promise<ReconcileOp[]> {
  const ran = Promise.withResolvers<ReconcileOp[]>();
  const reconciler = new Reconciler(
    vault as never,
    state,
    (ops) => ran.resolve(ops),
    (path) => !path.startsWith("/"),
    false,
    massDeleteGuard((held, total) =>
      ran.reject(new Error(`mass-delete guard tripped: ${held.length} of ${total}`))
    ),
    ".obsidian",
    renameHead,
    pendingRenameTarget,
  );
  reconciler.start();
  try {
    return await ran.promise;
  } finally {
    reconciler.stop();
  }
}

Deno.test("reconciler never deletes a name whose server head is already a rename marker", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    vault.write("a.md", "body");
    seed(vault, state, "a.md", "body");
    removeSilently(vault, "a.md");

    const asked: string[] = [];
    const ops = await reconcile(vault, state, (pathHash) => {
      asked.push(pathHash);
      return Promise.resolve({ rename_mark: RENAME_MARKER });
    });

    assertEquals(asked, ["a.md_hash"], "the tracked name's head was asked about");
    assertEquals(ops, [], "a renamed-away name is not a delete: the move is already recorded");
  } finally {
    state.close();
  }
});

Deno.test("reconciler falls back to delete + create when the tracked row is stale", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    // Tracked as "before the edit"; the file then took an edit and moved while the app
    // was closed, so the two sides cannot share a hash and pairing would be a guess.
    vault.write("a.md", "before the edit");
    seed(vault, state, "a.md", "before the edit");
    removeSilently(vault, "a.md");
    vault.write("b.md", "edited, then moved");

    const ops = await reconcile(vault, state, () => Promise.resolve(null));

    assertEquals(
      ops.map((op) => `${op.kind}:${op.path}`).sort(),
      ["create:b.md", "delete:a.md"],
      "an unmatched hash stays a plain delete and a plain create",
    );
    assertEquals(
      new TextDecoder().decode(vault.files.get("b.md")),
      "edited, then moved",
      "the edited content is still what the create commits",
    );
  } finally {
    state.close();
  }
});

Deno.test("reconciler emits the plain delete when the head cannot be fetched (offline)", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    vault.write("a.md", "body");
    seed(vault, state, "a.md", "body");
    removeSilently(vault, "a.md");

    const ops = await reconcile(vault, state, () => {
      throw new Error("offline");
    });

    assertEquals(
      ops.map((op) => `${op.kind}:${op.path}`),
      ["delete:a.md"],
      "an unreachable head never withholds the delete",
    );
  } finally {
    state.close();
  }
});

Deno.test("reconciler bounds the head lookups a delete pass issues", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    // Enough live files that the batch stays under the mass-delete ratio, so the pass
    // actually emits ops instead of holding them.
    for (let i = 0; i < 80; i++) {
      vault.write(`live${i}.md`, `live ${i}`);
      seed(vault, state, `live${i}.md`, `live ${i}`);
    }
    const paths = Array.from({ length: 20 }, (_, i) => `d${i}.md`);
    for (const path of paths) {
      vault.write(path, `body of ${path}`);
      seed(vault, state, path, `body of ${path}`);
      removeSilently(vault, path);
    }

    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    await reconcile(vault, state, async () => {
      calls++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return null;
    });

    assertEquals(calls, paths.length, "every candidate is still verified");
    assert(peak <= 8, `head lookups must stay bounded, saw ${peak} in flight`);
    assert(peak > 1, `head lookups must not be serial, saw ${peak} in flight`);
  } finally {
    state.close();
  }
});

Deno.test("reconciler pairs a rename onto a name whose row already closed (#583 reused name)", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    // The source closed its row by moving away earlier; the destination name was used
    // and closed before too (a reused name), and a file is back on it now.
    vault.write("a.md", "body");
    seed(vault, state, "a.md", "body");
    removeSilently(vault, "a.md");
    vault.write("b.md", "body");
    seed(vault, state, "b.md", "body");
    state.closeLocalRow("b.md", "b.md_hash", 7);

    const ops = await reconcile(vault, state, () => Promise.resolve(null));

    assertEquals(
      ops.map((op) => `${op.kind}:${op.path}`),
      ["delete:a.md", "create:b.md"],
      "the move onto the closed name still pairs: marker and note are both written",
    );
    assert(ops[0].renamedTo === "b.md" && ops[1].renamedFrom === "a.md", "one rename link");
    assertEquals(ops[0].renameId, ops[1].renameId, "both ops carry the same rename id");
  } finally {
    state.close();
  }
});

Deno.test("reconciler commits a re-created name as a create, not a modify", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    vault.write("back.md", "new content");
    seed(vault, state, "back.md", "old content");
    state.closeLocalRow("back.md", "back.md_hash", 3);

    const ops = await reconcile(vault, state, () => Promise.resolve(null));

    assertEquals(
      ops.map((op) => `${op.kind}:${op.path}`),
      ["create:back.md"],
      "a closed row with a file back on it is a new generation",
    );
  } finally {
    state.close();
  }
});

Deno.test("reconciler leaves a rename the event layer already holds to it", async () => {
  const vault = new FakeVault();
  const state = openStateDB();
  try {
    // The user renamed X.md to Y.md with the app open: the event layer queued the
    // marker and the note. A reconcile pass that runs before they land must not pair
    // the same move again: that writes a second marker for one rename.
    vault.write("X.md", "body");
    seed(vault, state, "X.md", "body");
    removeSilently(vault, "X.md");
    vault.write("Y.md", "body");

    const ops = await reconcile(
      vault,
      state,
      () => Promise.resolve(null),
      (path) => path === "X.md" ? "Y.md" : undefined,
    );

    assertEquals(
      ops.filter((op) => op.kind === "delete"),
      [],
      "no second marker: the queued rename owns this move",
    );
  } finally {
    state.close();
  }
});
