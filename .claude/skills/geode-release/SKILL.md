---
name: geode-release
description: >
  Cut a Geode beta release (X.Y.Z-beta.N to BRAT + server image), update your own server from it,
  and promote a tested beta to the final release (X.Y.Z) in the community directory: project-scoped
  to the Geode repo. Use when the user asks to release, bump the version, "bump BRAT", promote a
  release, update the server, or ship to their vaults.
---

# Geode Release

Three steps, one shared version line: release a beta (`X.Y.Z-beta.N`), update your server from it,
and promote a tested beta to the final release (`X.Y.Z`). Releases are chosen by hand:
`deno task after-merge` does not release.

Project-scoped to the Geode repo. Machine-specific values: read `.env.local` at the repo root
(template `.env.example`). Release and promote read no environment; updating a server over ssh uses
`$GEODE_SSH_HOST` and `$GEODE_PROD_URL`.

## One pass

**Beta:**
1. Pick the version: the next `-beta.N` of the open base (`git tag -l '*-beta.*' --sort=-v:refname`),
   or a new base from the commits since the last final (SemVer guidance below).
2. Restate the version to the maintainer and wait for the go: a tag publishes to every BRAT vault.
3. `deno task release X.Y.Z-beta.N`, then watch that tag's `release.yml` run to success.
4. Update your own server (below) and confirm `/version` reports the new version.

**Promote:** restate `X.Y.Z` and wait for the go, `deno task promote X.Y.Z`, then step 4 above.

## Release a beta (to BRAT + GHCR)

```
deno task release X.Y.Z-beta.N
```

Accepts only the `X.Y.Z-beta.N` form. Bumps `package.json` only, commits
`chore(release): X.Y.Z-beta.N`, pushes to `main`, and tags `X.Y.Z-beta.N`: **one atomic step.**
`release.yml` builds, attests and publishes the plugin as a **pre-release** (BRAT) and the server
image to GHCR tagged `X.Y.Z-beta.N` and `beta`. The script deploys nothing.

**The tag also builds the server image, and a failed image job blocks the plugin release.**
`release.yml` builds `Dockerfile` for amd64 and arm64, merges the two digests into one manifest, attests
them and pushes `ghcr.io/hrt-htk/geode:X.Y.Z-beta.N` plus `beta`; the `release` job `needs` that
manifest. So a broken image means no BRAT release either. Recover by re-running the failed jobs of
that tag's run (`gh run list --workflow=Release`, then `gh run rerun <run-id> --failed`): never
delete and re-push the tag, and never cut a new version for it.

**`latest` and root `manifest.json` do not move here.** A beta release tags `X.Y.Z-beta.N` and
`beta` only: `latest` and root `manifest.json` / `versions.json` are what community directory users
follow, so a beta does not move them. The build stamps `package.json`'s version into
`plugin-dist/manifest.json`, and that is the file the release ships and the plugin reads at runtime
(status bar, `hello.plugin_version`).

| File | Version | Read by |
| --- | --- | --- |
| `package.json` | latest release (`X.Y.Z-beta.N` or promoted `X.Y.Z`) | build -> `plugin-dist/manifest.json`; server `SERVER_VERSION` |
| root `manifest.json` | latest **promoted** final release (`X.Y.Z`) | community directory |
| root `versions.json` | one row per **promoted** final release (`X.Y.Z`) | community directory |

**One tag, two artifacts, separate installs.** A plugin update and a server update are two actions: a
version difference does not block sync (the server gates on wire protocol + minimum version only, and
a compatible difference shows an update hint), but both come from the same tag, so a client never
runs against a server from a different protocol generation. There is **no plugin-only release**: the
script has no flag to skip any of it, and the image is not optional.

## Update your own server (after the tag)

The release does not touch a running server. Wait for that tag's `release.yml` run to finish, so the
image is published (`gh run list --workflow=Release`), then update through the host job, which is what
gives you the rollback. The job pulls whatever tag `compose.yaml` pins: `latest`, a promoted release,
by default; `beta` on a host that follows the betas.

- **The plugin's own button**: Geode settings, **Server update** -> **Update** (asks for the admin
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

## Promote (final `X.Y.Z` to the community directory)

```
deno task promote X.Y.Z
```

Runs `scripts/promote.ts`:

1. Verifies at least one `X.Y.Z-beta.N` tag exists, is an ancestor of `HEAD`, and no commit touching
   shipped paths (`plugin/`, `server/`, `core/`, `db/`) landed after the latest `X.Y.Z-beta.N` tag:
   what reaches the directory is what was tested as a beta.
2. Bumps `package.json`, sets root `manifest.json` `version` to `X.Y.Z`, and appends
   `versions.json` `X.Y.Z -> minAppVersion` (never edits an existing row).
3. Commits `chore(release): promote X.Y.Z` and pushes `main`, so the tag commit's root `manifest.json`
   equals the release manifest.
4. Tags `X.Y.Z` and pushes the tag. `release.yml` runs on that tag: builds and tags the server image
   `X.Y.Z`, `latest`, and `beta` (so `:beta` reaches the final too), builds and attests the plugin,
   and creates the non-prerelease GitHub release marked latest. `promote.ts` polls and watches that
   `release.yml` run to completion.
5. Generates release notes covering every change since the previously promoted final release
   (`previous_tag_name` = the old root `manifest.json` version, resolved via `prevReleaseTag` to its
   `v`-prefixed tag when it predates #12), and runs
   `gh release edit X.Y.Z --prerelease=false --latest --notes <body>`.

**Promote only after a beta has been out for a while and no bug surfaced.** A bad beta is never
promoted: fix it and ship the next `X.Y.Z-beta.N`. Never promote a version at or below the root
manifest's.

## Preconditions (scripts enforce these)
- No `RELEASE_HOLD` file at the repo root: while it exists, `deno task release` and
  `deno task promote` refuse; remove it in its own PR to resume.
- On branch `main`.
- Working tree clean.
- Release only: valid `X.Y.Z-beta.N` and not already current in `package.json`.
- Promote only: valid `X.Y.Z` above root `manifest.json`'s version, tag `X.Y.Z` does not exist yet,
  at least one `X.Y.Z-beta.N` tag exists and is an ancestor of `HEAD`, and no commit touching
  `plugin/`, `server/`, `core/`, `db/` landed after the latest `X.Y.Z-beta.N` tag.

**Release and promote are atomic + irreversible** (bump -> tag -> image + release). Confirm ALL
intended issues are merged to `main` *before* running them: you cannot fold more in once the tag
pushes; a late addition needs its own follow-up beta.

## SemVer guidance
- **PATCH** (`1.0.1 -> 1.0.2-beta.1 -> 1.0.2`): backward-compatible fix only.
- **MINOR** (`1.0.1 -> 1.1.0-beta.1 -> 1.1.0`): backward-compatible feature (even small).
- **MAJOR** (`1.0.1 -> 2.0.0-beta.1 -> 2.0.0`): breaking change.

## After release
- **First release only: make the GHCR package public.** The image lands in
  `ghcr.io/hrt-htk/geode` as a private package, so `docker compose` cannot pull it anonymously. In the
  package settings, change the visibility to public and link the package to the repository (its
  provenance and source then show on the package page).
- **Reload devices / cutover:** local dev vaults still run the old build until it is rebuilt and
  reinstalled, and a server keeps running its old image until it is updated (the step above). BRAT
  users get beta updates on their next plugin check. Directory users get nothing until `promote`
  ships the final `X.Y.Z` release. Accepted caveat: Obsidian does not auto-update `X.Y.Z-beta.1` to
  `X.Y.Z` on its own; BRAT users update through BRAT.
- **Release notes:** `release.yml` sets `generate_release_notes: true`, so a beta's body is
  auto-populated from merged PRs/commits since the previous tag. `promote` rewrites the final
  release's body with the notes since the previous final version.

## Gotchas
- **Tag convention:** tags are bare semver (`1.0.2-beta.1`, `1.0.2`): the community directory
  matches the release tag to `manifest.json`, so a `v` prefix would be rejected. Tags cut before #12
  keep their `v`: `scripts/promote.ts` resolves that form with `prevReleaseTag` when it generates
  notes since the previous final release.
- **A failed `release.yml` during promote:** `main` and the `X.Y.Z` tag are already pushed. Do NOT
  delete the tag: fix or rerun the failed `release.yml` jobs (`gh run rerun <run-id> --failed`), then
  finish the notes with `gh release edit X.Y.Z --prerelease=false --latest --notes-file <file>`.
- **Check the published artifacts, not the tag.** Verify with `gh release view <tag> --json
  assets,isPrerelease` (expect `main.js`/`manifest.json`/`styles.css` and `isPrerelease: true` for
  betas, `false` for finals); allow ~1-2 min lag, empty `assets` right after tag push != failure.
