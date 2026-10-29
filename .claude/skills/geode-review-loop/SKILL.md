---
name: geode-review-loop
description: >
  Run the Geode review loop: worker → reviewer → lean-code-reviewer → lean-simplifier as Paseo pi agents,
  before any PR leaves draft, and post findings on the PR. Use for a non-trivial diff's correctness review,
  the lean pass, or before flipping a draft PR to ready. Fallback: native /code-review.
---

# Geode review loop

Every non-trivial change runs the full loop before a PR leaves draft. Personas are committed under
`.agents/personas/` (`worker.md`, `reviewer.md`, `lean-code-reviewer.md`, `lean-simplifier.md`) and
run as Paseo pi agents. Small in-context diffs may be reviewed inline instead. Fallback when a
persona's output is unreliable: native `/code-review`. **Never flip a PR draft→ready without the
review pass.**

## Loop

1. **worker**: implements against a red test. Hand it a real chunk, not line-edits.
2. **reviewer**: correctness pass (checklist below). Blocks on any real bug.
3. **lean-code-reviewer**: read-only Rule 5 pass (abstraction-used-once, dead code, duplication,
   over-engineering).
4. **lean-simplifier**: applies the lean findings; smallest change, behavior unchanged.

## Reviewer checklist

Check each diff against the recurring high-severity classes a sweep finds:

- Every new or changed vault-scoped route and SQL statement is scoped to the authenticated vault.
- Map/registry cleanup keyed by id removes the same entry it added (unregister only if
  `connections.get(id) === conn`).
- Every retention/GC set covers every table that references blobs (including trashed heads).
- Every fire-and-forget async is caught; every batch has try/finally.
- Replies are matched by id, never by order.
- Rule 7: a device can never overwrite per-vault KDF params or the verifier.
- Rule 6 / merge: every merge outcome either writes to disk or commits: nothing left on one side only.
- Rules 1-3: chunking, nonce derivation, wire protocol untouched, or `protocol_version` bumped.

## Periodic sweeps

A sweep is a read-only audit, separate from the per-PR loop and run on the maintainer's cadence. Apply
the five questions to `git diff <last sweep-YYYY-MM tag>..HEAD`: **Used? · Needed? · Correct? · Right
home? · House rules**, and rate each finding H (data loss / security boundary / crash) / M (latent bug
or rule breach) / L (cleanup). No fixes during the sweep: output is a report plus issues. Tag each
sweep point `sweep-YYYY-MM`.

- **Every new H finding becomes either a script check** (`deno task standards`) **or a reviewer
  checklist item above.** A finding that stays prose will be re-found.
- The sweep's main input is the repo-health report (`deno task health`): review candidates plus
  the top files by 90-day churn. Every review candidate gets a verdict: **split** (with an issue) or **keep** (with
  the reason).
- **`server/` gets a full audit quarterly**: it is small and it is the security boundary.
- If two sweeps in a row find no H, sweep less often.

## Output

Post findings on the PR (`gh pr comment N --body-file <file>`). Once every blocking finding is
resolved, post a final comment ending with the literal marker line:

```
Review pass: done
```

Tick the PR body's `Review pass` checkbox too: the `Gate evidence` CI job reads the body, not
comments, and fails the PR until it is ticked.
