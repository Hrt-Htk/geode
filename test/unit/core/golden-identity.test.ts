// Golden/characterization vectors for the identity-hash pipeline. These pin the
// CURRENT (pre-refactor) byte-identical outputs so that any change to chunking,
// nonce derivation, hashing, or ciphertext framing breaks loudly instead of
// silently orphaning vaults. Values were captured from the original code on a
// varied corpus; do NOT update them to "match" a refactor: a mismatch means the
// refactor changed an output and must be reverted.
import { blake3Hex, blake3Keyed, hashPathHex } from "../../../core/hash.ts";
import { deriveKeys, encryptChunk } from "../../../core/crypto.ts";
import { normalizeForHash } from "../../../core/normalize.ts";
import { assertEquals } from "@std/assert";

const enc = (s: string) => new TextEncoder().encode(s);

type Sample = {
  path: string;
  bytes: Uint8Array;
  pathHash: string;
  idHash: string;
  nonce: string;
  sealed: string;
};
const SAMPLES: Sample[] = [
  {
    path: "a.md",
    bytes: enc("line1\r\nline2"),
    pathHash: "9ba38b54254caeca5323a676b0ad5ec840ea18d99dca4b7f81f839d354d3106a",
    idHash: "75ff054629febace1bcc5ba116da64209302d21755e5f3dd8117200869ef3ebe",
    nonce: "57b20333c8f332e1ed26523e3993c563bbf834f5934984bf",
    sealed:
      "57b20333c8f332e1ed26523e3993c563bbf834f5934984bf6dcfb414bab1b8e065b66b0e03c73786b0a712c29433c4a8b1389a",
  },
  {
    path: "a.md",
    bytes: enc("line1\nline2"),
    pathHash: "9ba38b54254caeca5323a676b0ad5ec840ea18d99dca4b7f81f839d354d3106a",
    idHash: "75ff054629febace1bcc5ba116da64209302d21755e5f3dd8117200869ef3ebe",
    nonce: "57b20333c8f332e1ed26523e3993c563bbf834f5934984bf",
    sealed:
      "57b20333c8f332e1ed26523e3993c563bbf834f5934984bf6dcfb414bab1b8e065b66b0e03c73786b0a712c29433c4a8b1389a",
  },
  {
    path: "a.md",
    bytes: enc("a\r\nb\rc\nd"),
    pathHash: "9ba38b54254caeca5323a676b0ad5ec840ea18d99dca4b7f81f839d354d3106a",
    idHash: "d963a9af09d5f453f99f92cfc46fb4619537a11542fd0e2552536e73749a0280",
    nonce: "48a28863e8afcb791586823d5d6492dd47fd7893c692b821",
    sealed:
      "48a28863e8afcb791586823d5d6492dd47fd7893c692b8214401809670eea2b27fe779441c160b9871e435491f0c67",
  },
  {
    path: "a.md",
    bytes: enc("\uFEFFhello"),
    pathHash: "9ba38b54254caeca5323a676b0ad5ec840ea18d99dca4b7f81f839d354d3106a",
    idHash: "ea8f163db38682925e4491c5e58d4bb3506ef8c14eb78a86e908c5624a67200f",
    nonce: "05b78433b158734c4968882dbe80db663694667015ef0a65",
    sealed:
      "05b78433b158734c4968882dbe80db663694667015ef0a65a3e9a38bea17d2081cf55d0a6e5739f73b66d5e18c",
  },
  {
    path: "a.md",
    bytes: enc("hello  \nworld  "),
    pathHash: "9ba38b54254caeca5323a676b0ad5ec840ea18d99dca4b7f81f839d354d3106a",
    idHash: "d45bbbad9064578069efec51f42d49953686eb76d5366891818b25157c2ad342",
    nonce: "94814b0791c7946aec0916697f0e906db8b60439f04fec0f",
    sealed:
      "94814b0791c7946aec0916697f0e906db8b60439f04fec0f1e9431028d67ea2a1154542c40218373fcb580f025e80b74d2b2a7edfb72ad",
  },
  {
    path: "café.md",
    bytes: enc("café"),
    pathHash: "5609d0a4f075a5e15ba239527c337e82f6928756681a8bdd72c4ad38a8d0a402",
    idHash: "e4e52b2a0ab9d8584bf4b913af316d96865f92f305b17a0d50b6677bd9ec71c0",
    nonce: "793044d8fdf02e534f40f432f8def539d64891c2b3181f77",
    sealed:
      "793044d8fdf02e534f40f432f8def539d64891c2b3181f774af1ed4b3b11dad7c3363f888b3f0cb0da01388682",
  },
  {
    path: "cafe\u0301.md",
    bytes: enc("cafe\u0301"),
    pathHash: "ab6819dc1b3975e3a05fafd3d9c49adc42e174c60a18da1fb787ac1296caa02e",
    idHash: "9dd851dd5eb006a97b799121ac8c2d4f72f7100c7e134a747d893e41371a3806",
    nonce: "147895b0525f8ff93c2f13da0038090e66ad1ae2eb60f18d",
    sealed:
      "147895b0525f8ff93c2f13da0038090e66ad1ae2eb60f18d61d9f50af085c09d813e956765ccb9e870ba26489930",
  },
  {
    path: "binary.dat",
    bytes: new Uint8Array([0, 1, 2, 255, 128, 64, 0]),
    pathHash: "7f2115c3d4fb8cb422477cdebbcac8941e85b5d5b3950a40bd1eeed47787676d",
    idHash: "b1ba3e6c22c92141358554fb93640b816689f41da304da90dba2b448a930c015",
    nonce: "17f6594513a20bc5402e1fdc11eb61f7fc181c2d4ae17351",
    sealed:
      "17f6594513a20bc5402e1fdc11eb61f7fc181c2d4ae173511b8d5d19c9ec32a718431ece79199eba183ca027495ae9",
  },
  {
    path: "My Notes/note one.md",
    bytes: enc("x"),
    pathHash: "8cab9125f78afe307542606d2750613297a531faf94955caf426d486b1121644",
    idHash: "3ae7d805f6789a6402acb70ad4096a85a56bf6804eaf25c0493ac697548d30b5",
    nonce: "56bb565c1be480da090c5bb3822e0d9297916c8bc8126471",
    sealed: "56bb565c1be480da090c5bb3822e0d9297916c8bc812647193350dab898ec693d5b402328587246187",
  },
  {
    path: "文件夹/笔记.md",
    bytes: enc("内容"),
    pathHash: "7aaa93b7a2820fb200f382e208e8f70c40dbceeaa64603dc1d3536343e6bc9f6",
    idHash: "a50fcd88538d7e8185d6f19b2a529bb76826949a8d72e5fda73909d23272f6aa",
    nonce: "e1add40c89b1cbffa61614a2760e8f19d14043fd4faeb34f",
    sealed:
      "e1add40c89b1cbffa61614a2760e8f19d14043fd4faeb34fd2bb1fbaa8774ab9c5f37c6c9102eab32d06c4cc203f",
  },
  {
    path: "Note.MD",
    bytes: enc("case"),
    pathHash: "caf3624da8c46249b18d48e2de8806d343641b705c4299aec6d1ee9c5d32d948",
    idHash: "f354e74c49d40914422e7be9b1e30a7f9df1cfe6b6ba786642b3e30e98b1f540",
    nonce: "5e3ba6cc45d5e889c8b19a1fe68b89bda05429cef064e3f5",
    sealed:
      "5e3ba6cc45d5e889c8b19a1fe68b89bda05429cef064e3f50bfc8c1c25e299f6c6d1b198ad95d9f07cf4bc3a",
  },
  {
    path: "x.markdown",
    bytes: enc("markdown ext"),
    pathHash: "dcb1768ed33dfa3b0d8d00284766afd3aedb4d681db22d86f685d29db8511191",
    idHash: "c74d4812942751853e2a302d1603ceac40f45e2afe6e5e530305eddec5a20e18",
    nonce: "42d885358425926e5543d441d674064c5cfb2995e640c55a",
    sealed:
      "42d885358425926e5543d441d674064c5cfb2995e640c55a9eaa2309a0bd0358f9c5e47ea0bf8af53d7dc25ec2b44ffcbcb11d76",
  },
  {
    path: "notes.txt",
    bytes: enc("plain\r\ntext"),
    pathHash: "9134fa54039dba78fdb49983ae3585722b403df8cb4202c3aa41951e985e358a",
    idHash: "2b6daa4685996696723a8b60be152c2c3fb89b8a01264f3f00cb7af6da89e678",
    nonce: "934728415152c49c58e0322958d4e9ddeec5468c6afda658",
    sealed:
      "934728415152c49c58e0322958d4e9ddeec5468c6afda65848987e91ff75155b5fe26a90d543cc932e93546c3ab505969d5175",
  },
];

const salt = enc("golden-salt-16b!");
const keys = await deriveKeys("golden-passphrase", salt);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
const toHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

Deno.test("golden - path hashes are byte-identical", () => {
  for (const s of SAMPLES) {
    assertEquals(hashPathHex(keys.mac_key, s.path), s.pathHash);
  }
});

Deno.test("golden - identity hash (normalizeForHash -> blake3Hex) is byte-identical", () => {
  for (const s of SAMPLES) {
    assertEquals(blake3Hex(normalizeForHash(s.path, s.bytes)), s.idHash);
  }
});

Deno.test("golden - nonce derivation (blake3Keyed(nonce_key, hash bytes).slice(0,24))", () => {
  for (const s of SAMPLES) {
    const ph = blake3Hex(normalizeForHash(s.path, s.bytes));
    const nonce = blake3Keyed(keys.nonce_key, hexToBytes(ph)).slice(0, 24);
    assertEquals(toHex(nonce), s.nonce);
  }
});

Deno.test("golden - ciphertext framing (nonce||ct) is byte-identical", async () => {
  for (const s of SAMPLES) {
    const ph = blake3Hex(normalizeForHash(s.path, s.bytes));
    const sealed = await encryptChunk(normalizeForHash(s.path, s.bytes), keys, ph);
    assertEquals(toHex(sealed), s.sealed);
    // Framing invariant: 24-byte nonce prefix then ciphertext.
    assertEquals(sealed.length, 24 + (normalizeForHash(s.path, s.bytes).length + 16));
    assertEquals(toHex(sealed.slice(0, 24)), s.nonce);
  }
});
