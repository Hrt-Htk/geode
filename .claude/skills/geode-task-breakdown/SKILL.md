# Skill: geode-task-breakdown

Decompose any Geode project or feature into a structured, estimable set of tasks. Catches unknowns explicitly: things not yet considered, not yet mentioned, or lacking context.

## The Pipeline

Run through these steps in order. Present each step's output before moving on. Ask the user to confirm or challenge before proceeding.

### Step 1: Scope

Clarify what the project is and isn't.

- **Goal:** What does "done" look like? (Concrete deliverable)
- **Constraints:** Timeline, tools, skills, dependencies on others
- **Assumptions:** What are we assuming is true? (Flag these: they're risk sources)
- **Out of scope:** What are we explicitly NOT doing?

**Geode rules:** Check `CLAUDE.md` hard rules before scoping. Any change to FastCDC params, nonce derivation, or wire protocol is out of scope without explicit user approval.

**Catch unknowns:** Ask "What don't we know yet?" and list every gap. Examples:
- Missing specs, test fixtures, or reference materials
- Tools/software that haven't been verified as available (Deno, ADB, phone access)
- Skills or knowledge that need to be learned
- External dependencies (someone else's deliverable, a part that needs ordering)

### Step 2: WBS (Work Breakdown Structure)

Build a deliverable-oriented hierarchy: **Project → Phases → Work Packages → Tasks**.

Rules:
- **100% rule:** Children must account for ALL the parent's work. Nothing falls through.
- **Stopping rule:** Decompose until each task is 1-10 hours of work. No further.
- **Deliverable-oriented:** Each node describes *what is produced*, not just activity.
- **Issue-first:** Every task maps to a GitHub issue. If none exists, create one.

Present as a tree. After the tree, explicitly check: "Does this cover everything, or is work missing?"

### Step 3: Functional Decomposition

For software tasks: break by **function** (what does it do?) rather than just by component.

- Map inputs → outputs → sub-functions recursively
- Stop when each sub-function maps to a concrete code/test action
- Cross-reference against the WBS: do any functional requirements have no corresponding task?
- **Step gates:** Check `docs/testing/step-gates.md`: does this change touch a gate? If yes, the gate's test scenarios are tasks too.

### Step 4: Dependencies

Identify blocking relationships between tasks.

- List each task's **predecessors** (what must be done first)
- Flag **parallelizable** tasks (can run simultaneously)
- Surface **critical path** (longest chain of dependent tasks: sets minimum duration)

**Geode dependencies:**
- Logic changes → red test first (TDD), then implementation
- Sync-affecting changes → benchmark-vault convergence + hybrid E2E
- UI changes → `geode-ui` skill + screenshot loop
- See `CLAUDE.md` Definition of done table for cumulative gates

**Catch unknowns:** Are there hidden dependencies? (e.g. "need phone access for hybrid E2E")

### Step 5: T-Shirt Sizing

Quick relative effort for every task: **XS** (<1h) · **S** (1-3h) · **M** (3-8h) · **L** (8-20h) · **XL** (20h+)

This is a fast pass: no precision needed. Purpose: identify which tasks deserve detailed estimation.

### Step 6: PERT Estimation

For every **M, L, XL** task, give three estimates:

| Field | Meaning |
|-------|---------|
| **Optimistic (O)** | Best case: everything goes smoothly |
| **Most Likely (M)** | Realistic: normal friction, minor surprises |
| **Pessimistic (P)** | Worst case: things go wrong, rework, learning curve |

**Expected = (O + 4M + P) / 6**

Present as a table. After the table, sum:
- **Total expected hours** (sum of all Expected values)
- **Total optimistic hours** (best-case scenario)
- **Total pessimistic hours** (worst-case scenario)

**Catch unknowns during estimation:** For each task, ask:
- "What could make this take longer than expected?"
- "Is there a skill gap or tool gap that adds hidden time?"
- "Have you done something like this before, or is this new territory?"

**Geode estimation notes:**
- Hybrid E2E runs (desktop + phone) take 2-3x longer than FakeVault tests
- Mobile bugs often hide behind `this`-binding and Capacitor FS issues: inflate P for mobile-touching tasks
- LOC tripwires (`server/` ≤300 code lines per file, `core/` and `plugin/` ≤500) may force
  refactoring: add a "review LOC" task if a change lands close

### Step 7: GTD Next Action

For the overall project, define the **very next physical, visible action**. Not "work on X": something concrete like "open transport.ts and locate advanceCursor."

This is the action the user can take *immediately* after the session ends.

### Step 8: Review

Present the full breakdown summary and ask the user to challenge it:

1. **Completeness check:** "Is there work we missed?"
2. **Estimate sanity check:** "Do these hours feel right, or is something off?"
3. **Unknowns review:** Revisit the unknowns list: can any be resolved now? Should any become their own tasks?
4. **Risk assessment:** What are the top 2-3 things that could derail this?

## Unknowns Protocol

Unknowns are first-class citizens. Tracked throughout, reviewed at the end.

**Three categories:**

| Category | Example | Action |
|----------|---------|--------|
| **User hasn't considered it** | "Need to update step gate docs too" | Surface as new task |
| **User hasn't told me** | "Phone is Android, not iOS" | Ask explicitly |
| **I lack context** | "How long does hybrid E2E take on your setup?" | Ask: flag as uncertainty |

**Rules:**
- Maintain a running "Unknowns" list visible throughout
- At each step, actively look for gaps and add to the list
- At Review, convert resolvable unknowns into tasks
- Unresolvable unknowns become **risks** with impact note

## Output Format

### During the session (step by step)

Present each step's output clearly. Use tables and trees. Keep it scannable.

### Final summary

```
## [Project Name]: Breakdown Summary

**Goal:** [one line]
**Constraints:** [timeline, tools, Geode rules]

### Unknowns & Risks
- [unknown/risk]: [impact]: [mitigation or task to resolve]

### Task Breakdown

| # | Task | Issue | Size | O | M | P | Expected (h) | Depends on |
|---|------|-------|------|---|---|---|-------------|------------|
| 1 | ... | #NNN | M | 1 | 2 | 4 | 2.2 | - |
| 2 | ... | #NNN | S | 0.5 | 1 | 2 | 1.2 | 1 |

### Totals
- **Expected:** Xh  |  **Best case:** Yh  |  **Worst case:** Zh

### Next Action
"[Concrete physical action]"
```

## Anti-Patterns to Avoid

- **Vague tasks:** "Fix sync" → break into "Write failing test for cursor advance", "Remove transport cursorSink on receipt"
- **Over-decomposition:** Tasks smaller than 30 minutes usually don't need their own row
- **Hidden rework:** If a task might need revision, add "review/iterate" as a separate task or inflate P
- **Ignoring setup:** First-time tasks (learning a tool, setting up phone debugging) take longer: reflect in O/M/P
- **Optimism bias:** If M feels like O, push back and ask for a real M
- **Skipping gates:** A sync-affecting change without benchmark-vault + hybrid E2E is not done. Don't skip.
