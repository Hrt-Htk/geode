#!/usr/bin/env -S deno run -A
/**
 * Promote a tested pre-release to the community directory (#22): point the root
 * manifest.json and versions.json on main at that exact build, clear its
 * pre-release flag, mark it latest, and rewrite its notes to cover every change
 * since the previously promoted version. No rebuild, no server deploy.
 *
 * Also moves the image's `latest` tag onto that build (#65): a release tags `beta`,
 * never `latest`, so directory users only ever pull a promoted image.
 *
 * Usage: deno run -A scripts/promote.ts X.Y.Z
 */

import { prevReleaseTag, releaseHold } from "./after-merge.ts";

const version = Deno.args[0];
if (!version) {
  console.error("Usage: deno run -A scripts/promote.ts X.Y.Z");
  Deno.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid version: "${version}": must be X.Y.Z`);
  Deno.exit(1);
}

const root = Deno.cwd();

const hold = releaseHold(root);
if (hold) {
  console.error(`Release held: ${hold}: remove RELEASE_HOLD to promote.`);
  Deno.exit(1);
}

// ── Preconditions: nothing is written or pushed until all of them pass ──

const branch = await run("git", ["branch", "--show-current"]);
if (branch !== "main") {
  console.error(`Must be on branch "main", currently on "${branch}"`);
  Deno.exit(1);
}

if (await run("git", ["status", "--porcelain"])) {
  console.error("Working tree is not clean. Commit or stash changes first.");
  Deno.exit(1);
}

const manifestPath = `${root}/manifest.json`;
const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as {
  version: string;
  minAppVersion: string;
};
const promoted = manifest.version;

const [major, minor, patch] = promoted.split(".").map(Number);
const [nextMajor, nextMinor, nextPatch] = version.split(".").map(Number);
const above = nextMajor !== major
  ? nextMajor > major
  : nextMinor !== minor
  ? nextMinor > minor
  : nextPatch > patch;
if (!above) {
  console.error(`${version} is not above the promoted ${promoted}: nothing to promote.`);
  Deno.exit(1);
}

const release = JSON.parse(
  await run("gh", ["release", "view", version, "--json", "isPrerelease"]),
) as { isPrerelease: boolean };
if (!release.isPrerelease) {
  console.error(
    `Release ${version} is not a pre-release: only a beta that shipped to testers is promoted.`,
  );
  Deno.exit(1);
}

// ── Step 1: Notes for every change since the previously promoted version ──

console.log(`[1/5] Generating notes since ${promoted}...`);
// The previously promoted version's tag may predate #12 and carry a `v`.
const tags = (await run("git", ["tag", "--list"])).split("\n").filter(Boolean);
const previous = prevReleaseTag(promoted, tags);
const notes = await run("gh", [
  "api",
  "repos/{owner}/{repo}/releases/generate-notes",
  "-f",
  `tag_name=${version}`,
  ...(previous ? ["-f", `previous_tag_name=${previous}`] : []),
  "--jq",
  ".body",
]);
console.log(`  notes since ${previous ?? "the previous release"}`);

// ── Step 2: Move `latest` onto that build's image, before main moves ──────

// Before the manifest commit on purpose: the directory reads main, and it must never
// offer a plugin whose server image has not caught up (a protocol bump would stop sync).
console.log(`[2/5] Retagging the image latest onto ${version}...`);
await retagImageLatest(version);

// ── Step 3: Point the root manifest and versions.json at the release ──────

console.log(`[3/5] Promoting ${version} in manifest.json and versions.json...`);
manifest.version = version;
await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
const versionsPath = `${root}/versions.json`;
const versions = JSON.parse(await Deno.readTextFile(versionsPath)) as Record<string, string>;
versions[version] = manifest.minAppVersion;
await Deno.writeTextFile(versionsPath, JSON.stringify(versions, null, 2) + "\n");
console.log(`  versions.json: added ${version} -> ${manifest.minAppVersion}`);

// ── Step 4: Commit and push main ──────────────────────────────────────────

console.log("[4/5] Committing and pushing to origin main...");
await run("git", ["add", manifestPath, versionsPath]);
await run("git", ["commit", "-m", `chore(release): promote ${version}`]);
await run("git", ["push", "origin", "main"]);

// ── Step 5: Clear the pre-release flag, mark it latest, set the notes ─────

console.log(`[5/5] Clearing the pre-release flag on ${version}...`);
await run("gh", [
  "release",
  "edit",
  version,
  "--prerelease=false",
  "--latest",
  "--notes",
  notes,
]);

console.log(`\nPromoted ${version}: the community directory serves it from the next index.`);

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * `release.yml` tags a release `X.Y.Z` and `beta`, never `latest` (#65). The tag moves
 * here, through `promote-image.yml`, because that job holds `packages: write` and the
 * retag is one registry call: `imagetools create` copies the released index, so `latest`
 * resolves to the digest `release.yml` already attested.
 */
async function retagImageLatest(version: string): Promise<void> {
  // promote-image.yml names its run after the version (`run-name`), and a rerun must watch
  // its own run: `gh run list` is newest-first, and the first poll can still predate the
  // dispatch, so an earlier run of the same name is the one it would find. Run ids grow
  // with time, so only an id above the newest existing one counts.
  const name = `Promote image ${version}`;
  const before = Math.max(0, ...(await actionRuns()).map((r) => r.databaseId));
  await run("gh", ["workflow", "run", "promote-image.yml", "-f", `version=${version}`]);
  let runId = "";
  for (let attempt = 0; attempt < 30 && !runId; attempt++) {
    const fresh = (await actionRuns()).find((r) => r.name === name && r.databaseId > before);
    runId = fresh ? String(fresh.databaseId) : "";
    if (!runId) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!runId) {
    throw new Error(
      `No new promote-image run named "${name}" appeared within 60s. The dispatched run may ` +
        `still retag latest: gh run list --workflow=promote-image.yml shows it, and this ` +
        `promote can be rerun once it finished. main and manifest.json are untouched.`,
    );
  }
  const out = await new Deno.Command("gh", {
    args: ["run", "watch", runId, "--exit-status"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `promote-image run ${runId} did not succeed (gh run view ${runId} --log-failed):\n` +
        new TextDecoder().decode(out.stderr).trim(),
    );
  }
}

type ActionRun = { databaseId: number; name: string };

async function actionRuns(): Promise<ActionRun[]> {
  return JSON.parse(
    await run("gh", [
      "run",
      "list",
      "--workflow=promote-image.yml",
      "--limit",
      "20",
      "--json",
      "databaseId,name",
    ]),
  );
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
