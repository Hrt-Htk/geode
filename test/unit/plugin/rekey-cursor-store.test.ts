import { assertEquals } from "@std/assert";
import {
  makeRekeyCursorStore,
  readRekeyCursor,
} from "../../../plugin/plumbing/rekey-cursor-store.ts";
import type { RekeyCursor } from "../../../plugin/sync/rekey-run.ts";

const cursor: RekeyCursor = {
  kind: "change",
  mode: "copy",
  ops: 3,
  mem: 64 * 1024 * 1024,
  phase: "blobs",
  blobs_done: 42,
};

Deno.test("cursor store: save writes JSON, load returns it, clear writes null", () => {
  const written: string[] = [];
  const store = makeRekeyCursorStore(
    (bytes) => written.push(new TextDecoder().decode(bytes)),
    null,
  );
  assertEquals(store.load(), null);
  store.save(cursor);
  assertEquals(store.load(), cursor);
  assertEquals(JSON.parse(written[0]), cursor);
  store.clear();
  assertEquals(store.load(), null);
  assertEquals(written[1], "null");
});

Deno.test("readRekeyCursor: valid, null, corrupt, and wrong-shape files", async () => {
  const read = (content: string | null) => () =>
    Promise.resolve(new TextEncoder().encode(content ?? ""));
  assertEquals(await readRekeyCursor(read(JSON.stringify(cursor)), "p"), cursor);
  assertEquals(await readRekeyCursor(read("null"), "p"), null);
  assertEquals(await readRekeyCursor(read("{not json"), "p"), null);
  assertEquals(await readRekeyCursor(read(null), "p"), null);
  assertEquals(
    await readRekeyCursor(
      read(
        JSON.stringify({
          kind: "bogus",
          mode: "copy",
          ops: 1,
          mem: 1,
          phase: "blobs",
          blobs_done: 0,
        }),
      ),
      "p",
    ),
    null,
  );
  assertEquals(
    await readRekeyCursor(
      read(JSON.stringify({ mode: "copy", ops: 1, mem: 1, phase: "blobs", blobs_done: 0 })),
      "p",
    ),
    null,
  );
  assertEquals(
    await readRekeyCursor(
      read(JSON.stringify({ mode: "copy", ops: 1, mem: 1, phase: "bogus", blobs_done: 0 })),
      "p",
    ),
    null,
  );
});
