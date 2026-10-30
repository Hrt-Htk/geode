#!/usr/bin/env -S deno run -A
/**
 * After a merge: prune gone local branches, move closed board items to Done,
 * and cut a release per the #393 rule.
 * Local counterpart of the online auto-ship.yml. Runs on `main` with a clean tree; `--dry-run` prints every
 * action and the release decision without changing anything.
 *
 * Usage: deno run -A scripts/after-merge.ts [--dry-run]
 */

const SHIPPED = ["plugin", "server", "core", "db"];
const root = Deno.cwd();
const dry = Deno.args.includes("--dry-run");

const TYPE = /^(\w+)(\(.+\))?(!)?:/;

// Map the subjects of commits since the last tag (already filtered to shipped
// paths by the caller) to the next version, or null for "no release".
// feat or a `!` breaking change -> MINOR (pre-1.0: breaking counts as MINOR),
// else fix/perf -> PATCH, else null. Only a Conventional Commit type prefix
// counts: a subject merely containing "fix" doesn't.
export function nextVersion(current: string, subjects: string[]): string | null {
  const [major, minor, patch] = current.split(".").map(Number);
  let wantPatch = false;
  for (const s of subjects) {
    const m = s.match(TYPE);
    if (!m) continue;
    const [, type, , bang] = m;
    if (type === "feat" || bang) return `${major}.${minor + 1}.0`;
    if (type === "fix" || type === "perf") wantPatch = true;
  }
  return wantPatch ? `${major}.${minor}.${patch + 1}` : null;
}

// #12: releases are tagged with the bare manifest version, so the community
// directory can match tag to manifest. Tags cut before #12 keep their `v`, so
// resolving the tag a release replaces has to try both forms.
export function prevReleaseTag(version: string, tags: string[]): string | null {
  return tags.find((t) => t === version || t === `v${version}`) ?? null;
}

// Project board node id; the board step is skipped when unset. The Status field
// and its "Done" option are looked up by name.
const PROJECT = Deno.env.get("GEODE_BOARD")?.trim();
const STATUS_QUERY = `query($id: ID!) { node(id: $id) { ... on ProjectV2 {
  field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } } } }`;
const BOARD_QUERY = `query($id: ID!, $endCursor: String) { node(id: $id) { ... on ProjectV2 {
  items(first: 100, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { id
    fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    content { ... on Issue { state } ... on PullRequest { state } } } } } } }`;

type BoardItem = {
  id: string;
  content: { state?: string };
  fieldValueByName: { name: string } | null;
};

// auto-ship closes issues with github.token, which never fires the board's
// "Item closed → Done" workflow (#413): pick the closed/merged items it missed.
export function staleBoardItems(items: BoardItem[]): string[] {
  return items
    .filter((i) =>
      (i.content.state === "CLOSED" || i.content.state === "MERGED") &&
      i.fieldValueByName?.name !== "Done"
    )
    .map((i) => i.id);
}

// #438: a committed RELEASE_HOLD file holds the release: the trimmed content
// is the reason, null when the file is absent.
export function releaseHold(root: string): string | null {
  try {
    return Deno.readTextFileSync(`${root}/RELEASE_HOLD`).trim();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

async function run(cmd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command(cmd, {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  if (out.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")}: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
  return stdout;
}

const git = (args: string[]) => run("git", args);
const gh = (args: string[]) => run("gh", args);

const act = (msg: string) => console.log(dry ? `[dry-run] ${msg}` : msg);

if (import.meta.main) {
  // Step 1: preconditions.
  const branch = await git(["branch", "--show-current"]);
  if (branch !== "main") {
    console.error(`after-merge runs on main only: currently on "${branch}".`);
    Deno.exit(1);
  }
  if (await git(["status", "--porcelain"])) {
    console.error("after-merge needs a clean working tree: commit or stash first.");
    Deno.exit(1);
  }

  // Step 2: fetch + fast-forward main.
  act("git fetch --prune");
  if (!dry) await git(["fetch", "--prune"]);
  act("fast-forward main to origin/main (git merge --ff-only origin/main)");
  if (!dry) await git(["merge", "--ff-only", "origin/main"]);
  // Drop registrations of worktrees whose directory Paseo already removed,
  // or `git branch -d` refuses their branch as "used by worktree".
  act("git worktree prune");
  if (!dry) await git(["worktree", "prune"]);

  // Step 3: delete gone local branches, `git branch -d` only: report refusals.
  const refs = await git([
    "for-each-ref",
    "--format=%(refname:short) %(upstream:track)",
    "refs/heads",
  ]);
  const gone = refs
    .split("\n")
    .filter((l) => /\[gone\]$/.test(l.trim()))
    .map((l) => l.trim().split(/\s+/)[0]);
  if (!gone.length) {
    console.log("No gone branches to prune.");
  }
  for (const b of gone) {
    act(`git branch -d ${b}`);
    if (!dry) {
      try {
        await git(["branch", "-d", b]);
        console.log(`Deleted ${b}.`);
      } catch (e) {
        console.error(`Refused to delete ${b}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // Step 4: move closed board items to Done.
  if (!PROJECT) console.log("GEODE_BOARD is unset: skipping the board step.");
  else {
    const [field, done] = (await gh([
      "api",
      "graphql",
      "-f",
      `query=${STATUS_QUERY}`,
      "-f",
      `id=${PROJECT}`,
      "--jq",
      '.data.node.field | .id, (.options[] | select(.name == "Done") | .id)',
    ])).split("\n");
    if (!field || !done) throw new Error('GEODE_BOARD has no Status field with a "Done" option.');
    const board = await gh([
      "api",
      "graphql",
      "--paginate",
      "-f",
      `query=${BOARD_QUERY}`,
      "-f",
      `id=${PROJECT}`,
      "--jq",
      ".data.node.items.nodes[]",
    ]);
    const stale = staleBoardItems(board.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    if (!stale.length) console.log("No closed board items to move to Done.");
    for (const id of stale) {
      act(`board item ${id} -> Done`);
      if (!dry) {
        await gh([
          "project",
          "item-edit",
          "--project-id",
          PROJECT,
          "--id",
          id,
          "--field-id",
          field,
          "--single-select-option-id",
          done,
        ]);
      }
    }
  }

  // Step 5: release decision per #393: a committed RELEASE_HOLD file skips it.
  const hold = releaseHold(root);
  if (hold) {
    console.log(`Release held: ${hold}`);
  } else {
    const tag = await git(["describe", "--tags", "--abbrev=0"]);
    const subjects = (await git([
      "log",
      `${tag}..HEAD`,
      "--no-merges",
      "--format=%s",
      "--",
      ...SHIPPED,
    ]))
      .split("\n")
      .filter(Boolean);
    const pkg = JSON.parse(await Deno.readTextFile(`${root}/package.json`)) as { version: string };
    const next = nextVersion(pkg.version, subjects);
    if (next) {
      act(
        `release due: ${pkg.version} -> ${next}: invoke deno run -A --env-file=.env.local scripts/release.ts ${next}`,
      );
      if (!dry) {
        const release = new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", "--env-file=.env.local", "scripts/release.ts", next],
          cwd: root,
          stdout: "inherit",
          stderr: "inherit",
        });
        const st = await release.output();
        if (st.code !== 0) Deno.exit(st.code);
      }
    } else {
      console.log(
        `No release: ${subjects.length} commits since ${tag} touch shipped code, none warrant one.`,
      );
    }
  }
}
