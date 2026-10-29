---
name: geode-release
description: >
  Cut a Geode release (plugin via BRAT + server deploy): project-scoped to the Geode repo.
  Use when the user asks to release, bump the version, "bump BRAT", or ship to their vaults.
---

# Geode Release

Project-scoped to the Geode repo. Machine-specific values: read `.env.local` at the repo root
(template `.env.example`); the server deploy uses `$GEODE_SSH_HOST`. `deno task release` and
`deno task after-merge` load that file themselves (`--env-file=.env.local`), so a fresh shell needs no
manual export.

Normally invoked automatically by `deno task after-merge` after a merge (skill `geode-pr-flow`); the
manual command below stays for cutting one yourself.

## One command

```
deno task release X.Y.Z
```

This bumps `package.json`, `plugin/manifest/manifest.json`, and `plugin/manifest/versions.json`,
commits as `chore(release): vX.Y.Z`, pushes to `main`, tags `vX.Y.Z` (triggers `release.yml` → BRAT),
and deploys the server (`$GEODE_SSH_HOST`): **one atomic step.**

Run it through the task, never `deno run -A scripts/release.ts`: only the task loads `.env.local` for
the deploy step.

**Plugin and server always ship together: release is not separable.** A version difference does not
block sync: the server gates on wire protocol + minimum version only, and a compatible difference shows
an update hint. The pair still ships together so no client ever runs a wire-protocol skew. The script
has **no `--no-deploy` flag**. `deploy/deploy.sh` alone is only a
server-config redeploy primitive at an unchanged version, never a release path.

## Preconditions (script enforces these)
- `GEODE_SSH_HOST` set (`.env.local`), checked **before** step 1, so a missing value fails with
  nothing bumped, committed, pushed or tagged. `deploy/deploy.sh` needs it too.
- No `RELEASE_HOLD` file at the repo root, while it exists, `after-merge` skips the release and
  `deno task release` refuses; remove it in its own PR to resume.
- On branch `main`.
- Working tree clean.
- Version not already current.
- Valid semver `X.Y.Z`.

**Release is atomic + irreversible** (bump → tag → prod deploy → BRAT publish). Confirm ALL intended
issues are merged to `main` *before* running it: you cannot fold more in once it fires; a late addition
needs its own follow-up version.

## SemVer guidance
- **PATCH** (`0.5.0 → 0.5.1`): backward-compatible fix only.
- **MINOR** (`0.5.0 → 0.6.0`): backward-compatible feature (even small).
- **MAJOR** (`0.5.0 → 1.0.0`): breaking change or "declared stable".
- Pre-1.0: **fix → last digit, feature → middle digit.**

## Version from commits (post-merge)
Cut a release only after a merge. Count only commits since the last tag that touch shipped code
(`plugin/`, `server/`, `core/`, `db/`):
```
git log $(git describe --tags --abbrev=0)..HEAD --no-merges --format=%s -- plugin server core db
```
- any `feat` → MINOR
- else any `fix` / `perf` → PATCH
- else (none, or only `docs`/`chore`/`test`/`ci`/`refactor`/`style`/`build`) → **no release**

Run it locally after pruning (skill `geode-pr-flow`); Actions never releases or deploys.

## After release
- **Reload devices / cutover:** local dev vaults still run the old build until rebuilt+redeployed.
  BRAT users get the update on next plugin check.
- **Release notes:** `release.yml` sets `generate_release_notes: true`, so the body is auto-populated
  from merged PRs/commits since the previous tag (plus a short BRAT preamble). Override if needed:
  `gh release edit vX.Y.Z --notes "..."`

## Gotchas
- **Tag convention:** repo tags `vX.Y.Z` (with `v`). BRAT reads the manifest asset, so this works.
- **"No plugin/core change… no BRAT release needed" in the deploy log is a red herring**: that's the
  local deploy script's own check; `release.yml` still builds and publishes the plugin assets. Verify
  with `gh release view vX.Y.Z --json assets` (expect `main.js`/`manifest.json`); allow ~1-2 min lag,
  empty `assets` right after release ≠ failure.
