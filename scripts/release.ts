#!/usr/bin/env -S deno run -A
/**
 * One-command release: bumps version, commits, tags, pushes, and deploys the server.
 * Plugin and server ship together atomically; there is no plugin-only mode.
 *
 * Usage: deno run -A scripts/release.ts X.Y.Z
 */

import { releaseHold } from "./after-merge.ts";

const args = Deno.args;
const version = args[0];

if (!version) {
  console.error("Usage: deno run -A scripts/release.ts X.Y.Z");
  Deno.exit(1);
}

// Validate semver
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid version: "${version}": must be X.Y.Z`);
  Deno.exit(1);
}

const root = Deno.cwd();

// #438: a committed RELEASE_HOLD file holds the release.
const hold = releaseHold(root);
if (hold) {
  console.error(`Release held: ${hold}: remove RELEASE_HOLD to release.`);
  Deno.exit(1);
}

// ── Preconditions ──────────────────────────────────────────────────────

// The deploy step needs GEODE_SSH_HOST. Check it here, before anything is
// bumped, committed, pushed or tagged (#699).
if (!Deno.env.get("GEODE_SSH_HOST")?.trim()) {
  console.error(
    "GEODE_SSH_HOST is not set. Put it in .env.local at the repo root (see .env.example) " +
      "and run the release with `deno task release X.Y.Z`, which loads that file.",
  );
  Deno.exit(1);
}

// Must be on main
const branch = await runGit(["branch", "--show-current"]);
if (branch.trim() !== "main") {
  console.error(`Must be on branch "main", currently on "${branch.trim()}"`);
  Deno.exit(1);
}

// Working tree must be clean
const status = await runGit(["status", "--porcelain"]);
if (status.trim()) {
  console.error("Working tree is not clean. Commit or stash changes first.");
  Deno.exit(1);
}

// Version must not already be current
const pkg = JSON.parse(await Deno.readTextFile(`${root}/package.json`)) as { version: string };
if (pkg.version === version) {
  console.error(`Version ${version} is already the current version.`);
  Deno.exit(1);
}

// ── Step 1: Bump versions ──────────────────────────────────────────────

console.log(`[1/5] Bumping version to ${version}...`);

// Read minAppVersion from manifest.json
const manifestPath = `${root}/plugin/manifest/manifest.json`;
const manifest = JSON.parse(await Deno.readTextFile(manifestPath)) as {
  version: string;
  minAppVersion: string;
};
const minAppVersion = manifest.minAppVersion;

// Bump package.json
const pkgPath = `${root}/package.json`;
const pkgData = JSON.parse(await Deno.readTextFile(pkgPath));
pkgData.version = version;
await Deno.writeTextFile(pkgPath, JSON.stringify(pkgData, null, 2) + "\n");

// Bump manifest.json
manifest.version = version;
await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// Add entry to versions.json (never edit existing entries)
const versionsPath = `${root}/plugin/manifest/versions.json`;
const versions = JSON.parse(await Deno.readTextFile(versionsPath)) as Record<string, string>;
versions[version] = minAppVersion;
await Deno.writeTextFile(versionsPath, JSON.stringify(versions, null, 2) + "\n");

console.log(`  package.json: ${version}`);
console.log(`  manifest.json: ${version}`);
console.log(`  versions.json: added ${version} -> ${minAppVersion}`);

// ── Step 2: Commit ─────────────────────────────────────────────────────

console.log("[2/5] Committing...");
await runGit(["add", pkgPath, manifestPath, versionsPath]);
await runGit(["commit", "-m", `chore(release): v${version}`]);

// ── Step 3: Push ───────────────────────────────────────────────────────

console.log("[3/5] Pushing to origin main...");
await runGit(["push", "origin", "main"]);

// ── Step 4: Tag + push ─────────────────────────────────────────────────

console.log("[4/5] Tagging and pushing v" + version + "...");
const tag = `v${version}`;
await runGit(["tag", tag]);
await runGit(["push", "origin", tag]);
console.log(`  Tag ${tag} pushed: release.yml workflow will publish BRAT release.`);

// ── Step 5: Deploy server ──────────────────────────────────────────────

console.log("[5/5] Deploying server...");
// #731: the v* tag for this version is already pushed, so deploy.sh cannot tell
// from git which tag this release replaces. Hand it the one being replaced.
const deployCmd = new Deno.Command("bash", {
  args: [`${root}/deploy/deploy.sh`],
  cwd: root,
  env: { GEODE_PREV_TAG: `v${pkg.version}` },
});
const deployOutput = await deployCmd.output();
console.log(new TextDecoder().decode(deployOutput.stdout));
if (deployOutput.stderr.length > 0) {
  await Deno.stderr.write(deployOutput.stderr);
}
if (!deployOutput.success) {
  console.error(`Deploy failed with exit code ${deployOutput.code}`);
  Deno.exit(1);
}
console.log("Server deploy complete.");

console.log(`\nRelease v${version} done!`);

// ── Helpers ─────────────────────────────────────────────────────────────

async function runGit(args: string[]): Promise<string> {
  const cmd = new Deno.Command("git", { args, cwd: root });
  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);
  if (output.code !== 0) {
    const stderr = new TextDecoder().decode(output.stderr);
    console.error(`git ${args.join(" ")} failed: ${stderr}`);
    Deno.exit(1);
  }
  return stdout;
}
