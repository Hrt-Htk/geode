import { assert, assertEquals } from "@std/assert";
import { massDeleteGuard } from "../../helpers/bytes.ts";
import { ReconcileOp, Reconciler } from "../../../plugin/sync/reconciler.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { blake3Hex } from "../../../core/hash.ts";
import { normalizeMarkdownLineEndings } from "../../../core/normalize.ts";

Deno.test({
  name:
    "line-ending-reconcile - CRLF markdown file does NOT produce modify op when content matches normalized hash",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // CRLF content on disk
    const crlfContent = "line one\r\nline two\r\n";
    const crlfBytes = new TextEncoder().encode(crlfContent);

    // Normalized (LF) content: what commit.ts stores
    const lfContent = normalizeMarkdownLineEndings(crlfContent);
    const lfBytes = new TextEncoder().encode(lfContent);
    const normHash = blake3Hex(lfBytes);

    // Open a StateDB and seed it with the normalized hash/size
    const state = openStateDB();
    const pathHash = blake3Hex(new TextEncoder().encode("note.md"));
    state.upsertLocalFile({
      path: "note.md",
      path_hash: pathHash,
      size: lfBytes.length, // normalized size
      mtime: 1000,
      plaintext_hash: normHash, // normalized hash
      last_seen_version: 1,
      chunk_hashes: [],
    });

    // Fake vault: returns CRLF bytes and a different size
    const captured: ReconcileOp[] = [];
    const fakeVault = {
      getAllLoadedFiles: () => [{ path: "note.md" }],
      adapter: {
        stat: (_path: string) => ({
          size: crlfBytes.length, // RAW size (differs from normalized)
          mtime: 2000, // changed mtime so the gate doesn't trivially skip
        }),
        readBinary: (_path: string) => new Uint8Array(crlfBytes),
      },
    };

    const reconciler = new Reconciler(
      fakeVault as never,
      state,
      (ops) => {
        captured.push(...ops);
      },
      () => true,
      false,
      massDeleteGuard(),
    );

    // start() sets isRunning=true and triggers initial reconcile
    reconciler.start();
    // Give the initial reconcile a tick to complete
    await new Promise((r) => setTimeout(r, 50));
    reconciler.stop();

    // With the fix: no modify op should be captured because the normalized
    // hash matches the stored hash, even though raw bytes are CRLF.
    const modifyOps = captured.filter((op) => op.kind === "modify" && op.path === "note.md");
    assertEquals(
      modifyOps.length,
      0,
      `Expected no modify ops for note.md, but got ${modifyOps.length}: ${
        JSON.stringify(modifyOps)
      }`,
    );

    // Also verify the local row's mtime was updated (hash-match branch updates mtime)
    const row = state.getLocalFile("note.md");
    assert(row !== null, "note.md should still exist in state");
    assertEquals(row.mtime, 2000, "mtime should be updated to current stat mtime");

    state.close();
  },
});

Deno.test({
  name: "line-ending-reconcile - non-markdown file still uses size+mtime gate",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes
    const hash = blake3Hex(content);

    const state = openStateDB();
    const pathHash = blake3Hex(new TextEncoder().encode("image.png"));
    state.upsertLocalFile({
      path: "image.png",
      path_hash: pathHash,
      size: content.length,
      mtime: 1000,
      plaintext_hash: hash,
      last_seen_version: 1,
      chunk_hashes: [],
    });

    const captured: ReconcileOp[] = [];
    const fakeVault = {
      getAllLoadedFiles: () => [{ path: "image.png" }],
      adapter: {
        stat: (_path: string) => ({
          size: content.length,
          mtime: 1000, // same mtime → should skip
        }),
        readBinary: (_path: string) => new Uint8Array(content),
      },
    };

    const reconciler = new Reconciler(
      fakeVault as never,
      state,
      (ops) => {
        captured.push(...ops);
      },
      () => true,
    );

    reconciler.start();
    await new Promise((r) => setTimeout(r, 50));
    reconciler.stop();

    // No ops because size and mtime both match
    assertEquals(captured.length, 0, `Expected no ops, got ${captured.length}`);

    state.close();
  },
});
