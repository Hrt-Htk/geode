// #22/#81: betas ship as X.Y.Z-beta.N pre-releases; `deno task promote X.Y.Z`
// cuts the final X.Y.Z release from a commit that bumps root manifest.json,
// versions.json, and package.json, pushes main and tags X.Y.Z so release.yml
// builds and publishes the final image (`X.Y.Z` + `latest`) and GitHub release,
// then rewrites the release notes since the previous final release. `gh` is
// stubbed via PATH, so nothing here touches GitHub.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const REPO_ROOT = new URL("../../../", import.meta.url);

const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1 $2" in
  "release edit") echo "https://example.invalid/releases/tag/$3" ;;
  "run list")
    if [ "\${GH_LIST_FAIL:-}" = "true" ]; then
      echo "gh: not authenticated" >&2
      exit 1
    fi
    n=$(( $(cat "$GH_LISTS" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$GH_LISTS"
    if [ "\${GH_OLD_RUN:-}" = "true" ]; then
      case "$n" in
        1) echo '[{"databaseId":3,"headBranch":"0.0.2"}]' ;;
        2) echo '[]' ;;
        *) echo '[{"databaseId":9,"headBranch":"0.0.2"},{"databaseId":3,"headBranch":"0.0.2"}]' ;;
      esac
    elif [ "$n" = "1" ]; then
      echo '[]'
    else
      echo '[{"databaseId":7,"headBranch":"0.0.2"}]'
    fi
    ;;
  "run watch")
    if [ "\${GH_RUN_FAIL:-}" = "true" ]; then
      echo "X Release 0.0.2 failed" >&2
      exit 1
    fi
    echo "OK Release 0.0.2"
    ;;
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
  git: (args: string[]) => Promise<void>;
};

/** A throwaway repo on `main` with a bare origin: promoted at 0.0.1, beta 0.0.2-beta.1 tagged. */
async function tempRepo(
  opts: { tagBeta?: boolean; releaseNotes?: string | null } = {},
): Promise<Fixture> {
  const { tagBeta = true, releaseNotes = "## Highlights\n\n- Promoted change.\n" } = opts;
  const base = await Deno.realPath(await Deno.makeTempDir({ prefix: "geode-promote-" }));
  const repo = `${base}/repo`;
  const home = `${base}/home`;
  const bin = `${base}/bin`;
  const log = `${base}/gh.log`;
  const lists = `${base}/gh_lists`;
  await Deno.mkdir(repo);
  await Deno.mkdir(home);
  await Deno.mkdir(bin);
  await Deno.writeTextFile(`${bin}/gh`, GH_STUB);
  await Deno.chmod(`${bin}/gh`, 0o755);
  await Deno.writeTextFile(log, "");
  const env = {
    HOME: home,
    GH_LOG: log,
    GH_LISTS: lists,
    PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
  };

  const git = async (args: string[]) => {
    const out = await new Deno.Command("git", {
      args: ["-c", "user.name=geode", "-c", "user.email=geode@example.com", ...args],
      cwd: repo,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  };

  await git(["init", "-b", "main"]);
  await Deno.writeTextFile(`${repo}/package.json`, JSON.stringify({ version: "0.0.1" }) + "\n");
  await Deno.writeTextFile(
    `${repo}/manifest.json`,
    JSON.stringify({ version: "0.0.1", minAppVersion: "1.5.0" }, null, 2) + "\n",
  );
  await Deno.writeTextFile(
    `${repo}/versions.json`,
    JSON.stringify({ "0.0.1": "1.5.0" }, null, 2) + "\n",
  );
  await git(["add", "-A"]);
  await git(["commit", "-m", "chore: init"]);
  await git(["init", "--bare", "-b", "main", `${base}/origin.git`]);
  await git(["remote", "add", "origin", `${base}/origin.git`]);
  await git(["push", "-u", "origin", "main"]);
  // The previously promoted version predates #12 and is `v`-prefixed.
  await git(["tag", "v0.0.1"]);

  if (tagBeta) {
    await Deno.writeTextFile(
      `${repo}/package.json`,
      JSON.stringify({ version: "0.0.2-beta.1" }) + "\n",
    );
    await git(["add", "-A"]);
    await git(["commit", "-m", "chore(release): 0.0.2-beta.1"]);
    await git(["tag", "0.0.2-beta.1"]);
    await git(["push", "origin", "main", "0.0.2-beta.1"]);
  }

  if (releaseNotes !== null) {
    await Deno.mkdir(`${repo}/docs/releases`, { recursive: true });
    await Deno.writeTextFile(`${repo}/docs/releases/0.0.2.md`, releaseNotes);
    await git(["add", "-A"]);
    await git(["commit", "-m", "docs(release): 0.0.2 notes"]);
    await git(["push", "origin", "main"]);
  }

  return { base, repo, home, log, env, git };
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

async function revParse(cwd: string, ref: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["rev-parse", ref],
    cwd,
    stdout: "piped",
  }).output();
  assertEquals(out.code, 0);
  return new TextDecoder().decode(out.stdout).trim();
}

Deno.test("promote: bumps manifest, versions, and package.json, pushes main and tag, waits for release.yml", async () => {
  const fx = await tempRepo();
  try {
    const res = await runPromote(fx);
    assertEquals(res.code, 0, `promote failed\n${res.stdout}${res.stderr}`);
    const manifest = JSON.parse(await Deno.readTextFile(`${fx.repo}/manifest.json`));
    assertEquals(manifest.version, "0.0.2");
    assertEquals(manifest.minAppVersion, "1.5.0", "the manifest's own minAppVersion is kept");
    const pkg = JSON.parse(await Deno.readTextFile(`${fx.repo}/package.json`));
    assertEquals(pkg.version, "0.0.2", "package.json matches root manifest at tag commit");
    const versions = JSON.parse(await Deno.readTextFile(`${fx.repo}/versions.json`));
    assertEquals(versions, { "0.0.1": "1.5.0", "0.0.2": "1.5.0" });
    assert(
      (await subjects(fx)).includes("chore(release): promote 0.0.2"),
      "the promote is its own commit",
    );

    const localHead = await revParse(fx.repo, "HEAD");
    const remoteHead = await revParse(`${fx.base}/origin.git`, "main");
    assertEquals(remoteHead, localHead, "the promote commit reaches origin/main");

    // The 0.0.2 tag exists on origin and points directly at the promote commit,
    // so the tag commit's root manifest equals the release manifest.
    const tagTarget = await revParse(`${fx.base}/origin.git`, "refs/tags/0.0.2");
    assertEquals(tagTarget, localHead, "tag 0.0.2 points to the promote commit");

    assert(!res.stdout.includes("deploy"), "promote never deploys the server");
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: waits for release.yml and uses docs/releases/X.Y.Z.md as release body", async () => {
  const fx = await tempRepo();
  try {
    const res = await runPromote(fx);
    assertEquals(res.code, 0, `promote failed\n${res.stdout}${res.stderr}`);
    const lines = (await Deno.readTextFile(fx.log)).split("\n");
    const listIdx = lines.findIndex((l) => l.includes("--workflow=release.yml"));
    const watchIdx = lines.findIndex((l) => l.startsWith("run watch 7 --exit-status"));
    const editIdx = lines.findIndex((l) => l.startsWith("release edit 0.0.2"));
    assert(listIdx >= 0, `must poll release.yml runs:\n${lines.join("\n")}`);
    assert(watchIdx > listIdx, "watches the release run");
    assert(editIdx > watchIdx, "edits release notes after release run succeeds");
    assertStringIncludes(lines[editIdx], "--prerelease=false");
    assertStringIncludes(lines[editIdx], "--latest");
    assertStringIncludes(lines[editIdx], "--notes-file");
    assertStringIncludes(lines[editIdx], "docs/releases/0.0.2.md");
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: refuses without docs/releases/X.Y.Z.md before modifying or pushing anything", async () => {
  for (const releaseNotes of [null, "   \n"]) {
    const fx = await tempRepo({ releaseNotes });
    try {
      const beforeRemote = await revParse(`${fx.base}/origin.git`, "main");
      const res = await runPromote(fx);
      assertEquals(res.code, 1, `expected failure\n${res.stdout}${res.stderr}`);
      assertStringIncludes(res.stderr, "docs/releases/0.0.2.md");
      assertEquals(
        JSON.parse(await Deno.readTextFile(`${fx.repo}/manifest.json`)).version,
        "0.0.1",
      );
      assertEquals(
        JSON.parse(await Deno.readTextFile(`${fx.repo}/package.json`)).version,
        "0.0.2-beta.1",
      );
      assertEquals(await revParse(`${fx.base}/origin.git`, "main"), beforeRemote);
      assertEquals((await Deno.readTextFile(fx.log)).trim(), "", "gh must not run on refusal");
    } finally {
      await Deno.remove(fx.base, { recursive: true });
    }
  }
});

Deno.test("promote: a failed release.yml run surfaces the error without editing notes", async () => {
  const fx = await tempRepo();
  try {
    fx.env.GH_RUN_FAIL = "true";
    const res = await runPromote(fx);
    assertEquals(res.code, 1, `expected failure\n${res.stdout}${res.stderr}`);
    assertStringIncludes(res.stderr, "release");
    assert(
      !(await Deno.readTextFile(fx.log)).includes("release edit"),
      "must not rewrite notes on a failed release run",
    );
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: gh failure in preconditions leaves files, local main, and origin untouched", async () => {
  const fx = await tempRepo();
  try {
    const beforeRemote = await revParse(`${fx.base}/origin.git`, "main");
    fx.env.GH_LIST_FAIL = "true";
    const res = await runPromote(fx);
    assertEquals(res.code, 1, `expected failure\n${res.stdout}${res.stderr}`);
    assertStringIncludes(res.stderr, "not authenticated");
    assertEquals(JSON.parse(await Deno.readTextFile(`${fx.repo}/manifest.json`)).version, "0.0.1");
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${fx.repo}/package.json`)).version,
      "0.0.2-beta.1",
    );
    assertEquals(JSON.parse(await Deno.readTextFile(`${fx.repo}/versions.json`)), {
      "0.0.1": "1.5.0",
    });
    assert(!(await subjects(fx)).some((s) => s.startsWith("chore(release): promote")));
    assertEquals(await revParse(`${fx.base}/origin.git`, "main"), beforeRemote);
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: a rerun watches the new release run, not an earlier one", async () => {
  const fx = await tempRepo();
  try {
    fx.env.GH_OLD_RUN = "true";
    const res = await runPromote(fx);
    assertEquals(res.code, 0, `promote failed\n${res.stdout}${res.stderr}`);
    const watched = (await Deno.readTextFile(fx.log))
      .split("\n")
      .filter((l) => l.startsWith("run watch"));
    assertEquals(watched, ["run watch 9 --exit-status"], "watches the new run");
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: refuses when no X.Y.Z-beta.N tag exists", async () => {
  const fx = await tempRepo({ tagBeta: false });
  try {
    const res = await runPromote(fx);
    assertEquals(res.code, 1, `expected failure\n${res.stdout}${res.stderr}`);
    assertStringIncludes(res.stderr, "0.0.2-beta");
    assertEquals(
      JSON.parse(await Deno.readTextFile(`${fx.repo}/manifest.json`)).version,
      "0.0.1",
    );
    assert(!(await subjects(fx)).some((s) => s.startsWith("chore(release): promote")));
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: refuses when shipped code changed after the latest X.Y.Z-beta.N tag", async () => {
  for (const shippedDir of ["plugin", "server", "core", "db"]) {
    const fx = await tempRepo();
    try {
      await Deno.mkdir(`${fx.repo}/${shippedDir}`, { recursive: true });
      await Deno.writeTextFile(`${fx.repo}/${shippedDir}/touched.ts`, "export const x = 1;\n");
      await fx.git(["add", "-A"]);
      await fx.git(["commit", "-m", `fix: late change in ${shippedDir}`]);
      await fx.git(["push", "origin", "main"]);

      const res = await runPromote(fx);
      assertEquals(res.code, 1, `expected refusal for ${shippedDir}\n${res.stdout}${res.stderr}`);
      assertStringIncludes(res.stderr, "0.0.2-beta.1");
      assertEquals(
        JSON.parse(await Deno.readTextFile(`${fx.repo}/manifest.json`)).version,
        "0.0.1",
      );
      assert(!(await subjects(fx)).some((s) => s.startsWith("chore(release): promote")));
    } finally {
      await Deno.remove(fx.base, { recursive: true });
    }
  }
});

Deno.test("promote: allows non-shipped changes after the latest beta and picks highest numeric beta", async () => {
  const fx = await tempRepo();
  try {
    // beta.2 and beta.10 after beta.1, with shipped code before beta.10 and only docs after beta.10.
    await Deno.mkdir(`${fx.repo}/plugin`, { recursive: true });
    await Deno.writeTextFile(`${fx.repo}/plugin/a.ts`, "export const a = 1;\n");
    await fx.git(["add", "-A"]);
    await fx.git(["commit", "-m", "fix: plugin change"]);
    await fx.git(["tag", "0.0.2-beta.2"]);
    await Deno.writeTextFile(`${fx.repo}/plugin/a.ts`, "export const a = 2;\n");
    await fx.git(["add", "-A"]);
    await fx.git(["commit", "-m", "fix: another plugin change"]);
    await fx.git(["tag", "0.0.2-beta.10"]);
    await Deno.mkdir(`${fx.repo}/docs`, { recursive: true });
    await Deno.writeTextFile(`${fx.repo}/docs/note.md`, "# note\n");
    await fx.git(["add", "-A"]);
    await fx.git(["commit", "-m", "docs: update note"]);
    await fx.git(["push", "origin", "main", "0.0.2-beta.2", "0.0.2-beta.10"]);

    const res = await runPromote(fx);
    assertEquals(
      res.code,
      0,
      `promote should succeed after docs-only commit\n${res.stdout}${res.stderr}`,
    );
    assertEquals(JSON.parse(await Deno.readTextFile(`${fx.repo}/manifest.json`)).version, "0.0.2");
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
    assert(!(await subjects(fx)).some((s) => s.startsWith("chore(release): promote")));
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: refuses a beta version argument", async () => {
  const fx = await tempRepo();
  try {
    const res = await runPromote(fx, "0.0.2-beta.1");
    assertEquals(res.code, 1, `expected failure\n${res.stdout}${res.stderr}`);
    assertStringIncludes(res.stderr, "X.Y.Z");
  } finally {
    await Deno.remove(fx.base, { recursive: true });
  }
});

Deno.test("promote: respects RELEASE_HOLD", async () => {
  const fx = await tempRepo();
  try {
    await Deno.writeTextFile(`${fx.repo}/RELEASE_HOLD`, "waiting on upstream\n");
    await fx.git(["add", "-A"]);
    await fx.git(["commit", "-m", "chore: hold"]);
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

Deno.test("promote: release.yml triggers on beta and final tags and tags images accordingly", async () => {
  const yaml = await Deno.readTextFile(
    new URL("../../../.github/workflows/release.yml", import.meta.url),
  );
  assertStringIncludes(yaml, "[0-9]+.[0-9]+.[0-9]+-beta.[0-9]+");
  assertStringIncludes(yaml, "prerelease: ${{ contains(github.ref_name, '-beta.') }}");
  assertStringIncludes(yaml, "ghcr.io/hrt-htk/geode:beta");
  assertStringIncludes(yaml, "ghcr.io/hrt-htk/geode:latest");
});
