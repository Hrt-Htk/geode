# Geode: Way of the land

Self-hosted, end-to-end encrypted, real-time sync for Obsidian. Models Obsidian Sync's architecture
(chunked content-addressed storage + WebSocket replication + 3-way markdown merge) for personal use.

This file is a **development spec**, not a README: it makes day-to-day dev work correct and fast.
Read it as three parts: **Hard rules** (invariants that bind at every stage), **Workflow** (the
ordered procedure for a change), and **Commands & skills** (reference lookups).

## Optional local tooling

Contributing needs `git`, `deno`, Node 22 and an Obsidian install (`docs/ops/dev-setup.md`), plus a
green `deno task ci` before every push. Everything else this file names is the maintainer's own setup.
A gate that needs one of those items still has to pass before merge: if you cannot run it, say so in
the PR and the maintainer runs it.

- **Paseo** and its `pi` agents: worktree workspaces (hard rule 8), the review-loop personas, the
  project board, `deno task after-merge`. Without it, work on a plain `git` branch; CI enforces the
  same branch, commit and gate rules for everyone.
- **A phone, a tablet, and a desktop Obsidian** for the hybrid E2E and on-device screenshot gates.
  Without a device, run the desktop projects and name the gates you could not run.
- **A real vault** (`$GEODE_BENCH_VAULT_DIR`, `$GEODE_SEED_VAULT_DIR`) for the benchmark-vault gate
  and hybrid cold sync. Without one, the fuzz suite and the two-vault scenarios are the sync gate.
- **A production server** (`$GEODE_PROD_URL`): read-only inspection only, never needed, never written.
- **`.env.local`** holds the machine-specific values. Copy `.env.example`; the docs name the
  variables they use.

## Architecture in one paragraph

A small Deno server holds an append-only version log per vault in SQLite and a content-addressed
blob store on disk. Clients (Obsidian plugins) chunk files with FastCDC, encrypt each chunk with
XChaCha20-Poly1305 using a deterministic nonce derived from the chunk's plaintext hash, and upload
chunks by hash: server-side dedup is automatic. A WebSocket per device receives version messages in
monotonic `seq` order; on conflict, the client walks the parent chain to find the common ancestor
and runs `node-diff3` for markdown or falls back to conflict-file creation for binaries. **The
server never sees plaintext, never sees paths.**

The three code homes: **`server/`** (Deno relay: SQLite + blob store), **`core/`** (crypto +
chunking, runs on both server and client, dependency-free), **`plugin/`** (Obsidian plugin: all
business logic; `sync/` is the sync core, `plumbing/` infra, `ui/` components).

## Hard rules: never violate these (they bind at every stage)

1. **Don't change FastCDC parameters or the chunking algorithm** (`docs/crypto/encryption-chunking.md`).
   Any change breaks every existing vault.
2. **Don't change deterministic-nonce derivation.** Every existing blob becomes orphaned.
3. **Don't change the wire protocol without bumping `protocol_version`.** Add fields; never rename or remove.
4. **No DIY crypto.** libsodium and `@noble/hashes` only.
5. **Lean code is the standard; size is a signal, not a number.** Effective, straight to the point,
   as simple as possible: one *reason to change* per unit. No abstraction used once, no speculative
   params or config, no guards for cases that can't occur, no duplicated logic (extract at the 3rd
   use, not the 2nd). Don't LOC-game (shuffle handlers, collapse imports, strip comments): a cohesive
   file slightly over beats splitting to hit a number: when one pushes well past, extract a
   *responsibility*. Tripwires: **`server/` ≤300 code lines/file, blocking**: it's the only
   network-facing component, so a small, single-responsibility auditable surface *is* the security
   boundary. **`core/`/`plugin/` ≤500 code lines/file, blocking** as a monolith guard; >300 is a
   review candidate, not a failure. Per function: ≤80 lines, cyclomatic complexity ≤15, nesting ≤4,
   enforced by `deno task standards`. No hard *total* cap: a total-LOC ceiling is gamed by spreading,
   not by staying lean. Govern the server by leanness, the per-file tripwire and "keep the attack
   surface minimal", not by a total.
6. **`merger.ts` must never `commit()` marker-containing content.** Only `outcome.kind === "clean"`
   commits; marker results become conflict files.
7. **KDF params travel with the vault: never change default argon2/KDF params unless every vault
   stores its own.** `content_key` derives from `argon2(passphrase, salt, params)`, so params encrypt
   all content *and* the verifier. Change the default and every vault without stored params breaks: the
   correct passphrase fails verification and content is undecryptable. Params are authoritative per
   vault like the salt: store them server-side and derive with the vault's params. Every production
   vault stores its params, and there is no legacy-params fallback.
8. **Worktrees are Paseo-owned: never `git worktree add`.** Isolation is a Paseo worktree workspace.
   An agent that has the Paseo tools (Claude/Codex) calls `create_workspace { isolation: "worktree",
   mode: "branch-off", branchName: "<type>/issueN-slug", baseBranch: "origin/main" }`. pi has no Paseo
   MCP and uses the CLI instead: `paseo workspace create --isolation worktree --mode branch-off
   --new-branch … --base origin/main` (local daemon needs no password once its local credential exists;
   `paseo project delete <id>` removes a stale worktree project). The base branch follows the work,
   `origin/main`, or the epic integration branch for sub-issues. Never create `<repo>/worktrees/*`:
   those are not Paseo-owned, so they are never cleaned up and each becomes its own sidebar project
   instead of a workspace of this repo. Archive the workspace once its PR merges; that deletes the
   directory. A fresh worktree runs `worktree.setup` from the committed `paseo.json`; archive runs
   `worktree.teardown`, which kills leftover processes started from the worktree.

## Workflow

Repo status: `deno task health` prints the advisory report (review candidates, near-limit files, 90-day churn) on demand; CI enforces the hard limits. Board `GEODE_BOARD`, set in `.env.local`, is read by `after-merge` only; unset, that step is skipped.

The ordered procedure for any change: **1 Pre-flight → 2 Work → 3 Done → 4 Ship.** Walk it in
order: don't advance a stage until the previous one's conditions are met.

### 1 · Pre-flight: mandatory before any `edit`/`write` under `server/`, `core/`, `plugin/`, `test/`, `db/`

Run in order. **If any fails, STOP: do not edit.**

**Applies to everything.** No file creation, no code change, no git operation, no matter how small
or seemingly trivial, without passing all four checks first. A one-line test, a comment tweak, a
config change: all are repo changes and all require pre-flight. The size of the task is never an
exception. **Sole exception:** a change touching **only `CLAUDE.md`** may be committed and pushed
straight to `main`: no branch, issue, or PR.

1. **`git status`**: working tree clean. If dirty, tell the user and stop.
2. **`git branch --show-current`**: must match `type/issueN-description` (e.g. `feat/issue42-chunk-encryption`).
   If on `main`/other, tell the user and stop. → skill `geode-pr-flow`.
3. **Issue exists**: an open GitHub issue covers this work. If none, ask the user (don't self-create).
   When the user *directs* creating one, file it **onto the project board**, not as a loose issue:
   `gh issue create --project "Geode Plan" ...` (bare `gh issue create` skips the board). Verify it
   landed: `gh issue view <N> --json projectItems` (expect `projectItems` length ≥ 1).
   Epic sub-issues are **native, not body text**: nest them with
   `gh issue edit <epic> --add-sub-issue <N>` (repeat flag per issue).
4. **TDD**: for any logic change, a **failing test must exist before implementation**. About to
   implement without a red test? Stop and write it first. Exceptions: docs, chore, quick UI tweaks.

### 2 · Work: how you write the code

**Tooling**

- **TypeScript everywhere**: Deno on the server, esbuild-bundled for the plugin.

**Runtime rules**

- **No em or en dash in a tracked file**: a plain hyphen, or rewrite the sentence. `scripts/check-dashes.ts` fails the `standards` task on U+2014 or U+2013 anywhere but the vendored `.claude/skills/obsidian/` tree.
- **No `console.log` outside `*/log.ts`**: use the structured logger (enforced by `no-console`).
- **Tests are linted and name-checked**: `deno task standards` lints `test/` (test-only exemptions: `no-console`, `no-explicit-any`) and enforces `test/README.md`'s naming rule: kebab-case, no issue numbers, `gateN-` only for `docs/testing/step-gates.md` evidence.
- **Type-check before tests**: after any `server/`/`core/` edit, `deno check server/main.ts core/*.ts`. Plugin's type gate is `tsc -p tsconfig.plugin.json` inside `deno task standards` (`build:plugin` doesn't type-check).
- **`deno task ci` is the full local gate**: same steps as CI's `Deno checks` job (install → check server+core → build plugin → `deno task standards` → `deno task test:ci` → `docs:drift` (warn-only; the hard check is the `Gate evidence` job)); CI then fails if build/tests left the tree dirty. Run it before every push: GitHub runs no CI job on a draft PR, only once it is ready. `test:ci` runs `--no-check --ignore=test/fuzz`: fuzz is skill-driven, and the plugin's type gate is `tsc`, so `deno test` does not type-check that graph.
- **Docs attest code, not decorate it**: before editing an area, read the doc whose `covers:` frontmatter matches it (`deno task docs:drift` prints every covered file changed here without its doc; a `watches:` match prints warn-only, no opt-out needed). Update that doc in the same PR, or state `docs: unaffected - <reason>` in the PR body; the `Gate evidence` job fails otherwise.
- **Scratch and tests in a worktree**: scratch scripts go in the worktree's `tmp/` (imports from `/tmp` don't resolve); run tests with `deno task test:ci` (bare `deno test` hits known type noise); Paseo setup installs `node_modules`, never link it; don't `deno fmt` files you didn't change.
- **Machine-specific values live in `.env.local`** (template `.env.example`, gitignored; a worktree gets it symlinked by `paseo.json`). Skills and docs name the variable (`$ANDROID_SERIAL`, `$GEODE_SSH_HOST`, `$GEODE_BENCH_VAULT_DIR`), never the value: no IP, hostname, device serial, vault name or home path in tracked files.
- **Review evidence lives in the main checkout**: screenshots and logs for review go to the main checkout's `tmp/review/<issue>/` (from a worktree: `"$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")/tmp/review/<issue>/"`), never a worktree's `tmp/` (deleted on archive) or `/tmp`.
- **`deno task standards` is the scripted rulebook**: `deno fmt --check` over the code (`*.ts`, `*.mjs`, `*.json`; markdown is never formatted, the docs are wrapped by hand), `deno lint` over `server/ core/ plugin/ test/` (incl. `no-console`, `require-await`), plugin `tsc`, ESLint (`obsidianmd.configs.recommended` over `plugin/` + `core/`, the community scanner ruleset, plus floating promises, ≤80 lines/function, complexity ≤15, nesting ≤4, import boundaries), unused exports, jscpd ≤2%, CSS syntax (postcss on `plugin/manifest/styles.css`), no random test ports, test file names, docs gate (dead paths, broken links, missing `deno task`s, orphan docs, `covers:`/`watches:` globs: `scripts/check-docs.ts`), private-data gate (private IPv4, `*.ts.net`, the Tailscale IPv6 ULA prefix, `/home/<name>/`, `/Users/<name>/`, `C:\Users\<name>\` in tracked files: `scripts/check-private.ts`; add your own values to the untracked file `GEODE_PRIVATE_DENYLIST` names, never to the repo: a set-but-unusable denylist fails the gate), LOC tripwire (code lines: `server/` ≤300, `core/`/`plugin/` ≤500; >300 core/plugin = review candidate). Cite another repo's path as a link, never a code span: the gate reads it as ours. Lint/types/eslint/exports ratchet against a shrink-only baseline in `scripts/standards.ts`: **zero violations**: a missing baseline allows none, and `--update` refuses to write a baseline that records a violation. A new rule lands clean or with a hand-written, shrink-only baseline; never raise the baseline: fix the code.
- **Tests run on Linux CI**: paths use `/` or `@std/path`, never `\`; poll the server DB for version counts, don't rely on flush timing.
- **Anything with a UI or a client↔server seam gets a real-Obsidian Playwright E2E, not a code simulation.**
  Drive a real Obsidian vault through the actual flow (wizard/command) and assert the observable outcome,
  never re-simulate the logic with hand-rolled client calls or always-happy fakes; those pass while
  the real path stays broken. Never point a test at the prod server. Purely code-logic bugs may stay at
  unit level.
- **Multi-line commit/PR messages via file**: `git commit -F <file>`, `gh ... --body-file <file>`; inline `-m` mangles backticks and `${}`.
- **Keep the `deno.json` libsodium CJS alias + `libsodium-sumo` direct dep: don't revert.**
- **Plugin HTTP:** `requestUrl` on desktop, `fetch` on mobile. `fetch` is CORS-blocked in the Electron
  renderer; `requestUrl` has a binary-POST / dropped-header bug on Android. Branch on `Platform.isMobile`.
- **Migrations:** forward-only, numbered, never edited after commit.
- **State writes are device-gated**: no temp-file+rename "atomic write" on the state path; it starved
  the native FS bridge and regressed on-device sync. Torn files are tolerated (parse-fail →
  empty → reconciler rebuilds), so atomicity is nice-to-have, not a correctness requirement.

**Code organization**

- **`core/` is dependency-free** (stdlib + libsodium + noble-hashes): it ships to both server and plugin.
- **UI logic lives in an `obsidian`-free module.** Anything importing `obsidian` (statusbar, settings,
  modals, views) can't run under `deno test`: extract the pure logic (e.g. `plugin/ui/plugin-sync-list.ts`),
  unit-test that, keep the `obsidian` file a thin E2E-verified shell.
- **Comments: default to none**: docs carry the *why*, code the *what*.

**Review loop** (→ skill `geode-review-loop`): `worker` → `reviewer` → `lean-code-reviewer` →
`lean-simplifier`, run as Paseo pi agents (personas in `.agents/personas/`), for any non-trivial change
before a PR leaves draft:

- **worker** implements against a red test (TDD gate above). Hand it a real chunk, not line-edits.
- **reviewer** reads the diff for *correctness*: behavior drift, dropped guards, broken call sites,
  invariant breaks (device-gated state writes, wire protocol, nonce/chunking, `merger.ts` markers).
  Blocks on any real bug.
- **lean-code-reviewer** reviews the diff against Rule 5 (abstraction-used-once, dead code,
  duplication, over-engineering) read-only; **lean-simplifier** applies its report.

Diffs ≤ ~100 lines may be reviewed inline instead. **Verifying an agent's run is token light:** its
report is the primary signal; check it once against the diff stat, the gate results and how the session
ended, and dig in only on a mismatch. The agent reads its own
screenshots; don't re-run its tests locally: PR CI is the final oracle. Native `/code-review` is the fallback when a
persona's output is unreliable. Findings go on the PR, ending with the `Review pass: done` marker;
tick the PR body's `Review pass` checkbox for the gate-evidence job. **Never flip a PR draft→ready
without the review pass.**

**UI changes**: load skill `geode-ui`; when the optional `impeccable` skill (external, not in this
repo) is installed, route the design through it. The screenshot loop is a **Done** gate (below), not
optional polish.

### 3 · Done: Definition of done

Classify the change, then run **every gate for that class and all classes below it**. Not done: don't
mark complete, commit as done, or open a non-draft PR until gates are green and the evidence (test
output, `diff -rq` result, before/after PNGs) is **captured, not "pending"**.

| Change class | What triggers it | Required gates (cumulative) | Launch skill |
|---|---|---|---|
| **Docs / chore** | `docs/`, config, comments | Build still green. No test required. | - |
| **Logic** | `server/`, `core/`, non-sync `plugin/` | Red test written first → `deno check server/main.ts core/*.ts` + `deno test` green + any relevant scenario. | - |
| **Sync-affecting** | `plugin/sync/*`, `core/` reconciler/merge/apply/commit/chunker | + `test/two-vault-driver.ts` scenarios + **benchmark-vault convergence** + E2E step gates (`docs/testing/step-gates.md`) run **hybrid (desktop + phone)**. | `geode-benchmark-vault`, `geode-fuzz`, `geode-phone-e2e` |
| **Adapter / mobile / state-persistence** | adapter calls, how state files are written, mobile paths | + on-device assertions in the same hybrid E2E run. | `geode-phone-e2e` |
| **UI** | settings, modals, views, status bar, `styles.css` | + **screenshot loop** in real Obsidian (below). | `geode-ui` |

What each gate means (so it's run for real, not nominally):

- **Benchmark-vault convergence**: `diff -rq` on-disk against a *copy* of the real vaults on a
  throwaway server, not the status-bar counter (clean fixtures miss counter storms / line-ending churn).
- **Hybrid E2E**: desktop-green hides Android `this`-binding and Capacitor FS bugs `FakeVault` masks;
  run desktop + phone in one pass. **Never ask the user whether the phone is available: probe it
  yourself and proceed.** The device is the default, not a blocker: run `adb devices` (via the
  `geode-phone-e2e` wireless-ADB procedure) as the first step of any phone/hybrid gate. If a device is
  listed and authorized, run the tests directly. Only surface to the user if, *after* attempting the
  skill's connect steps, no device is `device`-state (missing / `unauthorized` / `offline`), and say
  exactly what you tried. Do **not** defer phone gates to the user or treat "phone might not be
  connected" as a reason to skip or hand off.
- **Screenshot loop**: read the PNG and assert the log oracle (`getRecentLog` / instance methods). A
  green build / `deno test` / testid grep is **not** UI verification; "screenshot pending" is not done.
  Mobile UI → on-device.
- **Step gates are ordered**: N+1 assumes N is correct; don't skip (`docs/testing/step-gates.md`).
- **Every class also:** red→green on any new test, **leanness: name each changed file's single
  responsibility; no abstraction used once** (Rule 5 tripwires), no `console.log` outside `*/log.ts`,
  Conventional Commit, one issue → one PR.

### 4 · Ship: commit, PR, merge, release

**Commit**: Conventional Commits `type(scope): description` (`feat`, `fix`, `docs`, `refactor`,
`style`, `test`, `chore`, `perf`, `build`, `ci`). Footer `Closes #N` on the final commit, `Refs #N` on
intermediate ones. CI hard-fails on bad commit format, branch name, or a missing issue reference.

**PR & merge** (→ skill `geode-pr-flow`):

1. **Open a draft PR against `main`.** Every PR must reference an open issue (PR body or a commit).
   One issue → one PR, except when issues genuinely share files: one branch, a commit per issue, one
   PR closing each (`Closes #a, closes #b`: a keyword per issue, or GitHub closes only the first), noted in the body. Draft it while anything is still owed (a
   Done gate, the review pass, a follow-up issue). Auto-ship never merges a draft.
2. **Never close an issue without a green PR.** An issue stays open until the PR that fixes it is
   merged and CI is green. Don't close issues based on tests alone, manual verification alone, or
   analysis alone. Wait for the green PR.
3. **Ready → auto-merge.** Once nothing is owed, `gh pr ready N` (or open the PR ready directly).
   The `Auto-ship` workflow (on CI `workflow_run` success, pull_request events) merges a **ready**
   PR (`gh pr merge N --merge --delete-branch`); drafts stay open, and only the maintainer's own PRs
   from this repo auto-merge. CI must be green: Workflow Checks + Deno checks + Gate evidence. The
   `Closes #N` footer **auto-closes the issue** on merge to `main` (never close it manually before
   merge).
4. **Keep docs in sync in the *same* PR.** If the change alters behavior a doc describes (paths, flows,
   gates, wire format), update it; if a doc no longer matches reality and isn't worth keeping, delete
   it (a stale doc is worse than none). Never delete the cited load-bearing docs
   (`crypto/encryption-chunking.md`, `testing/step-gates.md`). Scan `docs/` for contradictions first.
   `deno task docs:drift` names the doc your change drifted from; `docs: unaffected - <reason>` in the
   PR body opts out of a hard `covers:` drift (`watches:` only warns).
5. **After a merge: archive the PR's Paseo workspace, then `deno task after-merge`**: prune gone
   branches (after `git worktree prune`), move closed board items to Done, release per skill `geode-release`. Archive first: git refuses to delete a branch still checked out
   in a live worktree. No release or deploy in Actions: it stays local. Paseo often archives a merged
   PR's workspace itself (its agent stops): `Workspace not found` then is normal; continue with
   after-merge.
6. **Transient CI** (empty `runner_name`, cancelled-while-queued, "Service Unavailable") **→ re-run, not a code bug** (`gh api repos/OWNER/REPO/actions/runs/<id>/jobs`).

**Release to users**: `deno task release X.Y.Z` is the manual release path, one atomic step: bumps the
shared version line (`package.json` only), commits `chore(release): X.Y.Z`, pushes the bare `X.Y.Z` tag
(→ `release.yml` → attested pre-release → BRAT), and deploys the server: plugin and server together
(never one without the other; a version difference no longer blocks sync: the server gates on wire
protocol + minimum version only, and a compatible difference shows an update hint instead). The build
stamps `package.json`'s version into `plugin-dist/manifest.json`, so the release asset says `X.Y.Z`
while the root `manifest.json` keeps the last promoted version. **Every release is a pre-release:**
BRAT picks it up, the community directory does not. `deno task promote X.Y.Z` moves a tested release
to the directory: root `manifest.json` + `versions.json`, commit `chore(release): promote X.Y.Z`, push
`main`, clear the pre-release flag, mark it latest, notes since the last promoted version. No rebuild
and no server deploy. No `--no-deploy` mode. `after-merge` calls `release` automatically (step 5);
promote is always manual. `deploy/deploy.sh` alone is only a server-config redeploy primitive, not a
release path. The release task loads `.env.local` for the deploy (`GEODE_SSH_HOST`) and refuses before
the version bump while that value is unset. Skill `geode-release`. While `RELEASE_HOLD` exists at the
repo root, `after-merge` skips the release and `deno task release` / `deno task promote` refuse:
remove the file in its own PR to resume.

Full process spec: `docs/dev/workflow.md`, `CONTRIBUTING.md`.

## Commands & skills (index)

- **Skills** live in `.claude/skills/` (tracked); `.agents/skills` symlinks to it for pi. Skill use
  does not need Paseo: read the `SKILL.md` and follow it.
- **Personas** (`.agents/personas/`) are Paseo/pi agent definitions, not peer docs: Paseo frontmatter plus
  `contact_supervisor`/`intercom` tools. Without Paseo, read them as review checklists.
- **`deno`:** on `PATH`. E2E tool overrides (`DENO_BIN`, `OBSIDIAN_BIN`, `ADB_PATH`, `GEODE_SEED_VAULT_DIR`): `docs/ops/dev-setup.md` §2.
- **Build plugin:** `deno task build:plugin` → `plugin-dist/` (builds only; does **not** deploy).
- **Skills:** `geode-pr-flow` (branch/PR/merge/purge) · `geode-release` (version bump + BRAT + server
  deploy) · `geode-review-loop` (worker → reviewer → lean pass before draft→ready) ·
  `geode-benchmark-vault` + `geode-fuzz` (sync validation) · `geode-phone-e2e` (device/hybrid
  E2E; ADB + CDP runbook) · `geode-ui` (UI design + screenshot loop) · `impeccable` (design grading;
  optional, external, not in this repo) ·
  `geode-task-breakdown` (breakdown & estimation).
- **Design docs:** `docs/README.md` is the index; start at `docs/architecture/overview.md` (architecture + build order).
