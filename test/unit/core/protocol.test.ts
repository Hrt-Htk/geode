import { assertEquals } from "@std/assert";
import { b64decode, b64encode } from "../../../core/protocol.ts";

Deno.test("protocol - b64encode/b64decode round-trip a 1 MiB array", () => {
  const bytes = new Uint8Array(1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  assertEquals(b64decode(b64encode(bytes)), bytes);
});

Deno.test("protocol - b64encode emits standard padded base64", () => {
  assertEquals(b64encode(new Uint8Array([0xfb, 0xff])), "+/8=");
});
