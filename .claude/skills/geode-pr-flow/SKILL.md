---
name: geode-pr-flow
description: >
  Ship a Geode change: branch → PR → CI → ready → merge → prune → release: project-scoped to the
  Geode repo (github.com/Hrt-Htk/geode). Use when opening a PR, merging one, or cleaning up branches.
  Bakes in the base-branch rule (base is ALWAYS `main`) and the draft-until-gated convention.
---

# Geode ship flow

Repo: `github.com/Hrt-Htk/geode`. Merge convention is a merge commit. The single ship checklist:
**branch → PR → CI + gate evidence → ready → merge → prune → local release (when chosen).**

## Base branch: base is ALWAYS `main`
The default branch is **`main`** (canonical, NESTED layout: `core/`, `plugin/sync/`). Every PR targets
it. Verify before opening a PR:
```
git rev-list --count origin/main..HEAD                 # small = correct base
git diff --stat origin/main..HEAD | tail -1            # a few files, not hundreds
```
If the diff against your base is huge (thousands of lines / hundreds of files), you picked the wrong
base branch.

## Pre-flight (before any source edit: CLAUDE.md)
1. `git status` clean. 2. branch matches `type/issueN-description`. 3. an open issue covers it.

## Ship checklist
1. **Local gates**: `deno task ci` green; the Done-table gates for the change class (benchmark vault /
   hybrid phone E2E / screenshots) with evidence captured; review pass done (skill `geode-review-loop`).
   After a rebase or conflict merge, earlier evidence is void: rebuild, rerun standards and the affected
   E2E, reread the screenshots. Resolve conflicts by editing, never by deleting markers with `sed`,
   because a spliced file can pass every test.
2. **Open a draft PR** against `main`, referencing the issue:
   ```
   git push -u origin <branch>
   gh pr create --base main --head <branch> --title "type(scope): ... (#N)" --body-file tmp/pr-body.md
   ```
   Draft it while anything is owed (a Done gate, the review pass, a follow-up issue): don't fake a
   gate, leave it draft and state what's outstanding. Nothing owed → open it ready directly
   (`gh pr create` without `--draft`). Tick the PR body's gate-evidence checkboxes (the `Gate evidence`
   job fails until each required one is ticked). Multi-line messages via file: `gh ... --body-file <file>`,
   `git commit -F <file>` (inline `-m` mangles backticks/`${}`).
   The same job fails on docs drift: a changed file whose `covers:` doc did not change needs either the
   doc updated in this PR (`deno task docs:drift` names it) or a `docs: unaffected - <reason>` line in
   the body.
3. **CI**: `gh pr checks N`: Workflow Checks (commit format / branch / issue), Deno checks
   (`deno task standards`), Gate evidence. All must be green. Editing the PR body starts a new CI run
   and cancels the old one: rerun the NEW run (`gh run rerun <new> --failed`, plus `--job <gate>` so
   Gate evidence reads the new body).
4. **Ready → merge by hand**: once nothing is owed, `gh pr ready N`. CI re-runs on
   `ready_for_review`. Once CI is green, the maintainer merges (`gh pr merge N --merge --delete-branch`),
   or an agent does on the maintainer's explicit go. Ready does not merge itself.
5. **After-merge (local)**: `deno task after-merge` from `main`: prunes gone local branches
   (`git branch -d` only, never `-D`) and sets Status=Done on closed board items. It does not release:
   cut a beta (`deno task release X.Y.Z-beta.N`) or final (`deno task promote X.Y.Z`) release by hand
   per skill `geode-release`. A tag push publishes to ALL BRAT or directory vaults: treat it as
   irreversible/outward.
