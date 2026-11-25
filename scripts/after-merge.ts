#!/usr/bin/env -S deno run -A
/**
 * After a merge: prune gone local branches, move closed board items to Done,
 * and cut a release per the #393 rule.
 * Local counterpart of the online auto-ship.yml. Runs on `main` with a clean tree; `--dry-run` prints every
 * action and the release decision without changing anything.
 *
 * Usage: deno run -A scripts/after-merge.ts [--dry-run]
 */

const root = Deno.cwd();
const dry = Deno.args.includes("--dry-run");

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
}
