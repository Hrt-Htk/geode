// #8: reshoot the images the README and `docs/screenshots/README.md` show, in one command.
// Builds the plugin, runs the `docs` Playwright project (desktop and the connected Android phone in
// one run, under the shared phone lock), then stamps the plugin version into every caption.
//
// Usage: `deno task docs:screenshots`

const ROOT = Deno.cwd();
const CAPTIONS = "docs/screenshots/README.md";
const SHOTS = "docs/screenshots";
// `Taken on plugin v0.41.7.` is the one token a reshoot rewrites: dotted numbers only, so the
// sentence's own full stop is left alone. The `\s+` gaps repair a caption the doc wrapped inside
// the token.
const VERSION_TOKEN = /Taken\s+on\s+plugin\s+v[0-9A-Za-z+-]+(?:\.[0-9A-Za-z+-]+)*/g;

function spawn(cmd: string, args: string[], env = Deno.env.toObject()): Promise<number> {
  return new Deno.Command(cmd, {
    cwd: ROOT,
    args,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
    .spawn().status.then((status) => status.code);
}

/** The built plugin's version: what the captions record. */
async function pluginVersion(): Promise<string> {
  const manifest = JSON.parse(await Deno.readTextFile(`${ROOT}/plugin-dist/manifest.json`));
  return manifest.version as string;
}

/** Point every caption at the version just shot, and check the set against the folder. */
async function stampCaptions(version: string): Promise<void> {
  const path = `${ROOT}/${CAPTIONS}`;
  const text = await Deno.readTextFile(path);
  const images = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const captions = text.match(VERSION_TOKEN) ?? [];
  if (images.length !== captions.length) {
    throw new Error(
      `${CAPTIONS}: ${images.length} images but ${captions.length} version captions. ` +
        `Every image needs exactly one "Taken on plugin vX.Y.Z."`,
    );
  }
  for (const image of images) {
    if (!(await Deno.stat(`${ROOT}/${SHOTS}/${image}`).catch(() => null))?.isFile) {
      throw new Error(`${CAPTIONS}: ${image} is missing from ${SHOTS}`);
    }
  }
  const stamped = text.replace(VERSION_TOKEN, `Taken on plugin v${version}`);
  if (stamped !== text) await Deno.writeTextFile(path, stamped);
  console.log(`\n${CAPTIONS}: ${images.length} images, stamped plugin v${version}`);
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
  if (await spawn(cmd, args, env) !== 0) Deno.exit(1);

  await stampCaptions(await pluginVersion());
}

if (import.meta.main) await main();
