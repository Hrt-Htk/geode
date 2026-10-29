---
covers: [.github/workflows/*.yml, .github/pull_request_template.md, scripts/standards.ts, scripts/check-docs.ts, scripts/check-gate-evidence.ts, scripts/docs-drift.ts, scripts/check-loc.ts, scripts/repo-health.ts, scripts/check-private.ts, scripts/check-dashes.ts, scripts/css-syntax.ts, .claude/hooks/commit-gate.mjs]
watches: [test/unit/scripts/**]
---

# Development workflow

Rules for issues, branches, commits and PRs. `CLAUDE.md` states the same gates for agent work and is
the place to start; this doc is the process reference, and the scripts and workflows it names are the
enforcement.

## Clean working tree

`git status` must be clean before you start work. If it is not, commit, stash or discard the changes
first, so every change you make belongs to the current task.

Scratch files (`tmp/`, `.pi/`, screenshots, build leftovers) are gitignored and never show as dirty. If
`git status` reports noise that is not work, add it to `.gitignore`.

## TDD (test-driven development)

For a new feature or a bug fix, write the test before the implementation:

1. Red: write a test for the behavior you want. It must fail.
2. Green: write the minimum code that makes it pass.
3. Refactor: clean up while the test stays green.

A test that passes on the first run has not shown that it checks anything. A typical commit sequence
for one feature:

```
test: add failing test for X
feat: implement X to pass the test
refactor: clean up X (optional)
```

TDD does not apply to:

- documentation changes (`docs`)
- config or env changes (`chore`)
- small UI fixes (an icon, a dead button)
- dependency bumps with no behavioral impact

## Issue rules

- Every issue needs at least one label (`bug`, `enhancement`, `docs`, `chore`, and so on).
- No open issue describing the change means no work. Ask the maintainer rather than filing your own.
  File one on the project board only when the maintainer asks for it. The issue holds the "why".
- One issue, one PR. Do not bundle unrelated changes; if a fix turns up a new problem, file an issue
  and handle it separately.
- Issue lifecycle: `open`, then in progress when work starts, then linked to a PR, then closed after the
  PR merges. Never close an issue before its PR merges.

## Commit rules

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope): description

[optional body]

Closes #N
```

### Types

| Type | When to use |
| --- | --- |
| `feat` | New feature or user-visible capability |
| `fix` | Bug fix |
| `docs` | Documentation changes only |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `style` | Formatting, whitespace, UI styling, no behavior change |
| `test` | Adding or updating tests |
| `chore` | Build, tooling, dependency or maintenance changes |
| `perf` | Performance improvement |
| `build` | Changes to the build system or external dependencies |
| `ci` | CI/CD configuration changes |

### Footer

Link the issue in the commit footer so `git log` traces back to the discussion:

```
Closes #29
```

`Closes` goes on the final commit that completes the issue. `Refs` goes on intermediate commits.

## Branch rules

Name branches `type/issueN-description`:

```
feat/issue29-workflow-docs
fix/issue11-empty-chevron
chore/issue15-update-readme
refactor/issue42-simplify-worker
ci/issue377-enforce-standards
```

- `type` is one of the commit types above
- `issueN` is the GitHub issue number
- `description` is a short kebab-case summary

## PR rules

- Fill in every checklist item in the PR template, including the gate evidence checkboxes.
- Reference an open issue in the PR body or in a commit message.
- Follow conventional commit format. CI checks commit messages; the PR title is a convention, and
  auto-ship merges with a merge commit, so the commits keep their messages.
- Open the PR as a draft while anything is still owed, and mark it ready when the gates and the review
  pass are done. Auto-ship merges ready PRs only, and only the maintainer's own PRs from this repo.
  A PR from a fork or another author is never auto-merged: the maintainer reviews and merges it by
  hand.

## Size limits

| Limit | Value | When it applies |
| --- | --- | --- |
| Files | 10 (soft cap) | Per PR |
| Lines | 300 (soft cap) | Per PR (added plus deleted) |

These are warnings, not failures. If a PR needs more, explain why in the PR body.

## Enforcement

### Hard failures (block the PR)

The `workflow-checks` CI job enforces:

- Conventional commit format: every commit message must match
  `^(feat|fix|chore|docs|refactor|test|perf|build|ci|style)(\(.+\))?: .+`
- Branch naming: on a push other than `main`, the branch must match
  `^(feat|fix|chore|docs|refactor|test|perf|ci|build|style)/issue[0-9]+-.*`
- Issue reference: a commit message or the PR body must contain `#[0-9]+`

The `Deno checks` job installs the tree, type-checks `server/main.ts` and `core/*.ts`, builds the
plugin, runs `deno task standards` (#377) and then `deno task test:ci`, and fails if the build or the
tests leave the working tree dirty (#416). `deno task standards` covers `deno fmt --check` over the
code (`*.ts`, `*.mjs`, `*.json` from `git ls-files`; markdown is never formatted, because the
formatter reflows prose and the docs are wrapped by hand), `deno lint` (including `test/`),
the plugin `tsc` pass, ESLint, unused exports, duplication, CSS syntax, random test ports, test file
names, the docs gate (dead paths, broken links, missing `deno task`s, orphan docs, `covers:`/`watches:`
globs), the private-data gate (personal values in tracked files, plus anything the untracked file
`GEODE_PRIVATE_DENYLIST` names), the dash gate (`scripts/check-dashes.ts`: no U+2014 or U+2013 in a
tracked file, the vendored `.claude/skills/obsidian/` tree excepted) and the LOC tripwires. Every
check ratchets against a shrink-only baseline in `scripts/standards.ts`: a new rule lands clean or
with a hand-written, shrink-only baseline, and a baseline is never raised. Fix the code instead.

The `Gate evidence` job runs `scripts/check-gate-evidence.ts` (#377). The PR body must tick every gate
its changed files require, and must not leave docs drift (#646).

The `Secret scan` job runs gitleaks over the commits a PR adds, with redacted output.

### When CI runs

CI runs no job on a draft PR: the local `deno task ci` before every push is the gate there. Marking
a PR ready runs CI once; a new commit or a body edit on a ready PR runs it again, in full. A newer run
for the same PR cancels the older one; pushes to `main` always run to the end.

### Runner

Every job runs on `${{ vars.GEODE_RUNNER || 'ubuntu-latest' }}`. While the repo is private, the repo
variable `GEODE_RUNNER=self-hosted` sends jobs to three self-hosted runners on the maintainer's machine,
so CI uses no Actions minutes and PRs do not queue behind each other. Each runs as a user service:
`systemctl --user status actions-runner actions-runner-2 actions-runner-3` (install dirs
`~/actions-runner`, `~/actions-runner-2`, `~/actions-runner-3`). Parallel jobs are safe because tests
bind OS-assigned ports (`test/helpers/port.ts`). A public repo must not set the variable: a self-hosted
runner would execute code from outside pull requests.

### Local board variable

`GEODE_BOARD` (the project board node id) is local only, in `.env.local`: the Actions token cannot
reach a user-owned board, so `after-merge` moves closed items to Done. Unset, the board step is
skipped, so a fork or a fresh repo runs without it.

### Soft warnings (printed, not failed)

`git diff --shortstat` over more than 10 files or 300 changed lines prints a warning.

### Local commit hook

`.claude/hooks/commit-gate.mjs` is a Claude Code `PreToolUse` hook that blocks a `git commit` on three
deterministic rules before CI sees them: the Rule 5 LOC tripwire (it runs `scripts/check-loc.ts`, so it
counts code lines, not raw lines), the `console.log` ban outside `*/log.ts`, and a `plugin/ui/` or
`plugin/manifest/styles.css` change with no PNG under the main checkout's `tmp/review/` newer than 30
minutes (`GEODE_SKIP_UI_GATE=1` overrides). `.claude/hooks/branch-guard.mjs` blocks an edit to
`server/`, `core/`, `plugin/`, `db/` or `test/` while the branch is `main`. Both are agent convenience
only: without Claude Code they never run, and CI is the enforcement.

## Docs drift

Every doc under `docs/` declares the code it attests in its frontmatter, under one of two keys:

```
---
covers: [server/*.ts, db/migrations/*.sql, deploy/*]
watches: [test/scenarios/**]
---
```

`covers:` is hard: it is the code the doc attests. `watches:` is advisory: code the doc describes but
does not attest, mostly test suites. Globs use `*` inside one segment and `**` across segments;
`covers: []` is for a summary, design, research or exploration doc, which holds history rather than
attestation. Before editing code, read the doc whose `covers:` matches it.

A changed file matched by a doc's `covers:`, where none of those docs changed too, is drift (`*.md` is
skipped, since prose attests code and is never covered). The report prints a line of this form:

```
docs drift: core/chunker.ts changed, covered by docs/crypto/encryption-chunking.md (not touched in this branch)
Update the doc, or add "docs: unaffected - <reason>" to the PR body.
```

A file that only a `watches:` glob matches prints instead, and fails nothing. The line takes this form:

```
docs check: test/scenarios/sync/basic-sync.test.ts changed, see docs/testing/step-gates.md
```

Production code, test configuration (Playwright config, global setup, env loading, the vault
interlock) and the step-gate specs (`test/e2e/scenarios/gate*.spec.ts`) are `covers:`. Test helpers,
fixtures, the two-vault driver, the fuzz engine, `deno.json` and every other test file a doc describes
are `watches:`, so a routine test or helper change never needs an opt-out.

- `deno task docs:drift` prints the same report locally. It is warn-only, and it also runs at the end
  of `deno task ci` and from the `commit-gate` hook on `git commit`, `git push` and `gh pr create`.
- `Gate evidence` fails on drift. The only opt-out is one line in the PR body: `docs: unaffected -
  <reason>`, with a non-empty reason. That line is the claim under review: this change does not
  invalidate the doc.
- Uncovered: changed code (markdown is never covered) that no doc's `covers:` or `watches:` matches is
  listed separately, as information. It surfaces code no doc describes. Add a doc with `covers:`
  rather than widening an unrelated one.

The docs gate rejects a doc with no `covers:`, a `covers:` or `watches:` that is not one inline
`[ ... ]` list, and a glob that matches no path.

## Exceptions

The only change that skips the issue requirement is a release bump: if every non-merge commit in the
range is a `chore(release)` commit, CI does not ask for an issue reference. Every other change,
including a typo fix, needs `#[0-9]+` in a commit message or the PR body.

Use a conventional commit type on every change, and keep unrelated cleanup in its own PR.
