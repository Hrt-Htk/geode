import { assertEquals } from "@std/assert";
import { toArrayBuffer } from "../../../plugin/plumbing/bytes.ts";

Deno.test("bytes - toArrayBuffer copies the exact bytes of a full view", () => {
  const src = new Uint8Array([1, 2, 3, 4]);
  const ab = toArrayBuffer(src);
  assertEquals(new Uint8Array(ab), new Uint8Array([1, 2, 3, 4]));
});

Deno.test("bytes - toArrayBuffer respects byteOffset (subarray)", () => {
  const backing = new Uint8Array([0, 9, 9, 9, 9, 9, 1, 2, 3]);
  const view = backing.subarray(6, 9);
  assertEquals(new Uint8Array(toArrayBuffer(view)), new Uint8Array([1, 2, 3]));
});
