// #699: the release path must fail on a missing GEODE_SSH_HOST BEFORE it bumps,
// commits, pushes or tags, and `deno task release` / `after-merge` must load
// `.env.local` so the deploy step finds it. The gate runs in a throwaway repo with
// no remote, so nothing here can push or deploy.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("../../../", import.meta.url);

/** Base dir holding a clean throwaway repo on `main` (version 0.0.1, no remote) and its HOME. */
async function tempRepo(): Promise<{ base: string; repo: string; home: string }> {
  const base = await Deno.realPath(await Deno.makeTempDir({ prefix: "geode-release-preflight-" }));
  const repo = `${base}/repo`;
  const home = `${base}/home`;
  await Deno.mkdir(`${repo}/plugin/manifest`, { recursive: true });
  await Deno.mkdir(home);
  const git = (args: string[]) =>
    new Deno.Command("git", {
      args: ["-c", "user.name=geode", "-c", "user.email=geode@example.com", ...args],
      cwd: repo,
      env: { HOME: home },
      stdout: "null",
      stderr: "piped",
    }).output();
  const init = await git(["init", "-b", "main"]);
  assertEquals(init.code, 0, new TextDecoder().decode(init.stderr));
  await Deno.writeTextFile(`${repo}/package.json`, JSON.stringify({ version: "0.0.1" }) + "\n");
  await Deno.writeTextFile(
    `${repo}/plugin/manifest/manifest.json`,
    JSON.stringify({ version: "0.0.1", minAppVersion: "0.15.0" }) + "\n",
  );
  await Deno.writeTextFile(`${repo}/plugin/manifest/versions.json`, "{}\n");
  await git(["add", "-A"]);
  const commit = await git(["commit", "-m", "chore: init"]);
  assertEquals(commit.code, 0, new TextDecoder().decode(commit.stderr));
  return { base, repo, home };
}

async function runRelease(repo: string, home: string, extraEnv: Record<string, string>) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("scripts/release.ts", REPO_ROOT).pathname, "9.9.9"],
    cwd: repo,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "",
      HOME: home,
      GIT_AUTHOR_NAME: "geode",
      GIT_AUTHOR_EMAIL: "geode@example.com",
      GIT_COMMITTER_NAME: "geode",
      GIT_COMMITTER_EMAIL: "geode@example.com",
      ...extraEnv,
    },
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

Deno.test("release preflight: a missing GEODE_SSH_HOST fails before the bump", async () => {
  const { base, repo, home } = await tempRepo();
  try {
    const res = await runRelease(repo, home, {});
    assertEquals(res.code, 1, `expected failure, got ${res.code}\n${res.stdout}${res.stderr}`);
    assertStringIncludes(res.stderr, "GEODE_SSH_HOST");
    assertStringIncludes(res.stderr, ".env.local");
    const pkg = JSON.parse(await Deno.readTextFile(`${repo}/package.json`));
    assertEquals(pkg.version, "0.0.1", "the version must not be bumped when the host is missing");
    const log = await new Deno.Command("git", {
      args: ["log", "--format=%s"],
      cwd: repo,
      stdout: "piped",
    }).output();
    assert(
      !new TextDecoder().decode(log.stdout).includes("chore(release)"),
      "no release commit may exist",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("release preflight: a set GEODE_SSH_HOST passes the gate", async () => {
  const { base, repo, home } = await tempRepo();
  try {
    const res = await runRelease(repo, home, { GEODE_SSH_HOST: "user@geode.invalid" });
    assert(
      !res.stderr.includes("GEODE_SSH_HOST is not set"),
      `the gate must not fire with a host set: ${res.stderr}`,
    );
    assertStringIncludes(res.stdout, "[1/5] Bumping version");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("release preflight: the release and after-merge tasks load .env.local", async () => {
  // deno.json is JSONC, so match the task lines instead of parsing it.
  const denoJson = await Deno.readTextFile(new URL("deno.json", REPO_ROOT));
  for (const script of ["release.ts", "after-merge.ts"]) {
    const task = new RegExp(`"[a-z-]+": "[^"]*--env-file=\\.env\\.local [^"]*${script}"`);
    assert(task.test(denoJson), `no task loads .env.local before ${script}`);
  }
});

// #731: deploy.sh runs after the bump commit and the v* tag are pushed, so
// `git describe` at HEAD returns the tag it just created and the plugin/core
// diff is empty by construction. The release must hand the deploy the tag it is
// replacing, or the "no BRAT release needed" line is a tautology.
Deno.test("release deploy: the deploy is told the tag being replaced", async () => {
  const { base, repo, home } = await tempRepo();
  const git = async (args: string[]) => {
    const out = await new Deno.Command("git", {
      args: ["-c", "user.name=geode", "-c", "user.email=geode@example.com", ...args],
      cwd: repo,
      env: { HOME: home },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  };
  try {
    // A bare origin, so the release can push main and the new tag for real.
    await git(["init", "--bare", "-b", "main", `${base}/origin.git`]);
    await git(["remote", "add", "origin", `${base}/origin.git`]);
    await git(["push", "-u", "origin", "main"]);
    // release.ts runs ${repo}/deploy/deploy.sh; stand in for it and let it
    // report the environment it was given.
    await Deno.mkdir(`${repo}/deploy`, { recursive: true });
    await Deno.writeTextFile(
      `${repo}/deploy/deploy.sh`,
      '#!/usr/bin/env bash\necho "fake deploy: GEODE_PREV_TAG=${GEODE_PREV_TAG:-unset}"\n',
    );
    await git(["add", "-A"]);
    await git(["commit", "-m", "test: stand-in deploy script"]);

    const res = await runRelease(repo, home, { GEODE_SSH_HOST: "user@geode.invalid" });
    assertEquals(res.code, 0, `release failed\n${res.stdout}${res.stderr}`);
    assertStringIncludes(res.stdout, "[5/5] Deploying server");
    assertStringIncludes(res.stdout, "fake deploy: GEODE_PREV_TAG=v0.0.1");
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
