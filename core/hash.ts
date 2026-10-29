import { blake3 } from "@noble/hashes/blake3";

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function blake3Hex(data: Uint8Array): string {
  return toHex(blake3(data));
}

export function blake3Keyed(key: Uint8Array, data: Uint8Array): Uint8Array {
  const h = blake3.create({ key });
  h.update(data);
  return h.digest();
}

export function blake3KeyedHex(key: Uint8Array, data: Uint8Array): string {
  return toHex(blake3Keyed(key, data));
}

export function hashPathHex(macKey: Uint8Array, path: string): string {
  return blake3KeyedHex(macKey, new TextEncoder().encode(path));
}
