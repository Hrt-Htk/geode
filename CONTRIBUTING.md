# Contributing

Geode syncs Obsidian vaults through a server you run yourself. See `README.md` for what it does and how
to install it.

## Open an issue first

Start with an issue, whether it is a bug report, a feature idea or a question, so we can discuss the
change before any code is written. The templates live in `.github/ISSUE_TEMPLATE/`.

- Feature requests: describe what you want and why. The maintainer decides whether it fits the project.
- Bug reports: include the steps to reproduce, the behavior you expected and what actually happened.

If the maintainer decides to go ahead, they will invite a pull request.

## Before you write code

- `docs/ops/dev-setup.md`: toolchain versions, setup, dev loop and troubleshooting.
- `docs/dev/workflow.md`: issue, branch, commit and PR rules, plus the CI checks that enforce them.
- `CLAUDE.md`: the development spec, including the hard rules and the definition of done.

You need `git`, `deno` and Node 22 to build and test, and Obsidian to run the desktop E2E. A green
`deno task ci` before every push is the local gate; nothing else is required. The rest of the tooling
`CLAUDE.md` names (Paseo agents, a phone and tablet, a real vault, a production server) is the
maintainer's own setup. A gate that needs one of those still has to pass before merge: say so in the PR
and the maintainer runs it. See "Optional local tooling" in `CLAUDE.md`.

## Tests

New behavior starts with a test that fails before the change. `docs/dev/workflow.md` has the TDD rules
and their exceptions.

## What CI enforces

`docs/dev/workflow.md` § Enforcement has the full list and `CLAUDE.md` § 3 Done the gate table. The
hard rules, each read from `.github/workflows/` and the scripts it runs:

- **Commit format.** Every non-merge commit subject must match
  `^(feat|fix|chore|docs|refactor|test|perf|build|ci|style)(\(.+\))?: .+` (`.github/workflows/ci.yml`).
- **Branch name.** On a push, the branch must match
  `^(feat|fix|chore|docs|refactor|test|perf|ci|build|style)/issue[0-9]+-.*`.
- **Issue reference.** A commit message or the PR body must contain `#[0-9]+`. A range whose every
  non-merge commit is `chore(release)` is exempt.
- **Gate evidence.** Tick in the PR body (`.github/pull_request_template.md`) every gate the changed
  paths require, using the exact labels, or the `Gate evidence` job fails. `Review pass` is always
  required. `plugin/sync/` and the reconciler, merge, apply, commit and chunker code add
  `Benchmark vault convergence`, `Two-vault scenarios` and `Hybrid phone E2E`; adapter, state and mobile
  paths add `On-device run`; `plugin/ui/` and `styles.css` add `Before/after screenshots`.
- **Docs drift.** A changed file whose `covers:` doc did not change in the same PR fails `Gate evidence`.
  Update the doc, or put one line in the PR body: `docs: unaffected - <reason>`.
- **Clean tree.** The build and the tests must leave `git status` empty.
- **Secret scan.** gitleaks runs over the commits a PR adds.
- **Draft PRs run no job.** Run `deno task ci` yourself until the PR is ready.

Only the maintainer's own PRs from this repo auto-merge; a PR from a fork is reviewed and merged by
hand.

## License

Geode is licensed under Apache-2.0 (`LICENSE`).
