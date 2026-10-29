import { assert, assertEquals } from "@std/assert";
import { createRequire } from "node:module";
import { LIBSODIUM_WASM_BASE64 } from "../../../plugin/_generated/libsodium-wasm-base64.ts";
import { b64decode } from "../../../core/protocol.ts";

Deno.test("inlined libsodium WASM is a valid WebAssembly module", async () => {
  const bytes = b64decode(LIBSODIUM_WASM_BASE64);
  assertEquals([bytes[0], bytes[1], bytes[2], bytes[3]], [0x00, 0x61, 0x73, 0x6d]);
  const mod = await WebAssembly.compile(bytes as unknown as ArrayBuffer);
  assert(mod instanceof WebAssembly.Module);
});

Deno.test("patched libsodium-sumo instantiates from the inlined binary without fetching", async () => {
  const g = globalThis as Record<string, unknown>;
  g.__GEODE_LIBSODIUM_WASM__ = b64decode(LIBSODIUM_WASM_BASE64);
  const origFetch = g.fetch;
  let fetchCalls = 0;
  g.fetch = () => {
    fetchCalls++;
    return Promise.reject(new Error("fetch blocked in renderer test"));
  };
  try {
    const require = createRequire(import.meta.url);
    // deno-lint-ignore no-explicit-any
    const sodium = require("../../../plugin/_generated/libsodium-sumo-patched.cjs") as any;
    await sodium.ready;
    assertEquals(fetchCalls, 0);
    assertEquals(sodium._crypto_secretbox_keybytes(), 32);
  } finally {
    g.fetch = origFetch;
    delete g.__GEODE_LIBSODIUM_WASM__;
  }
});
