// Release: the tag is the whole release (#22), and `release.yml` publishes the plugin
// and the server image from it, so the script only bumps the shared version line,
// commits, pushes and tags. It reads no environment: a release nobody deploys from
// must run in a bare shell. The gate runs in a throwaway repo with a bare origin.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("../../../", import.meta.url);

/** Base dir holding a clean throwaway repo on `main` (version 0.0.1, no remote) and its HOME. */
async function tempRepo(): Promise<{ base: string; repo: string; home: string }> {
  const base = await Deno.realPath(await Deno.makeTempDir({ prefix: "geode-release-" }));
  const repo = `${base}/repo`;
  const home = `${base}/home`;
  await Deno.mkdir(repo);
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
    `${repo}/manifest.json`,
    JSON.stringify({ version: "0.0.1", minAppVersion: "0.15.0" }) + "\n",
  );
  await Deno.writeTextFile(`${repo}/versions.json`, "{}\n");
  await git(["add", "-A"]);
  const commit = await git(["commit", "-m", "chore: init"]);
  assertEquals(commit.code, 0, new TextDecoder().decode(commit.stderr));
  return { base, repo, home };
}

async function runRelease(repo: string, home: string) {
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
    },
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

// #22: a release is a BRAT beta. It moves the shared version line (package.json)
// only; the root manifest.json/versions.json stay on the last promoted version,
// because the community directory reads them.
Deno.test("release: bumps package.json only, then commits, pushes and tags it", async () => {
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
    // The previous release predates #12 and is `v`-prefixed.
    await git(["tag", "v0.0.1"]);

    const res = await runRelease(repo, home);
    assertEquals(res.code, 0, `release failed\n${res.stdout}${res.stderr}`);
    // Four steps, none of them a deploy, in a shell with no environment set.
    assertStringIncludes(res.stdout, "[1/4] Bumping version");
    assertStringIncludes(res.stdout, "[4/4] Tagging and pushing");
    assert(!res.stdout.includes("[5/"), `the release has no deploy step: ${res.stdout}`);
    const pkg = JSON.parse(await Deno.readTextFile(`${repo}/package.json`));
    assertEquals(pkg.version, "9.9.9", "the release moves the shared version line");
    const manifest = JSON.parse(await Deno.readTextFile(`${repo}/manifest.json`));
    assertEquals(manifest.version, "0.0.1", "a beta must not move the directory's manifest");
    assertEquals(
      await Deno.readTextFile(`${repo}/versions.json`),
      "{}\n",
      "a beta must not add a versions.json entry",
    );
    // #12: the new tag is the bare manifest version, not `v`-prefixed.
    const tags = await new Deno.Command("git", {
      args: ["tag", "--list"],
      cwd: repo,
      stdout: "piped",
    }).output();
    assertEquals(new TextDecoder().decode(tags.stdout).trim().split("\n"), ["9.9.9", "v0.0.1"]);
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});

Deno.test("after-merge loads .env.local, so the board id reaches it", async () => {
  // deno.json is JSONC, so match the task line instead of parsing it.
  const denoJson = await Deno.readTextFile(new URL("deno.json", REPO_ROOT));
  const task = new RegExp(`"[a-z-]+": "[^"]*--env-file=\\.env\\.local [^"]*after-merge\\.ts"`);
  assert(task.test(denoJson), "no task loads .env.local before after-merge.ts");
});
