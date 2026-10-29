# core/

Crypto and chunking engine: runs on both server and client.

| File | Purpose |
|------|---------|
| `chunker.ts` | FastCDC content-defined chunking |
| `compact.ts` | Pure version compaction planner (keep one checkpoint per edited day) |
| `concurrency.ts` | `mapWithConcurrency`: bounded-concurrency map, results in input order |
| `crypto.ts` | XChaCha20-Poly1305 encryption, Argon2id KDF, verifier |
| `hash.ts` | BLAKE3 hashing utilities |
| `log.ts` | Logging core: level gating and sink fan-out, no formatting |
| `normalize.ts` | Text normalization for deterministic chunking |
| `protocol.ts` | Wire protocol types + base64 helpers |
| `reassemble.ts` | Chunk reassembly with integrity verification |
| `version.ts` | Semver parse/compare and minimum-version gate |

Dependency-free (stdlib + libsodium + @noble/hashes only).
