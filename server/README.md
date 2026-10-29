# server/

Deno relay: SQLite version log + content-addressed blob store. It never sees plaintext or paths.

| File | Purpose |
|------|---------|
| `main.ts` | Entry point, route dispatch, WebSocket upgrade, startup recovery/purge |
| `auth.ts` | Device/admin token validation (60 s token cache), WS subprotocol bearer |
| `http-helpers.ts` | `jsonResp`, `requireDevice`, `adminGate`, CORS |
| `rate-limit.ts` | Admin-token attempt rate limiting |
| `db.ts` | SQLite schema + migrations runner, version/head queries |
| `blobs.ts` | Content-addressed blob store + GC reference scan |
| `blob-routes.ts` | `POST/GET/HEAD /blobs/:hash` |
| `routes.ts` | Vault data routes (`/heads`, `/versions`, storage, trash, rekey, provisioning) |
| `provisioning.ts` | Create vault / device, verifier, vault info |
| `admin-vaults.ts` | List/rename vaults, list/rename/revoke devices |
| `ws.ts` | WebSocket hub: fan-out, replay pacing, backpressure, revocation |
| `ws-handshake.ts` | `client_hello` gate: protocol + minimum plugin version, replay start |
| `ws-commit.ts` | Commit validation, conflict rejection, rename markers |
| `ws-types.ts` | Hub connection types and buffer/queue limits |
| `version-gate.ts` | Server version, protocol check, minimum plugin version |
| `trash.ts` | Trash routes: list, restore, purge, purge-expired, purge-all |
| `trash-db.ts` | `trashed_heads` queries, retention purge |
| `trash-erase.ts` | Delete forever: erase a rename chain's generations |
| `rekey-routes.ts` | Re-key session routes |
| `rekey-store.ts` | Re-key staging + blob swap recovery |
| `compaction.ts` | Version compaction, blob GC, trash purge, retention floor |
| `fs-usage.ts` | Disk usage for the storage row |
| `log.ts` | Structured JSON logging to stdout/journald |

Size rules (blocking, `deno task standards`): **≤ 300 code lines per file**, per-function ≤ 80 lines,
cyclomatic complexity ≤ 15, nesting ≤ 4. No total-LOC cap: the guarantee is a small, auditable
surface per file. Business logic lives in the client.
