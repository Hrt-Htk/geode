#!/usr/bin/env -S deno run -A
/**
 * Promote a tested beta (`X.Y.Z-beta.N`) to the final `X.Y.Z` release (#22, #81, #93):
 * require docs/releases/X.Y.Z.md, bump root manifest.json, versions.json, and package.json
 * in one commit, push `main`, tag `X.Y.Z` so release.yml builds the final plugin + `latest`
 * image, wait for that run, and set the GitHub release body from docs/releases/X.Y.Z.md.
 *
 * Usage: deno run -A scripts/promote.ts X.Y.Z
 */

import { compareSemVer } from "../core/version.ts";
import { releaseHold } from "./release.ts";

const SHIPPED = ["plugin", "server", "core", "db"];

type ActionRun = { databaseId: number; headBranch: string };

if (import.meta.main) {
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

  const run = async (cmd: string, args: string[]): Promise<string> => {
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
  };

  const releaseRuns = async (): Promise<ActionRun[]> =>
    JSON.parse(
      await run("gh", [
        "run",
        "list",
        "--workflow=release.yml",
        "--limit",
        "20",
        "--json",
        "databaseId,headBranch",
      ]),
    );

  const waitForRelease = async (ver: string, before: number): Promise<void> => {
    let runId = "";
    for (let attempt = 0; attempt < 30 && !runId; attempt++) {
      const fresh = (await releaseRuns()).find(
        (r) => r.headBranch === ver && r.databaseId > before,
      );
      runId = fresh ? String(fresh.databaseId) : "";
      if (!runId) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (!runId) {
      throw new Error(
        `No new release.yml run for "${ver}" appeared within 60s. Check gh run list --workflow=release.yml.`,
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
        `release.yml run ${runId} did not succeed (gh run view ${runId} --log-failed):\n` +
          new TextDecoder().decode(out.stderr).trim(),
      );
    }
  };

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

  if (compareSemVer(version, promoted) <= 0) {
    console.error(`${version} is not above the promoted ${promoted}: nothing to promote.`);
    Deno.exit(1);
  }

  const tags = (await run("git", ["tag", "--list"])).split("\n").filter(Boolean);
  if (tags.includes(version)) {
    console.error(`Tag ${version} already exists.`);
    Deno.exit(1);
  }

  const betaRe = new RegExp(`^${version.replaceAll(".", "\\.")}-beta\\.(\\d+)$`);
  const betas = tags
    .map((tag) => {
      const m = betaRe.exec(tag);
      return m ? { tag, num: Number(m[1]) } : null;
    })
    .filter((b): b is { tag: string; num: number } => b !== null)
    .sort((a, b) => b.num - a.num);

  if (betas.length === 0) {
    console.error(
      `No ${version}-beta.N tag exists: cut and test a beta first (deno task release ${version}-beta.1).`,
    );
    Deno.exit(1);
  }

  const latestBeta = betas[0].tag;
  const ancestor = await new Deno.Command("git", {
    args: ["merge-base", "--is-ancestor", latestBeta, "HEAD"],
    cwd: root,
    stdout: "null",
    stderr: "null",
  }).output();
  if (ancestor.code !== 0) {
    console.error(`${latestBeta} is not an ancestor of HEAD: merge or rebase before promoting.`);
    Deno.exit(1);
  }

  const shippedAfter = await run("git", [
    "log",
    `${latestBeta}..HEAD`,
    "--format=%h %s",
    "--",
    ...SHIPPED,
  ]);
  if (shippedAfter) {
    console.error(
      `Shipped code changed after ${latestBeta}:\n${shippedAfter}\nCut a new beta before promoting ${version}.`,
    );
    Deno.exit(1);
  }

  // #93: curated release notes must exist before anything is written or pushed.
  const notesRel = `docs/releases/${version}.md`;
  const notesPath = `${root}/${notesRel}`;
  const notesText = await Deno.readTextFile(notesPath).catch(() => "");
  if (!notesText.trim()) {
    console.error(
      `Missing or empty release notes: ${notesRel}: draft and commit it via PR before promoting.`,
    );
    Deno.exit(1);
  }

  // Capture the run high-water mark (and verify gh works) before modifying or pushing anything.
  const before = Math.max(0, ...(await releaseRuns()).map((r) => r.databaseId));

  // ── Step 1: Bump package.json, root manifest.json, and versions.json ─────

  console.log(`[1/5] Bumping package.json, manifest.json, and versions.json to ${version}...`);
  const pkgPath = `${root}/package.json`;
  const pkg = JSON.parse(await Deno.readTextFile(pkgPath)) as { version: string };
  pkg.version = version;
  await Deno.writeTextFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  manifest.version = version;
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const versionsPath = `${root}/versions.json`;
  const versions = JSON.parse(await Deno.readTextFile(versionsPath)) as Record<string, string>;
  versions[version] = manifest.minAppVersion;
  await Deno.writeTextFile(versionsPath, JSON.stringify(versions, null, 2) + "\n");
  console.log(`  versions.json: added ${version} -> ${manifest.minAppVersion}`);

  // ── Step 2: Commit and push main ─────────────────────────────────────────

  console.log("[2/5] Committing and pushing to origin main...");
  await run("git", ["add", pkgPath, manifestPath, versionsPath]);
  await run("git", ["commit", "-m", `chore(release): promote ${version}`]);
  await run("git", ["push", "origin", "main"]);

  // ── Step 3: Tag and push the final release ───────────────────────────────

  console.log(`[3/5] Tagging and pushing ${version}...`);
  await run("git", ["tag", version]);
  await run("git", ["push", "origin", version]);

  // ── Step 4: Wait for release.yml to publish the image + GitHub release ───

  console.log(`[4/5] Waiting for release.yml on ${version}...`);
  await waitForRelease(version, before);

  // ── Step 5: Set the GitHub release body from docs/releases/X.Y.Z.md ─────

  console.log(`[5/5] Setting release notes from ${notesRel}...`);
  await run("gh", [
    "release",
    "edit",
    version,
    "--prerelease=false",
    "--latest",
    "--notes-file",
    notesPath,
  ]);

  console.log(`\nPromoted ${version}: the community directory serves it from the next index.`);
}
