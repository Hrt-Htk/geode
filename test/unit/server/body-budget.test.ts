// #680 - the per-route body caps bound one request; Deno.serve has no concurrency
// limit, so a device token could keep many 4 MiB blob POSTs (or one 46 MB re-key row
// batch each) in flight at once and hold that memory in the single process.
// readCappedBody reserves the body's cap from a process-wide budget and answers 503
// for a body that would pass it, instead of queueing behind a stalled upload.
import { MAX_INFLIGHT_BODY_BYTES, readCappedBody, readJson } from "../../../server/http-helpers.ts";
import { MAX_BLOB_SIZE } from "../../../server/blobs.ts";
import { MAX_REKEY_ROWS_BODY } from "../../../server/ws-commit.ts";
import { assert, assertEquals } from "@std/assert";

interface Held {
  pending: Promise<Uint8Array | Response>;
  release: () => void;
}

const SLOTS = Math.floor(MAX_INFLIGHT_BODY_BYTES / MAX_BLOB_SIZE);

// A body that streams past its cap, and one whose stream fails mid-read: both exit
// readCappedBody before the read completes, and both must give their reservation back.
function overCapBody(): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(64));
      c.close();
    },
  });
  return new Request("http://localhost/blobs", { method: "POST", body: stream });
}

function failingBody(): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(8));
      c.error(new Error("connection reset"));
    },
  });
  return new Request("http://localhost/blobs", { method: "POST", body: stream });
}

// A body that declares `bytes` and then never delivers them: the read holds its
// reservation until `release`.
function heldBody(bytes: number): Held {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const req = new Request("http://localhost/blobs", {
    method: "POST",
    body: stream,
    headers: { "content-length": String(bytes) },
  });
  return {
    pending: readCappedBody(req, bytes) as Promise<Uint8Array | Response>,
    release: () => controller.close(),
  };
}

Deno.test({
  name: "body budget - a body past the remaining budget is refused with 503, not queued",
  async fn() {
    const slots = Math.floor(MAX_INFLIGHT_BODY_BYTES / MAX_BLOB_SIZE);
    const held: Held[] = [];
    try {
      for (let i = 0; i < slots; i++) held.push(heldBody(MAX_BLOB_SIZE));

      const refused = await readCappedBody(
        new Request("http://localhost/blobs", {
          method: "POST",
          body: new Uint8Array(16),
          headers: { "content-length": "16" },
        }),
        MAX_BLOB_SIZE,
      );
      assertEquals(refused instanceof Response, true, "budget must refuse while it is full");
      assertEquals((refused as Response).status, 503);
      assertEquals(
        (refused as Response).headers.get("retry-after"),
        "1",
        "a busy refusal tells the client when to come back",
      );
    } finally {
      for (const h of held) h.release();
      await Promise.all(held.map((h) => h.pending));
    }
  },
});

Deno.test({
  name: "body budget - a small body still fits once nothing else is reading",
  async fn() {
    const ok = await readJson<{ name?: string }>(
      new Request("http://localhost/vaults", {
        method: "POST",
        body: JSON.stringify({ name: "v" }),
        headers: { "content-type": "application/json" },
      }),
    );
    assertEquals(ok instanceof Response, false);
    assertEquals((ok as { name?: string }).name, "v");
  },
});

// The one cap derived from other caps: if a MAX_CHUNK_HASHES bump pushed the re-key rows
// batch past the whole budget, every POST …/rekey/rows would be a permanent 503 and no
// other test would say why (#680 review).
Deno.test("body budget - the re-key rows cap stays under the budget with room for blobs", () => {
  assert(
    MAX_REKEY_ROWS_BODY < MAX_INFLIGHT_BODY_BYTES,
    `the rows cap (${MAX_REKEY_ROWS_BODY}) must fit the budget (${MAX_INFLIGHT_BODY_BYTES})`,
  );
  assert(
    MAX_INFLIGHT_BODY_BYTES - MAX_REKEY_ROWS_BODY >= 4 * MAX_BLOB_SIZE,
    "one rows batch must leave room for four concurrent blob POSTs",
  );
});

// A reservation that leaked on a 413 or a broken stream would shrink the budget for the
// life of the process: every later body read would slowly start answering 503, with a
// restart as the only fix. So the failure paths are what this pins.
Deno.test("body budget - a 413 and a stream that fails mid-read both release their slot", async () => {
  for (let i = 0; i < 40; i++) {
    const refused = await readCappedBody(overCapBody(), 128);
    assert(refused instanceof Response && refused.status === 413, "an over-cap read answers 413");
  }
  let rejected = 0;
  try {
    await readCappedBody(failingBody(), MAX_BLOB_SIZE);
  } catch {
    rejected++;
  }
  assertEquals(rejected, 1, "a stream that fails mid-read rejects instead of succeeding");

  const held: Held[] = [];
  try {
    for (let i = 0; i < SLOTS; i++) held.push(heldBody(MAX_BLOB_SIZE));
    // Exactly SLOTS reads are in flight, so the next one is still refused: the budget
    // is whole, not merely non-empty.
    const refused = await readCappedBody(
      new Request("http://localhost/blobs", { method: "POST", body: new Uint8Array(4) }),
      MAX_BLOB_SIZE,
    );
    assert(
      refused instanceof Response && refused.status === 503,
      "the budget is intact after the failures",
    );
  } finally {
    for (const h of held) h.release();
    await Promise.allSettled(held.map((h) => h.pending));
  }
});
