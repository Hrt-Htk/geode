---
covers: []
---

# Geode documentation

The index of `docs/`. Every document is listed below. One topic per file, no numeric prefixes, a
basename unique inside `docs/` (apart from the two `README.md` indexes), so a grep finds every
reference.

Start with [`architecture/overview.md`](architecture/overview.md): architecture summary, milestone
ladder and repo layout. `CLAUDE.md` names the two load-bearing docs whose invariants bind every change:
[`crypto/encryption-chunking.md`](crypto/encryption-chunking.md) and
[`testing/step-gates.md`](testing/step-gates.md).

**`covers:` and `watches:`**: every doc's frontmatter declares the code it attests, as globs:

```
---
covers: [server/*.ts, db/migrations/*.sql, deploy/*]
watches: [test/scenarios/**]
---
```

`covers:` is hard: a change without this doc in the PR is drift. `watches:` is advisory: code the doc
describes but does not attest, mostly test suites, so a change prints which doc to check and fails
nothing. A summary or exploration doc carries `covers: []`, since it holds history rather than
attestation. Before changing code, run `deno task docs:drift`, which names the doc your change drifted
from. Update that doc in the same PR, or state `docs: unaffected - <reason>` in the PR body. A new doc
needs `covers:`, and its globs must match real paths (`docs/dev/workflow.md` § Docs drift).

**Audience**: `contributor` builds, tests or reviews the code; `maintainer` cuts releases and owns the
process.

## architecture/

| Document | Covers | Audience |
| --- | --- | --- |
| [`overview.md`](architecture/overview.md) | Architecture summary, milestone ladder, repo layout, document map | contributor |
| [`server.md`](architecture/server.md) | Server: HTTP routes, WebSocket, SQLite schema, blob store and GC, trash, re-key, auth, deployment | contributor |
| [`plugin.md`](architecture/plugin.md) | Obsidian plugin: lifecycle, state, transport, vault events, reconciler, apply/commit, merge, mobile, UI | contributor |
| [`merge.md`](architecture/merge.md) | 3-way merge: ancestor walk, `node-diff3`, edge-case dispatcher, conflict files | contributor |

## crypto/

| Document | Covers | Audience |
| --- | --- | --- |
| [`encryption-chunking.md`](crypto/encryption-chunking.md) | **Load-bearing.** KDF, encryption, deterministic nonces, FastCDC, normalization | contributor |

## testing/

| Document | Covers | Audience |
| --- | --- | --- |
| [`strategy.md`](testing/strategy.md) | Test taxonomy, two-vault driver, observability, recovery operations including compaction and blob GC, migration and backup policy, release criteria | contributor |
| [`step-gates.md`](testing/step-gates.md) | **Load-bearing.** Per-step gates: tests, manual checks, pass criteria | contributor |
| [`e2e-playwright.md`](testing/e2e-playwright.md) | Real-Obsidian E2E: Playwright over CDP, desktop plus phone and hybrid projects | contributor |
| [`e2e-campaign.md`](testing/e2e-campaign.md) | E2E realism ladder: level 0, standing invariants, fuzz oracle | contributor |

## ops/

| Document | Covers | Audience |
| --- | --- | --- |
| [`dev-setup.md`](ops/dev-setup.md) | Tool versions, per-OS setup, repo config, dev loop, troubleshooting | contributor |
| [`trash-soft-delete.md`](ops/trash-soft-delete.md) | Soft-delete retention: endpoints, retention, delete forever, decisions | contributor |

## dev/

| Document | Covers | Audience |
| --- | --- | --- |
| [`workflow.md`](dev/workflow.md) | Issue, branch, commit and PR rules | maintainer |
