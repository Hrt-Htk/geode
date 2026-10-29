---
covers: []
---

# Architecture overview

Geode syncs Obsidian vaults between devices through a server you run. Each device encrypts files before
sending them, so the server holds only encrypted data and never sees paths or contents. The design
follows Obsidian Sync: chunked content-addressed storage, WebSocket replication, and a 3-way markdown
merge.

---

## Document map

| File                         | Covers                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **`overview.md`**            | This file. Architecture, invariants, milestone ladder, repo layout.                                                         |
| **`server.md`**              | Server: HTTP routes, WebSocket protocol, SQLite schema, blob store, auth, deploy.                                            |
| **`plugin.md`**              | Obsidian plugin: lifecycle, state, transport, vault events, reconciler, apply, commit, UI, mobile.                            |
| **`merge.md`**               | 3-way merge: ancestor walk, `node-diff3` strategy, edge cases, conflict files.                                               |
| **`../crypto/encryption-chunking.md`** | Shared crypto + chunking: KDF, encryption, FastCDC, normalization. `core/` runs on both sides.                    |
| **`../testing/strategy.md`** | Test taxonomy, two-vault driver, observability, recovery, compaction/GC, migrations, backup.                                 |
| **`../testing/step-gates.md`** | Per-milestone gates. The canonical "is step N done" doc; the table below only names them.                                 |
| **`../testing/e2e-playwright.md`** | Real-Obsidian E2E: Playwright over CDP for desktop, phone and hybrid projects.                                          |
| **`../testing/e2e-campaign.md`** | E2E realism ladder (level 0 spec, standing invariants, fuzz oracle).                                                    |
| **`../ops/dev-setup.md`**    | Toolchain, per-OS setup, dev loop, verification.                                                                             |
| **`../ops/trash-soft-delete.md`** | Soft-delete retention (trash) design.                                                                                   |

---

## Architecture at a glance

```
┌─────────────────────────────────┐         ┌─────────────────────────────────┐
│  Obsidian (Device A)            │         │  Obsidian (Device B)            │
│  ┌───────────────────────────┐  │         │  ┌───────────────────────────┐  │
│  │ Geode plugin              │  │         │  │ Geode plugin              │  │
│  │  ├ vault event handler    │  │         │  │  ├ vault event handler    │  │
│  │  ├ reconciler (5 min)     │  │         │  │  ├ reconciler (5 min)     │  │
│  │  ├ FastCDC chunker        │  │         │  │  ├ FastCDC chunker        │  │
│  │  ├ libsodium crypto       │  │         │  │  ├ libsodium crypto       │  │
│  │  ├ node-diff3 merger      │  │         │  │  ├ node-diff3 merger      │  │
│  │  ├ JSON state files       │  │         │  │  ├ JSON state files       │  │
│  │  ├ key cache (local store)│  │         │  │  ├ key cache (local store)│  │
│  │  └ WS transport           │  │         │  │  └ WS transport           │  │
│  └─────────────┬─────────────┘  │         │  └─────────────┬─────────────┘  │
└────────────────┼────────────────┘         └────────────────┼────────────────┘
                 │  HTTPS / WSS                              │
                 └─────────────────┬─────────────────────────┘
                                   │
                          ┌────────▼────────┐
                          │  Caddy (TLS)    │
                          └────────┬────────┘
                                   │
                          ┌────────▼─────────────────────┐
                          │  Geode server (Deno)         │
                          │   ├ HTTP routes              │
                          │   ├ WS hub (per-vault)       │
                          │   ├ SQLite metadata          │
                          │   └ FS blob store (atomic)   │
                          └──────────────────────────────┘
                                   │
                          ┌────────▼──────────────────────────┐
                          │  data/geode.db                    │
                          │  data/blobs/<vaultId>/<hh>/...    │
                          └───────────────────────────────────┘
```

**Key invariants:**

1. **Server never sees plaintext or paths.** Blobs, `enc_metadata` and `path_ciphertext` are encrypted
   client-side; the server addresses files by keyed-BLAKE3 `path_hash`.
2. **Chunks are content-addressed and deterministic.** The same plaintext from two devices produces the
   same ciphertext, the same hash, and one upload. Dedup is per vault, because each vault has its own
   key.
3. **Versions are immutable and linked by `parent`.** History is a chain per path; rename markers and
   notes (`rename_mark`) link a file's history across names.
4. **A global per-vault `seq` is the replay cursor.** A reconnect asks for everything with
   `seq > last_seen_seq`.
5. **The reconciler is the source of correctness.** Vault events are a fast path; a periodic full scan
   catches what they miss.
6. **The server is a relay.** It holds no business logic. A small, auditable surface is the security
   boundary, so `server/` stays at or below 300 code lines per file (CLAUDE.md rule 5).

---

## Milestone ladder

The build order. The gate numbers are cited throughout the docs, so the table stays. Each step has a gate
in [`step-gates.md`](../testing/step-gates.md); do not move past a step until its gate is green.

| # | Milestone                                                        | Design doc                     | Gate                            |
| - | ---------------------------------------------------------------- | ------------------------------ | ------------------------------- |
| 1 | Server: blob routes + SQLite schema + migrations                 | `server.md` §3, §4, §5         | `step-gates.md` §Gate 1         |
| 2 | Shared: FastCDC chunker + libsodium crypto + normalization       | `encryption-chunking.md`       | `step-gates.md` §Gate 2         |
| 3 | Server: WebSocket fan-out + `/heads` + `/versions`               | `server.md` §5, §6             | `step-gates.md` §Gate 3         |
| 4 | Plugin: transport + vault events + reconciler + apply            | `plugin.md` §4 to §7           | `step-gates.md` §Gate 4         |
| 5 | Plugin: 3-way merge + ancestor walk + conflict files             | `merge.md`                     | `step-gates.md` §Gate 5         |
| 6 | Plugin: binary conflicts + recovery commands                     | `plugin.md` §8                 | `step-gates.md` §Gate 6         |
| 7 | Server: auth + Caddy + systemd                                   | `server.md` §8, §9, §10        | `step-gates.md` §Gate 7         |
| 8 | Mobile: key caching + foreground sync                            | `plugin.md` §10                | `step-gates.md` §Gate 8         |
| 9 | Polish: status bar, settings, conflicts view, logs               | `plugin.md` §9                 | `step-gates.md` §Gate 9 (soft)  |
| 10 | Server + plugin: soft-delete retention (trash)                  | `../ops/trash-soft-delete.md`  | `step-gates.md` §Gate 10        |
| 11 | Installability: BRAT/zip, admin-token join, wizard, deploy       | `../../README.md`              | `step-gates.md` §Gate 11        |

---

## Repo layout

Entry points only. Each design doc has its own module map.

```
geode/
├── server/                 # Deno relay: main.ts (bootstrap), routes.ts, ws.ts + ws-*.ts,
│                           #   blob-routes.ts, blobs.ts, db.ts, trash*.ts, rekey-*.ts,
│                           #   provisioning.ts, admin-vaults.ts, auth.ts, compaction.ts
├── core/                   # dependency-free, imported by server AND plugin
│                           #   protocol.ts (wire types + PROTOCOL_VERSION), crypto.ts, chunker.ts,
│                           #   hash.ts, normalize.ts, reassemble.ts, compact.ts, concurrency.ts,
│                           #   log.ts, version.ts
├── plugin/                 # Obsidian plugin (desktop + mobile)
│   ├── main.ts             # Plugin class: settings load, commands, status bar, delegations
│   ├── session.ts          # unlocked-session wiring (state, transport, sync manager, events)
│   ├── sync/               # sync core: transport + commit channel, events, reconciler, apply,
│   │                       #   commit queue, merger/conflict handler, replay, rename handling,
│   │                       #   history, re-key, trash client, export
│   ├── plumbing/           # infra: settings types, JSON state + persistence, key cache, vault
│   │                       #   lock, HTTP platform, logging, clients (provisioning/trash/rekey)
│   └── ui/                 # settings tab + sections, status bar/menu, modals, views (Obsidian-facing)
├── db/migrations/          # forward-only SQL, 001_init … 015_rename_mark
├── test/                   # two-vault-driver.ts, scenarios/, unit/, integration/, e2e/, fuzz/, bench/
├── scripts/                # build + release + standards + phone + dev utilities
├── deploy/                 # install.sh, geode.service, Caddyfile, token scripts
├── deno.json               # Deno config + tasks
└── package.json            # plugin-side npm deps (esbuild bundles them)
```

---

## What Geode does not do

- Real-time collaborative editing (no CRDTs).
- Vault sharing between users.
- Similarity-based rename detection. A rename the client missed is paired only when exactly one delete
  and one create share identical content (`plugin.md` §6); a copy-then-delete stays a delete plus a
  create.
- iOS background sync (no push notifications). Sync runs while Obsidian is open.
- Coexistence with iCloud or Google Drive. One sync tool per vault.
- Multiple server instances. WebSocket hubs are in-process, so one server instance serves a vault.
