---
name: geode-release
description: >
  Cut a Geode release (pre-release to BRAT + server deploy) and promote a tested one to the
  community directory: project-scoped to the Geode repo. Use when the user asks to release, bump
  the version, "bump BRAT", promote a release, or ship to their vaults.
---

# Geode Release

Two steps, one shared version line. **Every release is a pre-release:** BRAT installs it, the
community directory does not. `promote` later points the directory at a release testers have run.

Project-scoped to the Geode repo. Machine-specific values: read `.env.local` at the repo root
(template `.env.example`); the server deploy uses `$GEODE_SSH_HOST`. `deno task release` and
`deno task after-merge` load that file themselves (`--env-file=.env.local`), so a fresh shell needs no
manual export.

`release` runs automatically from `deno task after-merge` after a merge (skill `geode-pr-flow`);
promote is always manual.

## Release (a beta, to BRAT + your server)

```
deno task release X.Y.Z
```

Bumps `package.json` only, commits `chore(release): X.Y.Z`, pushes to `main`, tags the bare `X.Y.Z`
(`release.yml` builds, attests and publishes a **pre-release** → BRAT), and deploys the server
(`$GEODE_SSH_HOST`): **one atomic step.**

Run it through the task, never `deno run -A scripts/release.ts`: only the task loads `.env.local` for
the deploy step.

**The root manifest does not move here.** `manifest.json` and `versions.json` are untouched: they are
what the community directory reads off `main`, so a beta must not move them. The build stamps
`package.json`'s version into `plugin-dist/manifest.json`, and that is the file the release ships and
the plugin reads at runtime (status bar, `hello.plugin_version`). Two version numbers, on purpose:

| File | Version | Read by |
| --- | --- | --- |
| `package.json` | latest release, beta or promoted | build → `plugin-dist/manifest.json`; server `SERVER_VERSION` |
| root `manifest.json` | latest **promoted** release | community directory |
| root `versions.json` | one row per **promoted** release | community directory |

**Plugin and server always ship together: release is not separable.** A version difference does not
block sync: the server gates on wire protocol + minimum version only, and a compatible difference shows
an update hint. The pair still ships together so no client ever runs a wire-protocol skew. The script
has **no `--no-deploy` flag**. `deploy/deploy.sh` alone is only a
server-config redeploy primitive at an unchanged version, never a release path.

## Promote (to the community directory)

```
deno task promote X.Y.Z
```

Runs `scripts/promote.ts`:

1. `gh release view X.Y.Z --json isPrerelease`: the release must exist and still be a pre-release.
2. `gh api repos/{owner}/{repo}/releases/generate-notes`: notes for every change since the previously
   promoted version (`previous_tag_name` = the current root `manifest.json` version, resolved to its
   `v`-prefixed tag when it predates #12).
3. Sets root `manifest.json` `version`, appends `versions.json` `X.Y.Z -> minAppVersion` (never edits
   an existing row).
4. Commits `chore(release): promote X.Y.Z`, pushes `main`.
5. `gh release edit X.Y.Z --prerelease=false --latest --notes <body>`.

No rebuild, no server deploy: directory users get the exact build testers ran, versions in between
are skipped for them (1.0 → 1.3).

**Promote only after a release has been out for a while and no bug surfaced.** A bad beta is never
promoted: fix it and ship the next beta. Never promote a version at or below the root manifest's.

## Preconditions (scripts enforce these)
- `GEODE_SSH_HOST` set (`.env.local`), checked **before** release step 1, so a missing value fails
  with nothing bumped, committed, pushed or tagged. `deploy/deploy.sh` needs it too. Promote deploys
  nothing and does not need it.
- No `RELEASE_HOLD` file at the repo root: while it exists, `after-merge` skips the release and
  `deno task release` / `deno task promote` refuse; remove it in its own PR to resume.
- On branch `main`.
- Working tree clean.
- Valid semver `X.Y.Z`.
- Release only: version not already current. Promote only: release exists, is a pre-release, and is
  **above** the root manifest's version.

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
  BRAT users get the update on next plugin check. Directory users get nothing until it is promoted.
- **Release notes:** `release.yml` sets `generate_release_notes: true`, so a beta's body is
  auto-populated from merged PRs/commits since the previous tag (plus a short BRAT preamble).
  Promote replaces that body with the notes from the last **promoted** version.

## Gotchas
- **Tag convention:** the tag is the bare version (`0.41.8`): the community directory matches the
  release tag to the version in `manifest.json`, so a `v` prefix would be rejected. Tags cut before
  #12 keep their `v`: `scripts/release.ts` and `scripts/promote.ts` resolve either form with
  `prevReleaseTag` when they need the tag a version stands for, and `deploy.sh` falls back to
  `git describe` over both (`--match '[0-9]*' --match 'v*'`).
- **A half-done promote:** if `gh release edit` fails after the push, `main` already advertises
  `X.Y.Z` with the old body and the pre-release flag still set. Rerunning refuses (the version is no
  longer above the manifest's): finish it by hand with `gh release edit X.Y.Z --prerelease=false
  --latest --notes-file <file>`.
- **"No plugin/core change… no BRAT release needed" in the deploy log is a red herring**: that's the
  local deploy script's own check; `release.yml` still builds and publishes the plugin assets. Verify
  with `gh release view X.Y.Z --json assets,isPrerelease` (expect `main.js`/`manifest.json` and
  `isPrerelease: true`); allow ~1-2 min lag, empty `assets` right after release ≠ failure.
