import { blake3Hex, blake3Keyed, blake3KeyedHex } from "../../../core/hash.ts";
import { assertEquals, assertNotEquals } from "@std/assert";

Deno.test({
  name: "hash - blake3Hex matches known vector for empty input",
  fn() {
    const hash = blake3Hex(new Uint8Array(0));
    assertEquals(hash, "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");
    assertEquals(hash.length, 64);
  },
});

Deno.test({
  name: "hash - blake3Hex matches known vector for 'hello'",
  fn() {
    const data = new TextEncoder().encode("hello");
    const hash = blake3Hex(data);
    assertEquals(hash, "ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f");
    assertEquals(hash.length, 64);
  },
});

Deno.test({
  name: "hash - blake3KeyedHex differs from unkeyed",
  fn() {
    const data = new TextEncoder().encode("test");
    const unkeyed = blake3Hex(data);
    const key = new Uint8Array(32).fill(0x42);
    const keyed = blake3KeyedHex(key, data);
    assertNotEquals(keyed, unkeyed);
  },
});

Deno.test({
  name: "hash - blake3KeyedHex with different keys produces different outputs",
  fn() {
    const data = new TextEncoder().encode("keyed test");
    const keyA = new Uint8Array(32).fill(0xaa);
    const keyB = new Uint8Array(32).fill(0xbb);
    const outA = blake3KeyedHex(keyA, data);
    const outB = blake3KeyedHex(keyB, data);
    assertNotEquals(outA, outB);
  },
});

Deno.test({
  name: "hash - blake3Keyed returns 32 bytes",
  fn() {
    const data = new TextEncoder().encode("test");
    const key = new Uint8Array(32).fill(0x42);
    const result = blake3Keyed(key, data);
    assertEquals(result.length, 32);
  },
});
