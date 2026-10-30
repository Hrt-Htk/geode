// #22: a release ships to BRAT testers as a pre-release; promoting it points the
// community directory's root manifest.json/versions.json on main at that exact
// build, clears the pre-release flag, and rewrites its notes to cover every
// change since the previously promoted version. `gh` is stubbed via PATH, so
// nothing here touches GitHub.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("../../../", import.meta.url);

// Records its argv, answers the three calls promote makes.
const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "release view")
    if [ "\${GH_PRERELEASE:-true}" = "false" ]; then
      echo '{"isPrerelease":false}'
    else
      echo '{"isPrerelease":true}'
    fi
    ;;
  "api repos/{owner}/{repo}/releases/generate-notes")
    echo "## What's Changed"
    echo ""
    echo "* promoted notes"
    ;;
  "release edit") echo "https://example.invalid/releases/tag/$3" ;;
  *)
    echo "gh stub: unhandled: $*" >&2
    exit 1
    ;;
esac
`;

type Fixture = {
  base: string;
  repo: string;
  home: string;
  log: string;
  env: Record<string, string>;
};

/** A throwaway repo on `main` with a bare origin: manifest promoted at 0.0.1, released 0.0.2. */
async function tempRepo(): Promise<Fixture> {
  const base = await Deno.realPath(await Deno.makeTempDir({ prefix: "geode-promote-" }));
  const repo = `${base}/repo`;
  const home = `${base}/home`;
  const bin = `${base}/bin`;
  const log = `${base}/gh.log`;
  await Deno.mkdir(repo);
  await Deno.mkdir(home);
  await Deno.mkdir(bin);
  await Deno.writeTextFile(`${bin}/gh`, GH_STUB);
  await Deno.chmod(`${bin}/gh`, 0o755);
  await Deno.writeTextFile(log, "");
  const env = { HOME: home, GH_LOG: log, PATH: `${bin}:${Deno.env.get("PATH") ?? ""}` };

  const git = (args: string[]) =>
    new Deno.Command("git", {
      args: ["-c", "user.name=geode", "-c", "user.email=geode@example.com", ...args],
      cwd: repo,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
  const ok = async (args: string[]) => {
    const out = await git(args);
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  };

  await ok(["init", "-b", "main"]);
  await Deno.writeTextFile(`${repo}/package.json`, JSON.stringify({ version: "0.0.2" }) + "\n");
  await Deno.writeTextFile(
    `${repo}/manifest.json`,
    JSON.stringify({ version: "0.0.1", minAppVersion: "1.5.0" }, null, 2) + "\n",
  );
  await Deno.writeTextFile(
    `${repo}/versions.json`,
    JSON.stringify({ "0.0.1": "1.5.0" }, null, 2) + "\n",
  );
  await ok(["add", "-A"]);
  await ok(["commit", "-m", "chore: init"]);
  await ok(["init", "--bare", "-b", "main", `${base}/origin.git`]);
  await ok(["remote", "add", "origin", `${base}/origin.git`]);
  await ok(["push", "-u", "origin", "main"]);
  // The previously promoted version predates #12 and is `v`-prefixed.
  await ok(["tag", "v0.0.1"]);
  return { base, repo, home, log, env };
}

async function runPromote(fx: Fixture, version = "0.0.2") {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("scripts/promote.ts", REPO_ROOT).pathname, version],
    cwd: fx.repo,
    clearEnv: true,
    env: {
      GIT_AUTHOR_NAME: "geode",
      GIT_AUTHOR_EMAIL: "geode@example.com",
      GIT_COMMITTER_NAME: "geode",
      GIT_COMMITTER_EMAIL: "geode@example.com",
      ...fx.env,
    },
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function subjects(fx: Fixture): Promise<string[]> {
  const out = await new Deno.Command("git", {
    args: ["log", "--format=%s"],
    cwd: fx.repo,
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).trim().split("\n");
}

Deno.test("promote: points main's root manifest and versions.json at the release", async () => {
  const fx = await tempRepo();
  try {
    const res = await runPromote(fx);
    assertEquals(res.code, 0, `promote failed\n${res.stdout}${res.stderr}`);
    const manifest = JSON.parse(await Deno.readTextFile(`${fx.repo}/manifest.json`));
    assertEquals(manifest.version, "0.0.2");
    assertEquals(manifest.minAppVersion, "1.5.0", "the manifest's own minAppVersion is kept");
    const versions = JSON.parse(await Deno.readTextFile(`${fx.repo}/versions.json`));
    assertEquals(versions, { "0.0.1": "1.5.0", "0.0.2": "1.5.0" });
    assert(
      (await subjects(fx)).includes("chore(release): promote 0.0.2"),
      "the promote is its own commit",
    );
    const local = await new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      cwd: fx.repo,
      stdout: "piped",
    }).output();
    const remote = await new Deno.Command("git", {
      args: ["rev-parse", "main"],
      cwd: `${fx.base}/origin.git`,
      stdout: "piped",
    }).output();
    assertEquals(
      new TextDecoder().decode(remote.stdout).trim(),
      new TextDecoder().decode(local.stdout).trim(),
      "the promote commit reaches origin/main",
    );
    assert(!res.stdout.includes("deploy"), "promote never deploys the server");
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: clears the pre-release flag, marks it latest, rewrites the notes", async () => {
  const fx = await tempRepo();
  try {
    const res = await runPromote(fx);
    assertEquals(res.code, 0, `promote failed\n${res.stdout}${res.stderr}`);
    const log = await Deno.readTextFile(fx.log);
    const edit = log.split("\n").find((l) => l.startsWith("release edit")) ?? "";
    assertStringIncludes(edit, "release edit 0.0.2");
    assertStringIncludes(edit, "--prerelease=false");
    assertStringIncludes(edit, "--latest");
    assertStringIncludes(edit, "## What's Changed");
    // The notes must span everything since the last promoted version, which is
    // the root manifest's version, in either tag form.
    const notes = log.split("\n").find((l) => l.includes("generate-notes")) ?? "";
    assertStringIncludes(notes, "tag_name=0.0.2");
    assertStringIncludes(notes, "previous_tag_name=v0.0.1");
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: refuses a release that is not a pre-release", async () => {
  const fx = await tempRepo();
  try {
    fx.env.GH_PRERELEASE = "false";
    const res = await runPromote(fx);
    assertEquals(res.code, 1, `expected failure\n${res.stdout}${res.stderr}`);
    assertStringIncludes(res.stderr, "0.0.2");
    assertStringIncludes(res.stderr, "pre-release");
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${fx.repo}/manifest.json`)).version,
      "0.0.1",
      "a refused promote must not move the manifest",
    );
    assert(!(await subjects(fx)).some((s) => s.startsWith("chore(release)")), "no promote commit");
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: refuses a version that is not above the promoted one", async () => {
  const fx = await tempRepo();
  try {
    const res = await runPromote(fx, "0.0.1");
    assertEquals(res.code, 1, `expected failure\n${res.stdout}${res.stderr}`);
    assertStringIncludes(res.stderr, "above");
    assert(!(await subjects(fx)).some((s) => s.startsWith("chore(release)")), "no promote commit");
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: respects RELEASE_HOLD", async () => {
  const fx = await tempRepo();
  try {
    await Deno.writeTextFile(`${fx.repo}/RELEASE_HOLD`, "waiting on upstream\n");
    const add = await new Deno.Command("git", {
      args: ["-c", "user.name=geode", "-c", "user.email=geode@example.com", "add", "-A"],
      cwd: fx.repo,
      stdout: "null",
    }).output();
    assertEquals(add.code, 0);
    const commit = await new Deno.Command("git", {
      args: [
        "-c",
        "user.name=geode",
        "-c",
        "user.email=geode@example.com",
        "commit",
        "-m",
        "chore: hold",
      ],
      cwd: fx.repo,
      stdout: "null",
    }).output();
    assertEquals(commit.code, 0);
    const res = await runPromote(fx);
    assertEquals(res.code, 1, `expected failure\n${res.stdout}${res.stderr}`);
    assertStringIncludes(res.stderr, "waiting on upstream");
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${fx.repo}/manifest.json`)).version,
      "0.0.1",
      "a held promote must not move the manifest",
    );
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});
