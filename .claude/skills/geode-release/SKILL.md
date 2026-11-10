---
name: geode-release
description: >
  Cut a Geode release (pre-release to BRAT + server image), update your own server from it, and
  promote a tested one to the community directory: project-scoped to the Geode repo. Use when the
  user asks to release, bump the version, "bump BRAT", promote a release, update the server, or
  ship to their vaults.
---

# Geode Release

Three steps, one shared version line: release (bump, tag, publish), update your server from it, and
promote a tested release to the directory. **Every release is a pre-release:** BRAT installs it, the
community directory does not.

Project-scoped to the Geode repo. Machine-specific values: read `.env.local` at the repo root
(template `.env.example`). The release reads no environment; updating a server over ssh uses
`$GEODE_SSH_HOST` and `$GEODE_PROD_URL`. `deno task after-merge` loads that file itself
(`--env-file=.env.local`), so a fresh shell needs no manual export.

`release` runs automatically from `deno task after-merge` after a merge (skill `geode-pr-flow`);
promote is always manual.

## Release (a beta, to BRAT + GHCR)

```
deno task release X.Y.Z
```

Bumps `package.json` only, commits `chore(release): X.Y.Z`, pushes to `main`, and tags the bare
`X.Y.Z`: **one atomic step.** The tag is the whole release. `release.yml` builds, attests and publishes
the plugin as a **pre-release** (→ BRAT) and the server image to GHCR. The script deploys nothing.

**The tag also builds the server image, and a failed image job blocks the plugin release.**
`release.yml` builds `Dockerfile` for amd64 and arm64, merges the two digests into one manifest, attests
them and pushes `ghcr.io/hrt-htk/geode:X.Y.Z` plus `latest`; the `release` job `needs` that manifest.
So a broken image means no BRAT release either. Recover by re-running the failed jobs of that tag's run
(`gh run list --workflow=Release`, then `gh run rerun <run-id> --failed`): never delete and re-push the
tag, and never cut a new version for it.

**The root manifest does not move here.** `manifest.json` and `versions.json` are untouched: they are
what the community directory reads off `main`, so a beta must not move them. The build stamps
`package.json`'s version into `plugin-dist/manifest.json`, and that is the file the release ships and
the plugin reads at runtime (status bar, `hello.plugin_version`). Two version numbers, on purpose:

| File | Version | Read by |
| --- | --- | --- |
| `package.json` | latest release, beta or promoted | build → `plugin-dist/manifest.json`; server `SERVER_VERSION` |
| root `manifest.json` | latest **promoted** release | community directory |
| root `versions.json` | one row per **promoted** release | community directory |

**One tag, two artifacts, separate installs.** A plugin update and a server update are two actions: a
version difference does not block sync (the server gates on wire protocol + minimum version only, and a
compatible difference shows an update hint), but both come from the same tag, so a client never runs
against a server from a different protocol generation. There is **no plugin-only release**: the script
has no flag to skip any of it, and the image is not optional.

## Update your own server (after the tag)

The release does not touch a running server. Wait for that tag's `release.yml` run to finish, so the
image is published (`gh run list --workflow=Release`), then update through the host job, which is what
gives you the rollback:

- **The plugin's own button**: Geode settings, **Server update** → **Update** (asks for the admin
  token). It answers in about a minute.
- **Over ssh**, for a UI you cannot reach:

  ```
  ssh "$GEODE_SSH_HOST" 'sudo touch /opt/geode/data/update-request'
  ```

Then check it: `ssh "$GEODE_SSH_HOST" 'cat /opt/geode/update-status/result'` shows `updated <epoch>`
(or `up-to-date`, `blocked`, `rolled-back`, and the rest of §11's words), and `curl -s
"$GEODE_PROD_URL/version"` reports the new version. A `rolled-back` means Geode is healthy on the old
image: read the job's reason on the host, fix the image, release again.

`$GEODE_SSH_HOST` is used for this step only. Without the host job nothing answers the request: the
plugin then copies `docker compose pull && docker compose up -d` to run in the compose directory by
hand.

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

No rebuild, no image push: directory users get the exact build testers ran, versions in between
are skipped for them (1.0 → 1.3).

**Promote only after a release has been out for a while and no bug surfaced.** A bad beta is never
promoted: fix it and ship the next beta. Never promote a version at or below the root manifest's.

## Preconditions (scripts enforce these)
- No `RELEASE_HOLD` file at the repo root: while it exists, `after-merge` skips the release and
  `deno task release` / `deno task promote` refuse; remove it in its own PR to resume.
- On branch `main`.
- Working tree clean.
- Valid semver `X.Y.Z`.
- Release only: version not already current. Promote only: release exists, is a pre-release, and is
  **above** the root manifest's version.

**Release is atomic + irreversible** (bump → tag → image + BRAT publish). Confirm ALL intended
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

Run it locally after pruning (skill `geode-pr-flow`); Actions never decides a release and never
touches a server.

## After release
- **First release only: make the GHCR package public.** The image lands in
  `ghcr.io/hrt-htk/geode` as a private package, so `docker compose` cannot pull it anonymously. In the
  package settings, change the visibility to public and link the package to the repository (its
  provenance and source then show on the package page). One-time, after the first tag.
- **Reload devices / cutover:** local dev vaults still run the old build until it is rebuilt and
  reinstalled, and a server keeps running its old image until it is updated (the step above). BRAT
  users get the plugin update on their next plugin check. Directory users get nothing until it is
  promoted.
- **Release notes:** `release.yml` sets `generate_release_notes: true`, so a beta's body is
  auto-populated from merged PRs/commits since the previous tag (plus a short BRAT preamble).
  Promote replaces that body with the notes from the last **promoted** version.

## Gotchas
- **Tag convention:** the tag is the bare version (`0.41.8`): the community directory matches the
  release tag to the version in `manifest.json`, so a `v` prefix would be rejected. Tags cut before
  #12 keep their `v`: `scripts/promote.ts` resolves that form with `prevReleaseTag` when it needs the
  tag a previous version stands for.
- **A half-done promote:** if `gh release edit` fails after the push, `main` already advertises
  `X.Y.Z` with the old body and the pre-release flag still set. Rerunning refuses (the version is no
  longer above the manifest's): finish it by hand with `gh release edit X.Y.Z --prerelease=false
  --latest --notes-file <file>`.
- **Check the published artifacts, not the tag.** Verify with `gh release view X.Y.Z --json
  assets,isPrerelease` (expect `main.js`/`manifest.json` and `isPrerelease: true`); allow ~1-2 min lag,
  empty `assets` right after release ≠ failure. The image is a separate job: `gh run view` shows it, and
  a private package is the first-release trap above.
