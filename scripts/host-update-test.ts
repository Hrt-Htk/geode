// Host update job (#43): `geode-update.sh` end to end, against a throwaway registry on
// this machine. The `Docker smoke` CI job runs it on linux/amd64 and linux/arm64 next to
// `scripts/docker-smoke.ts`; `deno run -A scripts/host-update-test.ts` runs it by hand.
//
// Needs Docker, and root or passwordless sudo unless it already runs as root: the job
// runs as root and this script reads the state it leaves behind.
//
// The stack is plain HTTP through the bundled forwarder, so the real plugin sync core can
// talk to it with the global fetch and WebSocket (no Caddy CA to trust).

import { b64decode } from "../core/protocol.ts";
import { TestPlugin } from "../test/two-vault-driver.ts";
import { chain, chownTree, exec, freePort, sh, waitFor } from "./docker-helpers.ts";

const ROOT = new URL("..", import.meta.url).pathname;
// A concurrent run must not collide: its own compose project, image tag and networks.
const RUN = crypto.randomUUID().slice(0, 8);
const IMAGE = `geode-update-${RUN}/geode`;
const PROJECT = `geode-update-${RUN}`;
const ADMIN = crypto.randomUUID();
const SUDO = Deno.uid() === 0 ? [] : ["sudo", "-n"];

const dir = await Deno.makeTempDir({ prefix: `geode-update-${RUN}-` });
const dataDir = `${dir}/data`;
const statusDir = `${dir}/update-status`;
const probeDir = `${dir}/probe`;
const variants = `${dir}/variants`;
const registryPort = freePort();
const REG = `127.0.0.1:${registryPort}`;
const published = freePort();
const API = `http://127.0.0.1:${published}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ok(name: string, detail = ""): void {
  console.log(`ok    ${name}${detail ? ` (${detail})` : ""}`);
}

function eq(actual: string, want: string, what: string): void {
  if (actual !== want) throw new Error(`${what}: got "${actual}", want "${want}"`);
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

/** compose in the job's directory, with the job's own file discovery and `.env`. */
function compose(...args: string[]): Promise<string> {
  return sh(["docker", "compose", ...args], {}, dir);
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

/** A request, the way #44 will leave one: a file in Geode's data folder. */
function request(): Promise<string> {
  return container().then((id) => sh(["docker", "exec", id, "touch", "/data/update-request"]));
}

/**
 * Every attempt is rate limited for ten minutes, and the countdown lives in the state
 * folder this test owns: clear it to make the next request a real one.
 */
function allowUpdate(): Promise<string> {
  return sh([...SUDO, "rm", "-f", `${statusDir}/last-update`]);
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

/** The device's transport and reconciler timers keep the event loop alive. */
let spawned: TestPlugin | undefined;

async function imageId(name: string): Promise<string> {
  return sh(["docker", "image", "inspect", "--format", "{{.Id}}", `${REG}/geode:${name}`]);
}

/** The image the service runs. Every variant is the same build plus one layer, so the
 * image id, not `/version`, is what says which one a request applied. */
async function running(): Promise<string> {
  return sh(["docker", "inspect", "--format", "{{.Image}}", await container()]);
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

  // The compose directory the job works in: the repo's compose.yaml, its own image, its
  // own project name, and the request folder's owner.
  await Deno.mkdir(dataDir);
  await Deno.mkdir(statusDir);
  await Deno.mkdir(probeDir);
  await Deno.mkdir(variants);
  await Deno.copyFile(`${ROOT}geode-update.sh`, `${dir}/geode-update.sh`);
  await Deno.copyFile(`${ROOT}compose.yaml`, `${dir}/compose.yaml`);
  // The database probe: a throwaway container as uid 1993, only the data folder mounted.
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
  await Deno.writeTextFile(
    `${dir}/compose.override.yaml`,
    `services:\n  geode:\n    image: ${REG}/geode:latest\n`,
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
      "COPY migrate-and-fail.ts /app/migrate-and-fail.ts\n" +
      'ENTRYPOINT ["/tini","--","deno","run","-A","/app/migrate-and-fail.ts"]\n',
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
      "COPY migrate-and-point-away.ts /app/migrate-and-point-away.ts\n" +
      'ENTRYPOINT ["/tini","--","deno","run","-A","/app/migrate-and-point-away.ts"]\n',
  );

  await sh(chownTree(`${IMAGE}:base`, dataDir, "1993:1993"));
  await publish("base");
  console.log("==> compose up (forward profile)");
  await compose("up", "-d", "--wait", "--wait-timeout", "120");
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
  await job();
  eq(await result(), "up-to-date", "the job's result");
  eq(await container(), before, "the container was not touched");
  ok("an unchanged release is not restarted");

  console.log("==> normal update, with the device committing over a WebSocket");
  await allowUpdate();
  await publish("v2");
  await request();
  let notes = 0;
  const samples: string[] = [];
  let sampling = true;
  const writer = (async () => {
    while (sampling) {
      plugin.fakeVault.write(`live-${notes++}.md`, `note ${notes}`);
      await sleep(500);
    }
  })();
  const prober = (async () => {
    while (sampling) {
      try {
        await versionNow();
        samples.push("up");
      } catch {
        samples.push("down");
      }
      await sleep(20);
    }
  })();
  const forward = await compose("ps", "-q", "forward");
  await job();
  sampling = false;
  await Promise.all([writer, prober]);
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
  ok(
    "the update took the device offline and lost nothing",
    `${samples.filter((s) => s === "down").length} of ${samples.length} probes failed`,
  );

  console.log("==> broken release: rolled back, data kept");
  await allowUpdate();
  await publish("broken");
  const broken = await imageId("broken");
  await request();
  await job();
  eq(await result(), "rolled-back", "the job's result");
  eq(await running(), await imageId("v2"), "back on the running image");
  eq(
    await sh(["docker", "inspect", "--format", "{{.State.Health.Status}}", await container()]),
    "healthy",
    "the rolled-back container",
  );
  const vaults = await admin("/vaults") as Array<{ id: string }>;
  if (!vaults.some((v) => v.id === vault.vault_id)) throw new Error("the vault is gone");
  eq((await Deno.readTextFile(`${statusDir}/failed-image`)).trim(), broken, "the recorded failure");
  ok("a release that never reports healthy is rolled back", "the vault survived");

  console.log("==> fixed release after that");
  await allowUpdate();
  await publish("v4");
  await request();
  await job();
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
  eq(await result(), "rolled-back", "the job's result");
  eq(await container(), unchanged, "the container was not touched");
  eq(await running(), await imageId("v4"), "the running image");
  if (Date.now() - retryAt > 20_000) {
    throw new Error("the failed image was pulled and started again");
  }
  ok("a known-bad release is not retried", `${Date.now() - retryAt}ms`);

  console.log("==> a release that migrates, then fails");
  const schemaBefore = (await probeDb()).schema;
  await allowUpdate();
  await publish("migrate");
  await request();
  await job();
  eq(await result(), "rolled-back", "the job's result");
  eq(await running(), await imageId("v4"), "the old image runs again");
  eq(
    await sh(["docker", "inspect", "--format", "{{.State.Health.Status}}", await container()]),
    "healthy",
    "the restored container",
  );
  const probe = await probeDb();
  eq(probe.migrated, "1", "the failed image really migrated");
  eq(probe.schema, schemaBefore, "the database is the copy from before the migration");
  eq(`${probe.probe_table}`, "0", "the migration's table is gone");
  ok("a migration that fails is undone", `schema ${schemaBefore}, table gone, copy intact`);

  console.log("==> Geode cannot write the status folder");
  const geode = await container();
  const write = await exec(["docker", "exec", geode, "sh", "-c", "echo x > /update-status/result"]);
  if (write.code === 0 || !write.text.includes("Read-only file system")) {
    throw new Error(`the container wrote /update-status: ${write.code} ${write.text}`);
  }
  ok("the status folder is read-only inside the container");

  console.log("==> attacks from inside Geode");
  const canary = `${statusDir}/canary`;
  await Deno.writeTextFile(canary, "canary\n");
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
  eq(await Deno.readTextFile(canary), "canary\n", "a request link to a host file");

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
  eq(await Deno.readTextFile(canary), "canary\n", "a request directory of links");

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

  console.log("==> repeated requests hit the rate limit");
  await allowUpdate();
  await publish("v2");
  await request();
  await job();
  eq(await result(), "updated", "the job's result");
  await request();
  await job();
  eq(await result(), "rate-limited", "a second request inside ten minutes");
  eq(await running(), await imageId("v2"), "the running image");
  ok("one update per ten minutes");

  console.log("==> two runs at once");
  await allowUpdate();
  await publish("v4");
  await request();
  const timed = async (): Promise<number> => {
    const at = Date.now();
    await job();
    return Date.now() - at;
  };
  const times = await Promise.all([timed(), timed()]);
  eq(`${times.filter((ms) => ms > 5_000).length}`, "1", "how many of two runs did the work");
  eq(await result(), "updated", "the job's result");
  eq(await running(), await imageId("v4"), "the running image");
  ok("the lock keeps two runs apart", times.map((ms) => `${ms}ms`).join(" and "));

  console.log("==> the lock without flock");
  // The mkdir fallback, and a dead run that left its lock behind. The script's PATH is
  // rewritten to a directory without flock, which is how a minimal host looks; everything
  // else is the file that ships.
  await allowUpdate();
  await publish("v2");
  const bin = `${dir}/nofock`;
  const noFlock = `${dir}/geode-update-nofock.sh`;
  await Deno.mkdir(bin);
  for (const cmd of ["cat", "date", "docker", "find", "mkdir", "rm"]) {
    await Deno.symlink(`/usr/bin/${cmd}`, `${bin}/${cmd}`);
  }
  await Deno.writeTextFile(
    noFlock,
    (await Deno.readTextFile(`${dir}/geode-update.sh`)).replace(/^PATH=.*$/m, `PATH=${bin}`),
  );
  await Deno.chmod(noFlock, 0o755);
  await Deno.mkdir(`${statusDir}/lock.d`);
  await Deno.writeTextFile(`${statusDir}/lock.d/pid`, "999999\n");
  await request();
  const locked = await exec([...SUDO, noFlock], {}, dir);
  if (locked.code !== 0) throw new Error(`the job failed without flock: ${locked.text}`);
  eq(await result(), "updated", "the job's result");
  eq(await running(), await imageId("v2"), "the running image");
  if (await exists(`${statusDir}/lock.d`)) throw new Error("the lock was left behind");
  ok("a dead run's directory lock does not wedge the job");

  console.log("==> the restore cannot be pointed at a host file");
  await allowUpdate();
  await publish("attack");
  await request();
  await job();
  const attacked = await result();
  if (attacked !== "rolled-back" && attacked !== "rollback-failed") {
    throw new Error(`a pointed-away database reported "${attacked}"`);
  }
  eq(await hostsSum(), hostsBefore, "no host file was written");
  ok("the restore refuses a symlinked copy", attacked);

  console.log("==> all checks passed");
} catch (error) {
  console.error(`==> failed: ${chain(error)}`);
  for (const args of [["ps", "-a"], ["logs", "--no-color", "--tail", "30"]]) {
    const dumped = await exec(["docker", "compose", ...args], {}, dir).catch(() => ({ text: "" }));
    console.error(dumped.text);
  }
  for (const file of ["result", "failed-image", "last-update"]) {
    console.error(`${file}: ${await Deno.readTextFile(`${statusDir}/${file}`).catch(() => "-")}`);
  }
  throw error;
} finally {
  spawned?.stop();
  const steps = [
    ["docker", "compose", "--profile", "*", "down", "-v", "--remove-orphans"],
    chownTree(`${IMAGE}:base`, dir, `${Deno.uid()}:${Deno.gid()}`),
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
  await Deno.remove(dir, { recursive: true }).catch((e) =>
    console.warn(`cleanup failed: ${dir}: ${e.message}`)
  );
}
