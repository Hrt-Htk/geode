// #8: `deno task docs:screenshots`: build, reshoot every docs image, stamp the plugin version.

import { dirname, join } from "jsr:@std/path@^1";

const ROOT = Deno.cwd();
// Every doc that shows a committed image, with a `Taken on plugin vX.Y.Z.` caption per image.
const CAPTION_FILES = ["README.md", "docs/screenshots/README.md"];
// The one token a reshoot rewrites: dotted numbers only, so the sentence's own full stop stays.
// The gaps repair a caption the doc wrapped inside the token.
const VERSION_TOKEN = /Taken\s+on\s+plugin\s+v\d+\.\d+\.\d+/g;

function spawn(cmd: string, args: string[], env = Deno.env.toObject()): Promise<number> {
  return new Deno.Command(cmd, {
    cwd: ROOT,
    args,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status.then((status) => status.code);
}

/** Point every caption at the version just shot, and check the set against the files. */
async function stampCaptions(version: string): Promise<void> {
  for (const file of CAPTION_FILES) {
    const text = await Deno.readTextFile(join(ROOT, file));
    const images = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
    const captions = text.match(VERSION_TOKEN) ?? [];
    if (images.length !== captions.length) {
      throw new Error(
        `${file}: ${images.length} images but ${captions.length} version captions. ` +
          `Every image needs exactly one "Taken on plugin vX.Y.Z."`,
      );
    }
    for (const image of images) {
      const path = join(dirname(file), image);
      if (!(await Deno.stat(join(ROOT, path)).catch(() => null))?.isFile) {
        throw new Error(`${file}: ${image} is missing`);
      }
    }
    const stamped = text.replace(VERSION_TOKEN, `Taken on plugin v${version}`);
    if (stamped !== text) await Deno.writeTextFile(join(ROOT, file), stamped);
    console.log(`${file}: ${images.length} images, plugin v${version}`);
  }
}

async function main(): Promise<void> {
  if (await spawn(Deno.execPath(), ["task", "build:plugin"]) !== 0) Deno.exit(1);

  const cli = [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config=test/e2e/playwright.config.ts",
    "--project=docs",
  ];
  const env = {
    ...Deno.env.toObject(),
    // The env guard the docs specs check: a bare `playwright test` never rewrites an image.
    GEODE_DOCS_SHOTS: "1",
    // The phone half runs under the shared test-phone lock, resetting only the test vault.
    GEODE_PHONE: "1",
    GEODE_PHONE_RESET: "1",
    GEODE_PHONE_PUSH: "1",
    GEODE_PHONE_HOST: "1",
  };
  // The desktop specs need a display: fall back to a virtual one when the shell has none.
  const headless = !Deno.env.get("DISPLAY") && !Deno.env.get("WAYLAND_DISPLAY");
  const [cmd, args] = headless
    ? ["xvfb-run", ["-a", "-s", "-screen 0 1600x1400x24", "node", ...cli]]
    : ["node", cli];
  if (await spawn(cmd, args, env) !== 0) {
    console.error(
      "\ndocs:screenshots: the run failed, so some images may have been rewritten without new " +
        "captions. Restore them with `git checkout -- docs/screenshots` (and README.md), or " +
        "re-run once the failure is fixed.",
    );
    Deno.exit(1);
  }

  const manifest = JSON.parse(await Deno.readTextFile(join(ROOT, "plugin-dist/manifest.json")));
  await stampCaptions(manifest.version as string);
}

if (import.meta.main) await main();
