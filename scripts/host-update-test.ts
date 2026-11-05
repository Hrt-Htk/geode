// Host update job (#43): `geode-update.sh` end to end, against a throwaway registry on
// this machine. The `Docker smoke` CI job runs it on linux/amd64 and linux/arm64 next to
// `scripts/docker-smoke.ts`; `deno run -A scripts/host-update-test.ts` runs it by hand.
//
// Needs Docker, and root or passwordless sudo unless it already runs as root: the job runs
// as root, in a directory only root may write.
//
// The stack is plain HTTP through the bundled forwarder, so the real plugin sync core can
// talk to it with the global fetch and WebSocket (no Caddy CA to trust).

import { b64decode } from "../core/protocol.ts";
import { TestPlugin } from "../test/two-vault-driver.ts";
import { chain, exec, freePort, sh, waitFor } from "./docker-helpers.ts";

const ROOT = new URL("..", import.meta.url).pathname;
// A concurrent run must not collide: its own compose project, image tag and networks.
const RUN = crypto.randomUUID().slice(0, 8);
const IMAGE = `geode-update-${RUN}/geode`;
const PROJECT = `geode-update-${RUN}`;
const ADMIN = crypto.randomUUID();
const SUDO = Deno.uid() === 0 ? [] : ["sudo", "-n"];

const parent = await Deno.makeTempDir({ prefix: `geode-update-${RUN}-` });
// The compose directory belongs to root, the way the install has it; the test's own build
// contexts and probes live outside it.
const dir = `${parent}/app`;
const work = `${parent}/work`;
const dataDir = `${dir}/data`;
const statusDir = `${dir}/update-status`;
const probeDir = `${work}/probe`;
const variants = `${work}/variants`;
const registryPort = freePort();
const REG = `127.0.0.1:${registryPort}`;
const published = freePort();
const API = `http://127.0.0.1:${published}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The device's transport and reconciler timers keep the event loop alive. */
let spawned: TestPlugin | undefined;

function ok(name: string, detail = ""): void {
  console.log(`ok    ${name}${detail ? ` (${detail})` : ""}`);
}

function eq(actual: string, want: string, what: string): void {
  if (actual !== want) throw new Error(`${what}: got "${actual}", want "${want}"`);
}

/** compose in the job's directory, as root: `.env` is root's, like an install. */
function compose(...args: string[]): Promise<string> {
  return sh([...SUDO, "docker", "compose", ...args], {}, dir);
}

/** The job, as root, exactly as cron would run it. */
function job(): Promise<{ code: number; out: string; text: string }> {
  return exec([...SUDO, `${dir}/geode-update.sh`], {}, dir);
}

/** The status word the job last wrote: the result a client shows (#44). */
async function result(): Promise<string> {
  return (await Deno.readTextFile(`${statusDir}/result`)).trim().split(" ")[0];
}

async function versionNow(): Promise<string> {
  const res = await fetch(`${API}/version`);
  if (!res.ok) throw new Error(`/version returned ${res.status}`);
  return ((await res.json()) as { version: string }).version;
}

function container(): Promise<string> {
  return compose("ps", "-q", "geode");
}

function health(): Promise<string> {
  return container().then((id) =>
    sh(["docker", "inspect", "--format", "{{.State.Health.Status}}", id])
  );
}

/** A request, the way #44 will leave one: a file in Geode's data folder. */
function request(): Promise<string> {
  return container().then((id) => sh(["docker", "exec", id, "touch", "/data/update-request"]));
}

/** Every attempt is rate limited for ten minutes: clear the countdown to allow another. */
function allowUpdate(): Promise<string> {
  return sh([...SUDO, "rm", "-f", `${statusDir}/last-update`]);
}

/** A file in the root-owned state folder, written the way root would. */
async function rootWrite(path: string, text: string): Promise<void> {
  const src = await Deno.makeTempFile({ prefix: `geode-update-${RUN}-`, suffix: ".tmp" });
  await Deno.writeTextFile(src, text);
  await sh([...SUDO, "install", "-m", "0644", src, path]);
  await Deno.remove(src);
}

function exists(path: string): Promise<boolean> {
  return exec(["ls", "-d", path]).then((r) => r.code === 0);
}

async function admin(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  return JSON.parse(text);
}

/** Publish an image variant as `latest`: what the job's `docker compose pull` finds. */
async function publish(name: string): Promise<void> {
  await sh(["docker", "tag", `${IMAGE}:${name}`, `${REG}/geode:${name}`]);
  await sh(["docker", "push", "--quiet", `${REG}/geode:${name}`]);
  await sh(["docker", "tag", `${IMAGE}:${name}`, `${REG}/geode:latest`]);
  await sh(["docker", "push", "--quiet", `${REG}/geode:latest`]);
}

async function imageId(name: string): Promise<string> {
  return sh(["docker", "image", "inspect", "--format", "{{.Id}}", `${REG}/geode:${name}`]);
}

/** The job under a hard bound: a restore that blocks on a writerless FIFO must fail the
 * test, not hang it, and its own child (a blocked `docker run`) must not hold the pipes
 * open afterwards. 137 and 124 are the timeout's exit codes. */
async function boundedJob(seconds: number): Promise<number> {
  const child = new Deno.Command(
    SUDO.length ? SUDO[0] : `${dir}/geode-update.sh`,
    {
      args: SUDO.length
        ? [SUDO[1], "timeout", "-s", "KILL", `${seconds}`, `${dir}/geode-update.sh`]
        : [],
      cwd: dir,
      stdout: "null",
      stderr: "null",
    },
  ).spawn();
  return (await child.status).code;
}

/** Nobody holds the job's lock. */
async function lockFree(): Promise<boolean> {
  return (await exec([...SUDO, "flock", "-n", `${dir}/.update-lock`, "true"])).code === 0;
}

/** The image the service runs. Every variant is the same build plus one layer, so the
 * image id, not `/version`, is what says which one a request applied. */
async function running(): Promise<string> {
  return sh(["docker", "inspect", "--format", "{{.Image}}", await container()]);
}

/** Clear the rate limit, publish a release, request it, run the job. A run says nothing
 * on stderr, so cron does not mail on every update; a failed restore is the exception,
 * and says why. */
async function update(name: string): Promise<void> {
  await allowUpdate();
  await publish(name);
  await request();
  const done = await job();
  if (done.text && (await result()) !== "rollback-failed") {
    throw new Error(`the job was not silent: ${done.text}`);
  }
}

/**
 * The database as uid 1993 sees it, from a container with only the data folder mounted:
 * the schema version, whether the test migration's table exists, and whether the failed
 * image left its marker (so "the migration ran" is proven, not assumed).
 */
async function probeDb(): Promise<{ schema: string; probe_table: number; migrated: string }> {
  return JSON.parse(
    await sh([
      "docker",
      "run",
      "--rm",
      "--user",
      "1993:1993",
      "--network",
      "none",
      "-v",
      `${dataDir}:/data`,
      "-v",
      `${probeDir}:/app/probe:ro`,
      "-w",
      "/app",
      "--entrypoint",
      "deno",
      `${IMAGE}:base`,
      "run",
      "--allow-read=/data,/app",
      "--allow-ffi",
      "--allow-env",
      "/app/probe/check.ts",
    ]),
  );
}

try {
  console.log(`==> registry on ${REG}`);
  await sh([
    "docker",
    "run",
    "-d",
    "--name",
    `${PROJECT}-registry`,
    "-p",
    `127.0.0.1:${registryPort}:5000`,
    "registry:2",
  ]);
  await waitFor(
    async () => (await exec(["curl", "-sf", `http://${REG}/v2/`])).code === 0,
    "the registry",
    30_000,
  );

  await Deno.mkdir(dir);
  await Deno.mkdir(work);
  await Deno.mkdir(dataDir);
  await Deno.mkdir(probeDir);
  await Deno.mkdir(variants);
  await Deno.copyFile(`${ROOT}geode-update.sh`, `${dir}/geode-update.sh`);
  await Deno.copyFile(`${ROOT}compose.yaml`, `${dir}/compose.yaml`);
  // The image reference is the only thing the job must not hardcode: compose auto-loads
  // this file, so the job's fixed commands stay fixed.
  await Deno.writeTextFile(
    `${dir}/compose.override.yaml`,
    `services:\n  geode:\n    image: ${REG}/geode:latest\n    labels:\n` +
      `      geode.update.test: root-owned override\n`,
  );
  await Deno.writeTextFile(
    `${dir}/.env`,
    [
      `GEODE_ADMIN_TOKEN=${ADMIN}`,
      `COMPOSE_PROJECT_NAME=${PROJECT}`,
      "COMPOSE_PROFILES=forward",
      `GEODE_PUBLISH=127.0.0.1:${published}`,
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    `${probeDir}/check.ts`,
    `import { Database } from "@db/sqlite";
const db = new Database("/data/geode.db", { readonly: true });
const schema = db.prepare("SELECT value FROM _meta WHERE key = ?").get("schema_version") as {
  value: string;
};
const table = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = ?")
  .get("host_update_probe") as { n: number };
db.close();
const migrated = await Deno.readTextFile("/data/.migrate-probe").catch(() => "");
console.log(JSON.stringify({ schema: schema.value, probe_table: table.n, migrated }));
`,
  );

  console.log(`==> build ${IMAGE}:base and its variants`);
  await sh([
    "docker",
    "build",
    "--quiet",
    "--build-arg",
    "VERSION=0.99.1",
    "-t",
    `${IMAGE}:base`,
    ROOT,
  ]);
  // One base build, then one more layer each: cheap, and the image id still tells them
  // apart. A version bump would break the image, whose node_modules are keyed to the
  // version the build installed.
  const marker = (name: string): string => `RUN echo ${name} > /app/variant\n`;
  const variant = async (name: string, body: string): Promise<void> => {
    await Deno.writeTextFile(`${variants}/Dockerfile.${name}`, `FROM ${IMAGE}:base\n${body}`);
    await sh([
      "docker",
      "build",
      "--quiet",
      "-f",
      `${variants}/Dockerfile.${name}`,
      "-t",
      `${IMAGE}:${name}`,
      variants,
    ]);
  };
  const runScript = (file: string): string =>
    `COPY ${file} /app/${file}\n` +
    `ENTRYPOINT ["/tini","--","deno","run","-A","/app/${file}"]\n`;
  await variant("v2", marker("v2"));
  // A release that starts but never reports healthy.
  await variant(
    "broken",
    marker("broken") +
      'HEALTHCHECK --interval=1s --timeout=1s --retries=2 --start-period=1s CMD ["false"]\n',
  );
  await variant("v4", marker("v4"));
  // A release that migrates, then fails: the rollback has to restore the database.
  await Deno.writeTextFile(
    `${variants}/migrate-and-fail.ts`,
    [
      'import { openDb } from "./server/db.ts";',
      'openDb("/data");',
      'await Deno.writeTextFile("/data/.migrate-probe", "1");',
      "Deno.exit(1);",
      "",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    `${variants}/018_host_update_probe.sql`,
    "CREATE TABLE host_update_probe (id INTEGER PRIMARY KEY, at INTEGER NOT NULL);\n",
  );
  await variant(
    "migrate",
    marker("migrate") +
      "COPY 018_host_update_probe.sql /app/db/migrations/\n" +
      runScript("migrate-and-fail.ts"),
  );
  // The same, then it points the database and the #45 copy at a host path: the restore
  // must run without following them.
  await Deno.writeTextFile(
    `${variants}/019_host_update_attack.sql`,
    "CREATE TABLE host_update_attack (id INTEGER PRIMARY KEY);\n",
  );
  await Deno.writeTextFile(
    `${variants}/migrate-and-point-away.ts`,
    [
      'import { openDb } from "./server/db.ts";',
      'openDb("/data");',
      'for (const f of ["geode.db", "geode.db-wal", "geode.db-shm", "before-migration.sqlite"]) {',
      "  try {",
      "    Deno.removeSync(`/data/${f}`);",
      "  } catch {",
      "    // already gone",
      "  }",
      '  Deno.symlinkSync("../update-status/canary", `/data/${f}`);',
      "}",
      "Deno.exit(1);",
      "",
    ].join("\n"),
  );
  await variant(
    "attack",
    marker("attack") +
      "COPY 019_host_update_attack.sql /app/db/migrations/\n" +
      runScript("migrate-and-point-away.ts"),
  );
  // A release that migrates and then stays up, never healthy: it holds `up --wait` open
  // long enough for a kill to land inside it.
  await Deno.writeTextFile(
    `${variants}/020_host_update_stall.sql`,
    "CREATE TABLE host_update_stall (id INTEGER PRIMARY KEY);\n",
  );
  await Deno.writeTextFile(
    `${variants}/migrate-then-stall.ts`,
    [
      'import { openDb } from "./server/db.ts";',
      'openDb("/data");',
      "await new Promise(() => {});",
      "",
    ]
      .join("\n"),
  );
  // A FIFO where the #45 copy should be: a restore would open it for reading and block
  // forever, with Geode stopped and the job's lock held.
  await Deno.writeTextFile(
    `${variants}/021_host_update_fifo.sql`,
    "CREATE TABLE host_update_fifo (id INTEGER PRIMARY KEY);\n",
  );
  await Deno.writeTextFile(
    `${variants}/migrate-then-fifo.ts`,
    [
      'import { openDb } from "./server/db.ts";',
      'openDb("/data");',
      'Deno.removeSync("/data/before-migration.sqlite");',
      'new Deno.Command("mkfifo", { args: ["/data/before-migration.sqlite"] }).outputSync();',
      "Deno.exit(1);",
      "",
    ].join("\n"),
  );
  await variant(
    "fifo",
    marker("fifo") +
      "COPY 021_host_update_fifo.sql /app/db/migrations/\n" +
      runScript("migrate-then-fifo.ts"),
  );
  await variant(
    "stall",
    marker("stall") +
      "COPY 020_host_update_stall.sql /app/db/migrations/\n" +
      runScript("migrate-then-stall.ts") +
      'HEALTHCHECK --interval=60s --timeout=5s --retries=2 CMD ["false"]\n',
  );

  // Hand the compose directory to root the way the install does: the modes too, since a
  // checkout's files can be group-writable, and the guard refuses that.
  await sh([...SUDO, "chown", "-R", "root:root", dir]);
  await sh([...SUDO, "chmod", "755", dir, `${dir}/geode-update.sh`]);
  await sh([...SUDO, "chmod", "644", `${dir}/compose.yaml`, `${dir}/compose.override.yaml`]);
  await sh([...SUDO, "chmod", "600", `${dir}/.env`]);
  await sh([...SUDO, "chown", "-R", "1993:1993", dataDir]);

  await publish("base");
  console.log("==> compose up (forward profile)");
  await compose("up", "-d", "--wait", "--wait-timeout", "300");
  await waitFor(async () => (await versionNow().catch(() => "")) === "0.99.1", "0.99.1");
  ok("the stack is up", "0.99.1");

  // A real device: the plugin's own sync core, provisioned over the admin API.
  const vault = await admin("/vaults", { name: "update" }) as { vault_id: string; salt: string };
  const device = await admin(`/vaults/${vault.vault_id}/devices`, { device_name: "update" }) as {
    device_id: string;
    token: string;
  };
  const plugin = new TestPlugin({
    url: API,
    vaultId: vault.vault_id,
    deviceId: device.device_id,
    deviceToken: device.token,
    saltBytes: b64decode(vault.salt),
    pluginVersion: "0.99.1",
    deviceName: "update",
  });
  spawned = plugin;
  await plugin.start();
  plugin.fakeVault.write("note-1.md", "one");
  await plugin.flushPending();
  const heads = async (): Promise<number> => {
    const res = await fetch(`${API}/vaults/${vault.vault_id}/heads`, {
      headers: { authorization: `Bearer ${device.token}` },
    });
    const text = (await res.text()).trim();
    return text ? text.split("\n").length : 0;
  };
  await waitFor(async () => (await heads()) === 1, "the first head on the server", 30_000);
  ok("a real device is syncing", "1 head on the server");

  console.log("==> nothing new: no restart");
  const before = await container();
  await request();
  const quiet = await job();
  eq(await result(), "up-to-date", "the job's result");
  eq(await container(), before, "the container was not touched");
  if (quiet.text) throw new Error(`the job was not silent: ${quiet.text}`);
  ok("an unchanged release is not restarted, and costs no rate limit");

  console.log("==> normal update, with the device committing over a WebSocket");
  // No rate-limit reset: an up-to-date check must not use the window up.
  await publish("v2");
  await request();
  let notes = 0;
  let sampling = true;
  const writer = (async () => {
    while (sampling) {
      plugin.fakeVault.write(`live-${notes++}.md`, `note ${notes}`);
      await sleep(500);
    }
  })();
  const forward = await compose("ps", "-q", "forward");
  const updated = await job();
  sampling = false;
  await writer;
  eq(await result(), "updated", "the job's result");
  eq(await running(), await imageId("v2"), "the running image");
  // The server is the oracle: every note the device wrote has to be there, including the
  // ones committed while the container was being replaced.
  await waitFor(
    async () => (await heads()) === notes + 1,
    `${notes + 1} heads on the server, including the live ones`,
    60_000,
  );
  eq(await compose("ps", "-q", "forward"), forward, "the forwarder was not restarted");
  if (updated.text) throw new Error(`the job was not silent: ${updated.text}`);
  ok("a device kept committing through the update", `${notes} notes, all on the server`);

  console.log("==> broken release: rolled back, data kept");
  await update("broken");
  const broken = await imageId("broken");
  eq(await result(), "rolled-back", "the job's result");
  eq(await running(), await imageId("v2"), "back on the running image");
  eq(await health(), "healthy", "the rolled-back container");
  const vaults = await admin("/vaults") as Array<{ id: string }>;
  if (!vaults.some((v) => v.id === vault.vault_id)) throw new Error("the vault is gone");
  const failed = (await Deno.readTextFile(`${statusDir}/failed-image`)).trim().split(" ");
  eq(failed[0], broken, "the recorded failure");
  if (!/^\d+$/.test(failed[1] ?? "")) throw new Error(`failed-image holds no epoch: ${failed}`);
  ok("a release that never reports healthy is rolled back", "the vault survived");

  console.log("==> fixed release after that");
  await update("v4");
  eq(await result(), "updated", "the job's result");
  eq(await running(), await imageId("v4"), "the running image");
  ok("the next good release is applied");

  console.log("==> the same broken release again");
  await allowUpdate();
  await publish("broken");
  const unchanged = await container();
  const retryAt = Date.now();
  await request();
  await job();
  eq(await result(), "blocked", "a known-bad image is not started again");
  eq(await container(), unchanged, "the container was not touched");
  eq(await running(), await imageId("v4"), "the running image");
  if (Date.now() - retryAt > 20_000) {
    throw new Error("the failed image was pulled and started again");
  }
  ok("a known-bad release is reported, not retried", `${Date.now() - retryAt}ms`);

  console.log("==> a failed image is tried again after a day");
  // The record is what blocks, not the image: an old enough one expires, so a transient
  // failure cannot pin a host on the previous release.
  await allowUpdate();
  await rootWrite(`${statusDir}/failed-image`, `${await imageId("broken")} 1\n`);
  await publish("broken");
  await request();
  await job();
  eq(await result(), "rolled-back", "an expired block lets the image be tried again");
  eq(await running(), await imageId("v4"), "the running image");
  ok("a recorded failure expires after 24 hours");

  console.log("==> two runs at once");
  await allowUpdate();
  await publish("v2");
  await request();
  const timed = async (): Promise<number> => {
    const at = Date.now();
    await job();
    return Date.now() - at;
  };
  const times = await Promise.all([timed(), timed()]);
  eq(`${times.filter((ms) => ms > 5_000).length}`, "1", "how many of two runs did the work");
  eq(await result(), "updated", "the job's result");
  eq(await running(), await imageId("v2"), "the running image");
  ok("the lock keeps two runs apart", times.map((ms) => `${ms}ms`).join(" and "));

  console.log("==> repeated requests hit the rate limit");
  await request();
  await job();
  eq(await result(), "rate-limited", "a second request inside ten minutes");
  eq(await running(), await imageId("v2"), "the running image");
  ok("one update per ten minutes");

  console.log("==> a release that migrates, then fails");
  const schemaBefore = (await probeDb()).schema;
  const vaultsBefore = (await admin("/vaults") as Array<{ id: string }>).length;
  const headsBefore = await heads();
  await update("migrate");
  eq(await result(), "rolled-back", "the job's result");
  eq(await running(), await imageId("v2"), "the old image runs again");
  eq(await health(), "healthy", "the restored container");
  const probe = await probeDb();
  eq(probe.migrated, "1", "the failed image really migrated");
  eq(probe.schema, schemaBefore, "the database is the copy from before the migration");
  eq(`${probe.probe_table}`, "0", "the migration's table is gone");
  eq(`${(await admin("/vaults") as Array<{ id: string }>).length}`, `${vaultsBefore}`, "vaults");
  eq(`${await heads()}`, `${headsBefore}`, "heads on the server");
  ok("a migration that fails is undone", `schema ${schemaBefore}, vaults and heads intact`);

  console.log("==> a run killed between stop and up");
  // The state a killed run leaves: it recorded what to go back to, stopped the container,
  // and died before starting anything. Nothing asks again, so the next run has to.
  const target = await running();
  await rootWrite(`${statusDir}/started`, "");
  await rootWrite(`${statusDir}/recover`, `${target}\n`);
  await compose("stop", "geode");
  const recovered = await job();
  eq(await result(), "rolled-back", "the killed run's rollback is finished");
  eq(await running(), target, "the old image is running again");
  eq(await health(), "healthy", "the recovered container");
  if (await exists(`${statusDir}/recover`)) throw new Error("the recover marker survived");
  if (recovered.text) throw new Error(`the recovery was not silent: ${recovered.text}`);
  ok("a stopped container left by a killed run is started again");

  console.log("==> a run killed while a migrating release starts");
  // A real SIGKILL this time: the release migrates, then holds the healthcheck open, so
  // the job is still inside `up --wait` when it dies.
  const healthy = await running();
  const schemaAtKill = (await probeDb()).schema;
  const headsAtKill = await heads();
  await allowUpdate();
  await publish("stall");
  await request();
  const killed = new Deno.Command(
    SUDO.length ? SUDO[0] : `${dir}/geode-update.sh`,
    {
      args: SUDO.length ? [SUDO[1], `${dir}/geode-update.sh`] : [],
      cwd: dir,
      stdout: "null",
      stderr: "null",
    },
  ).spawn();
  await waitFor(() => exists(`${statusDir}/recover`), "the recover marker", 60_000);
  // Kill it only once the failing image actually runs, so `up --wait` is still waiting:
  // its healthcheck stays "starting" for a minute.
  await waitFor(
    async () => (await running().catch(() => "")) === await imageId("stall"),
    "the failing image to run",
    60_000,
  );
  await sh([...SUDO, "pkill", "-9", "-f", `${dir}/[g]eode-update.sh`]);
  await killed.status;
  eq(await result(), "running", "the dead run left a running result");
  eq(await running(), await imageId("stall"), "the failed image was left running");
  const afterKill = await job();
  eq(await result(), "rolled-back", "the recovery rolled back");
  eq(await running(), healthy, "the old image runs again");
  eq(await health(), "healthy", "the recovered container");
  eq((await probeDb()).schema, schemaAtKill, "the migration was undone");
  eq(`${await heads()}`, `${headsAtKill}`, "heads on the server");
  if (await exists(`${statusDir}/recover`)) throw new Error("the recover marker survived");
  if (afterKill.text) throw new Error(`the recovery was not silent: ${afterKill.text}`);
  ok("a kill inside up --wait is finished by the next run", "migration undone, data kept");

  console.log("==> the guard refuses anything another user can write");
  const keptResult = await Deno.readTextFile(`${statusDir}/result`);
  const refusals: Array<[string, { code: number; text: string }]> = [];
  await sh([...SUDO, "chmod", "777", dir]);
  refusals.push(["directory", await job()]);
  await sh([...SUDO, "chmod", "755", dir]);
  // A writable compose.yaml is root too: it can mount anything into the container.
  await sh([...SUDO, "chmod", "666", `${dir}/compose.yaml`]);
  refusals.push(["compose.yaml", await job()]);
  await sh([...SUDO, "chmod", "644", `${dir}/compose.yaml`]);
  // A compose.override.yaml is merged by root's compose too: it can add mounts, or a
  // service of its own.
  await sh([...SUDO, "chown", `${Deno.uid()}:${Deno.gid()}`, `${dir}/compose.override.yaml`]);
  refusals.push(["compose.override.yaml", await job()]);
  await sh([...SUDO, "chown", "root:root", `${dir}/compose.override.yaml`]);
  // A symlink is refused by its own 0777 mode: nothing dereferences it.
  await Deno.copyFile(`${ROOT}geode-update.sh`, `${work}/elsewhere.sh`);
  await sh([...SUDO, "rm", `${dir}/geode-update.sh`]);
  await sh([...SUDO, "ln", "-s", `${work}/elsewhere.sh`, `${dir}/geode-update.sh`]);
  refusals.push(["script", await job()]);
  await sh([...SUDO, "rm", `${dir}/geode-update.sh`]);
  await sh([...SUDO, "install", "-m", "0755", `${ROOT}/geode-update.sh`, `${dir}/geode-update.sh`]);
  for (const [what, refused] of refusals) {
    if (refused.code === 0) throw new Error(`the job ran with a writable ${what}`);
    if (!/owned by root|writable by group or other/.test(refused.text)) {
      throw new Error(`no reason on stderr for the ${what}: ${refused.text}`);
    }
  }
  eq(await Deno.readTextFile(`${statusDir}/result`), keptResult, "the state it left alone");
  // Started as `app/geode-update.sh` from the parent, it must still find itself.
  const relative = await exec([...SUDO, "app/geode-update.sh"], {}, parent);
  eq(`${relative.code}`, "0", "the job started by a relative path");
  // A root-owned override still counts: compose merges it, so the label has to be there.
  eq(
    await sh([
      "docker",
      "inspect",
      "--format",
      '{{index .Config.Labels "geode.update.test"}}',
      await container(),
    ]),
    "root-owned override",
    "a root-owned compose.override.yaml is used",
  );
  ok("root refuses a writable directory, compose file or override", "and uses a root's override");

  console.log("==> Geode cannot write the status folder");
  const geode = await container();
  const write = await exec(["docker", "exec", geode, "sh", "-c", "echo x > /update-status/result"]);
  if (write.code === 0 || !write.text.includes("Read-only file system")) {
    throw new Error(`the container wrote /update-status: ${write.code} ${write.text}`);
  }
  // flock needs a readable file, not a writable one, and it works across a bind mount: a
  // lock inside /update-status could be held by a compromised Geode forever, every run
  // would exit quietly, and the image that fixes it would never be pulled.
  const listed = await sh(["docker", "exec", geode, "ls", "-a", "/update-status"]);
  const locks = listed.split("\n").filter((n) => n === "lock" || n.endsWith(".lock"));
  if (locks.length) throw new Error(`a lock is reachable from the container: ${locks}`);
  ok("the status folder is read-only inside the container", "nothing in it can be locked");

  console.log("==> attacks from inside Geode");
  const canary = `${statusDir}/canary`;
  const canaryText = "canary\n";
  await rootWrite(canary, canaryText);
  const hostsSum = (): Promise<string> => sh(["sha256sum", "/etc/passwd", canary]);
  const hostsBefore = await hostsSum();

  await sh([
    "docker",
    "exec",
    geode,
    "ln",
    "-s",
    "../update-status/canary",
    "/data/update-request",
  ]);
  await job();
  if (await exists(`${dataDir}/update-request`)) throw new Error("a request link survived");
  eq(await Deno.readTextFile(canary), canaryText, "a request link to a host file");

  await sh([
    "docker",
    "exec",
    geode,
    "sh",
    "-c",
    "mkdir -p /data/update-request/sub && ln -s ../../update-status/canary /data/update-request/sub/c",
  ]);
  await job();
  if (await exists(`${dataDir}/update-request`)) throw new Error("a request directory survived");
  eq(await Deno.readTextFile(canary), canaryText, "a request directory of links");

  await sh([
    "docker",
    "exec",
    geode,
    "sh",
    "-c",
    "printf '%s\\n' 'touch /update-status/PWNED' '$(touch /update-status/PWNED)' " +
    "'; touch /update-status/PWNED' > /data/update-request",
  ]);
  await job();
  if (await exists(`${statusDir}/PWNED`)) throw new Error("the request ran as a command");
  ok("a request is a name, never a path or a command");

  console.log("==> a FIFO where the copy should be");
  // The copy db.ts took is replaced by a FIFO. Opening it for reading blocks forever, and
  // Geode is stopped with the lock held by then, so the run has to finish without it.
  const schemaBeforeFifo = (await probeDb()).schema;
  await allowUpdate();
  await publish("fifo");
  await request();
  const fifoRun = await boundedJob(120);
  if (fifoRun === 137 || fifoRun === 124) {
    throw new Error("the job hung on a FIFO where the copy should be");
  }
  eq(await result(), "rolled-back", "a FIFO is not a copy, so the old image starts");
  eq(await health(), "healthy", "the old image came up");
  const afterFifo = await probeDb();
  if (afterFifo.schema === schemaBeforeFifo) throw new Error("the FIFO copy was restored anyway");
  eq(await hostsSum(), hostsBefore, "no host file was written");
  if (!(await lockFree())) throw new Error("the job still holds the lock");
  ok(
    "a FIFO where the copy should be cannot hang the job",
    `schema ${schemaBeforeFifo} -> ${afterFifo.schema}`,
  );

  console.log("==> the copy is a link to a host file");
  await allowUpdate();
  await publish("attack");
  await request();
  const linkRun = await boundedJob(120);
  if (linkRun === 137 || linkRun === 124) {
    throw new Error("the job hung on a linked copy");
  }
  eq(await result(), "rollback-failed", "a linked copy leaves the old image nothing to start on");
  eq(await hostsSum(), hostsBefore, "no host file was written");
  if (!(await lockFree())) throw new Error("the job still holds the lock");
  ok("a linked copy is not a copy either", "rollback-failed, no host file touched");

  console.log("==> all checks passed");
} catch (error) {
  console.error(`==> failed: ${chain(error)}`);
  for (const args of [["ps", "-a"], ["logs", "--no-color", "--tail", "30"]]) {
    const dumped = await exec([...SUDO, "docker", "compose", ...args], {}, dir)
      .catch(() => ({ text: "" }));
    console.error(dumped.text);
  }
  for (const file of ["result", "failed-image", "last-update", "recover"]) {
    console.error(`${file}: ${await Deno.readTextFile(`${statusDir}/${file}`).catch(() => "-")}`);
  }
  throw error;
} finally {
  spawned?.stop();
  const steps = [
    [...SUDO, "docker", "compose", "--profile", "*", "down", "-v", "--remove-orphans"],
    ["docker", "rm", "--force", `${PROJECT}-registry`],
  ];
  for (const step of steps) {
    const done = await exec(step, {}, dir);
    if (done.code !== 0) console.warn(`cleanup failed: ${step.join(" ")}\n${done.text}`);
  }
  const refs = await exec(["docker", "images", "--format", "{{.Repository}}:{{.Tag}}"]);
  for (const ref of refs.out.split("\n")) {
    if (!ref.startsWith(`${IMAGE}:`) && !ref.startsWith(`${REG}/geode:`)) continue;
    const done = await exec(["docker", "image", "rm", "--force", ref]);
    if (done.code !== 0) console.warn(`cleanup failed: ${ref}\n${done.text}`);
  }
  const removed = await exec([...SUDO, "rm", "-rf", dir]);
  if (removed.code !== 0) console.warn(`cleanup failed: ${removed.text}`);
  await Deno.remove(parent, { recursive: true }).catch((e) =>
    console.warn(`cleanup failed: ${parent}: ${e.message}`)
  );
}
