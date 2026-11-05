// Docker smoke test (#37): builds the image and drives compose.yaml end to end on this
// machine's architecture. The `Docker smoke` CI job runs it on linux/amd64 and
// linux/arm64; `deno run -A scripts/docker-smoke.ts` runs it by hand.
//
// Covers what only a container breaks: /version and an admin request, data across a
// recreate, non-root on a read-only rootfs, a quick stop, the disk-usage route (statvfs
// is read through FFI, so a wrong struct layout shows up as a wrong `total`), a WebSocket
// held open for two minutes through the bundled Caddy, every credential header absent from
// Caddy's log, the default publish address, the admin rate-limit bucket behind each front,
// and the routes out. Each run uses its own project, image and temp dir, and removes all
// of them.

import { PROTOCOL_VERSION } from "../core/protocol.ts";

const ROOT = new URL("..", import.meta.url).pathname;
// A concurrent run must not collide: its own compose project, image tag and networks.
const RUN = crypto.randomUUID().slice(0, 8);
const IMAGE = `geode-smoke-${RUN}:local`;
const PROJECT = `geode-smoke-${RUN}`;
// Caddy's site address and the name in its certificate.
const DOMAIN = "localhost";
const BASE = `https://${DOMAIN}`;
const CA_PATH = "/data/caddy/pki/authorities/local/root.crt";
const WS_HOLD_MS = 130_000;
const ADMIN = crypto.randomUUID();
// Everything that must never reach a log, for the failure dump below.
const secrets: string[] = [ADMIN];
const version = (JSON.parse(await Deno.readTextFile(`${ROOT}package.json`)) as { version: string })
  .version;

// Deno reads DENO_CERT when the process starts and the global WebSocket has no per-client TLS
// configuration, so the socket check runs here, in a child of this script started with the CA
// in its environment. The token rides the environment, not argv: /proc/<pid>/cmdline is public.
if (Deno.args[0] === "--ws-check") {
  const [, url, deviceId] = Deno.args;
  const socket = await openSocket(url, deviceId, Deno.env.get("GEODE_SMOKE_WS_TOKEN") ?? "");
  await new Promise((resolve) => setTimeout(resolve, WS_HOLD_MS));
  const state = socket.readyState;
  socket.close();
  Deno.exit(state === WebSocket.OPEN ? 0 : 1);
}

const dir = await Deno.makeTempDir({ prefix: `geode-docker-${RUN}-` });
const dataDir = `${dir}/data`;
const caFile = `${dir}/caddy-root.crt`;
await Deno.mkdir(dataDir);
await Deno.writeTextFile(`${dir}/override.yaml`, `services:\n  geode:\n    image: ${IMAGE}\n`);
const composeBase = [
  "docker",
  "compose",
  "-f",
  `${ROOT}compose.yaml`,
  "-f",
  `${dir}/override.yaml`,
  "-p",
  PROJECT,
  "--project-directory",
  dir,
];
const token = { GEODE_ADMIN_TOKEN: ADMIN };

// There is no default compose profile, so each front needs its name in the environment.
// GEODE_TRUST_PROXY=1 because the front is a proxy in another container (.env.docker.example).
const HTTPS = { COMPOSE_PROFILES: "https", GEODE_DOMAIN: DOMAIN, GEODE_TRUST_PROXY: "1" };
let phase: Record<string, string> = HTTPS;

// Trusts Caddy's CA for every fetch in this process. DENO_CERT would have to be set before
// the process starts to do the same, which this script cannot do: the CA does not exist yet.
let client: Deno.HttpClient | undefined;
type FetchInit = RequestInit & { client?: Deno.HttpClient };

/** fetch over the trusted client: every https call in this script goes through here. */
function api(url: string, init: FetchInit = {}): Promise<Response> {
  const opts: FetchInit = { ...init, client };
  return fetch(url, opts);
}

/** Exit code, stdout, and both streams together, for a command that may fail. */
async function exec(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string; text: string }> {
  const result = await new Deno.Command(args[0], {
    args: args.slice(1),
    env: { ...Deno.env.toObject(), ...env },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const out = new TextDecoder().decode(result.stdout).trim();
  const text = `${out}\n${new TextDecoder().decode(result.stderr)}`.trim();
  return { code: result.code, out, text };
}

/** Run a command and fail loudly with both streams on a non-zero exit. */
async function sh(args: string[], env: Record<string, string> = {}): Promise<string> {
  const { code, out, text } = await exec(args, env);
  if (code !== 0) throw new Error(`failed: ${args.join(" ")}\n${text}`);
  return out;
}

function compose(args: string[], env: Record<string, string> = {}): Promise<string> {
  return sh([...composeBase, ...args], { ...token, ...phase, ...env });
}

/** Every profile's containers, not just the active one: profiles do not share a `down`. */
function downArgs(volumes: boolean): string[] {
  return [
    ...composeBase,
    "--profile",
    "*",
    "down",
    ...(volumes ? ["-v"] : []),
    "--remove-orphans",
  ];
}

const down = (volumes = false): Promise<string> => sh(downArgs(volumes), token);

/** Docker writes as root and the server as 1993, so both directions need a chown. */
function chownTree(path: string, owner: string): string[] {
  return [
    "docker",
    "run",
    "--rm",
    "--user",
    "0",
    "-v",
    `${path}:/target`,
    "--entrypoint",
    "chown",
    IMAGE,
    "-R",
    owner,
    "/target",
  ];
}

/** The whole failure, not just its top layer: `fetch failed` alone says nothing. */
function chain(e: unknown, depth = 0): string {
  if (!(e instanceof Error) || depth > 5) return String(e);
  const cause = (e as Error & { cause?: unknown }).cause;
  return `${e.name}: ${e.message}${cause === undefined ? "" : ` <- ${chain(cause, depth + 1)}`}`;
}

function redact(text: string): string {
  return secrets.reduce((out, secret) => out.replaceAll(secret, "REDACTED"), text)
    .replace(/bearer\.[A-Za-z0-9_-]+/g, "bearer.REDACTED");
}

/**
 * What the stack looked like when a check failed. Without this a CI failure is a single
 * timeout line: the container states, both logs and Geode's own view of itself are the
 * only way to tell a dead container from a front or publish problem.
 */
async function dump(): Promise<void> {
  console.error("==> stack state");
  for (const args of [["ps", "-a"], ["logs", "--no-color", "--tail", "50"]]) {
    const result = await exec([...composeBase, ...args], { ...token, ...phase });
    console.error(redact(result.text));
  }
  // Can the host reach the published port at all, over IPv4, over IPv6, and with the CA?
  // Verification off for the two literals, on for `localhost`: that separates a broken
  // publish from a broken TLS trust in one look.
  const probes: Array<[string, string[]]> = [
    ["https://127.0.0.1 -k", ["-k", "https://127.0.0.1/version"]],
    ["https://[::1] -k", ["-k", "https://[::1]/version"]],
    ["https://localhost CA", ["--cacert", caFile, "https://localhost/version"]],
  ];
  for (const [label, args] of probes) {
    const result = await exec(["curl", "-sv", "--max-time", "5", ...args]);
    const lines = result.text.split("\n").filter((line) => /^\*|^< HTTP\//.test(line));
    console.error(`==> curl ${label}: ${redact(lines.join("\n")) || `exit ${result.code}`}`);
  }
  for (const file of ["all", "lo"]) {
    const result = await exec(["cat", `/proc/sys/net/ipv6/conf/${file}/disable_ipv6`]);
    console.error(`==> ipv6 ${file}/disable_ipv6: ${result.out || `exit ${result.code}`}`);
  }
  // Which trust-store knobs the runner thinks are set: DENO_CERT only counts if the process
  // saw it at startup, and SSL_CERT_FILE/SSL_CERT_DIR make Deno build its store early.
  const env = await exec(["sh", "-c", "env | grep -iE 'deno|cert|ssl' | sort"]);
  console.error(`==> deno/cert/ssl env: ${redact(env.out) || "(none)"}`);
  // Where `localhost` points, and whether the host really listens on the published ports:
  // that is the difference between a broken publish and a broken TLS trust.
  for (const args of [["getent", "hosts", "localhost"], ["ss", "-ltn"]]) {
    const result = await exec(args);
    const lines = args[0] === "ss"
      ? result.out.split("\n").filter((line) => /:(80|443) /.test(line)).join("\n")
      : result.out;
    console.error(`==> ${args.join(" ")}: ${lines || `(exit ${result.code})`}`);
  }
  const geode = await compose(["ps", "-q", "geode"]).catch(() => "");
  if (!geode) return;
  const inside = await exec([
    "docker",
    "exec",
    geode,
    "deno",
    "eval",
    "--allow-net=127.0.0.1:8080",
    "const r = await fetch('http://127.0.0.1:8080/version'); console.log(r.status, await r.text())",
  ]);
  console.error(`==> Geode's own /version: ${redact(inside.text) || `exit ${inside.code}`}`);
}

function ok(name: string, detail = ""): void {
  console.log(`ok    ${name}${detail ? ` (${detail})` : ""}`);
}

async function waitFor(check: () => Promise<boolean>, what: string, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (e) {
      // Swallowed so the wait retries, but never silently: a timeout has to say why.
      last = chain(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (last failure: ${last})` : ""}`);
}

async function admin(path: string, init: RequestInit = {}): Promise<Response> {
  return await api(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

async function ready(): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const res = await api(`${BASE}/version`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = chain(e);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${BASE}/version (last: ${last})`);
}

/** Caddy mints its own CA for a local domain; every later fetch and socket trusts it. */
async function trustFrontCa(): Promise<string> {
  const https = await compose(["ps", "-q", "https"]);
  // Poll the copy, not the file's existence: a PEM caught mid-write, or one this process
  // cannot read, fails every later connection and looks like a dead stack.
  await waitFor(async () => {
    const copied = await exec(["docker", "cp", `${https}:${CA_PATH}`, caFile]);
    if (copied.code !== 0) return false;
    const pem = await Deno.readTextFile(caFile).catch(() => "");
    return pem.includes("-----END CERTIFICATE-----");
  }, "Caddy's local CA");
  return await Deno.readTextFile(caFile);
}

/** A handshaken socket, left open so a front's idle timeout would show. */
async function openSocket(url: string, deviceId: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(url, `bearer.${token}`);
  const ack = new Promise<void>((resolve, reject) => {
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string" && event.data.includes("server_hello_ack")) resolve();
    });
    ws.addEventListener("close", (event) => reject(new Error(`closed ${event.code}`)));
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
  await new Promise<void>((resolve) => ws.addEventListener("open", () => resolve()));
  ws.send(JSON.stringify({
    type: "client_hello",
    protocol_version: PROTOCOL_VERSION,
    device_id: deviceId,
    last_seen_seq: -1,
  }));
  await ack;
  return ws;
}

function freePort(): number {
  const listener = Deno.listen({ port: 0 });
  const { port } = listener.addr as Deno.NetAddr;
  listener.close();
  return port;
}

try {
  console.log(`==> build ${IMAGE} (version ${version})`);
  await sh(["docker", "build", "--quiet", "--build-arg", `VERSION=${version}`, "-t", IMAGE, ROOT]);
  ok("image builds");

  // The container runs as uid 1993, so ./data has to belong to it before compose starts.
  await sh(chownTree(dataDir, "1993:1993"));

  // A published port bypasses ufw, so the front must not leave loopback unless asked.
  const config = JSON.parse(
    await compose(["--profile", "forward", "config", "--format", "json"]),
  ) as {
    services: { forward: { ports: Array<{ host_ip?: string; published?: string }> } };
  };
  const [port0] = config.services.forward.ports;
  if (port0?.host_ip !== "127.0.0.1" || port0?.published !== "8080") {
    throw new Error(`default publish is ${JSON.stringify(port0)}, want 127.0.0.1:8080`);
  }
  ok("front publishes on 127.0.0.1 by default");

  console.log(`==> compose up (https profile, domain ${DOMAIN})`);
  // --wait turns a container that dies into a loud `up` failure with its state, instead of
  // a 90 s timeout that says nothing; it also removes the race with Geode's first listen.
  await compose(["up", "-d", "--wait", "--wait-timeout", "120"]);
  const caPem = await trustFrontCa();
  client = Deno.createHttpClient({ caCerts: [caPem] });
  await ready();

  const reported = await (await api(`${BASE}/version`)).json() as { version: string };
  if (reported.version !== version) {
    throw new Error(`/version reports ${reported.version}, package.json says ${version}`);
  }
  ok("/version matches package.json");

  const listed = await admin("/vaults");
  if (listed.status !== 200 || (await listed.text()) !== "[]") {
    throw new Error(`admin GET /vaults failed: ${listed.status}`);
  }
  const vault = await (await admin("/vaults", {
    method: "POST",
    body: JSON.stringify({ name: "smoke" }),
  })).json() as { vault_id: string };
  const device = await (await admin(`/vaults/${vault.vault_id}/devices`, {
    method: "POST",
    body: JSON.stringify({ device_name: "smoke" }),
  })).json() as { device_id: string; token: string };
  secrets.push(device.token);
  ok("admin request works", "created a vault and a device");

  const geode = await compose(["ps", "-q", "geode"]);
  const uid = await sh(["docker", "exec", geode, "id", "-u"]);
  const readOnly = await sh([
    "docker",
    "inspect",
    "--format",
    "{{.HostConfig.ReadonlyRootfs}}",
    geode,
  ]);
  const write = await exec(["docker", "exec", geode, "bash", "-c", "touch /app/probe"]);
  if (uid !== "1993" || readOnly !== "true" || write.code === 0) {
    throw new Error(`uid=${uid} readOnly=${readOnly} write=${write.code} ${write.text}`);
  }
  ok("runs as uid 1993 on a read-only rootfs");

  // statvfs crosses FFI with a fixed struct layout, so comparing `total` with the host's own
  // view of the same filesystem is what catches a layout that arm64 does not share.
  const storage = await (await api(`${BASE}/vaults/${vault.vault_id}/storage`, {
    headers: { authorization: `Bearer ${device.token}` },
  })).json() as { total: number; free: number; used: number };
  const [blocks, blockSize] = (await sh(["stat", "-f", "-c", "%b %S", dataDir])).split(" ").map(
    Number,
  );
  if (storage.total !== blocks * blockSize || storage.used <= 0 || storage.free <= 0) {
    throw new Error(`storage ${JSON.stringify(storage)}, filesystem holds ${blocks * blockSize}`);
  }
  ok("disk usage route matches the filesystem", `${storage.total} bytes`);

  console.log(`==> holding a WebSocket for ${WS_HOLD_MS / 1000}s through Caddy`);
  const socket = await exec([
    Deno.execPath(),
    "run",
    "-A",
    new URL(import.meta.url).pathname,
    "--ws-check",
    `${BASE.replace("https", "wss")}/vaults/${vault.vault_id}/sync`,
    device.device_id,
  ], {
    DENO_CERT: caFile,
    GEODE_SMOKE_WS_TOKEN: device.token,
  });
  if (socket.code !== 0) {
    throw new Error(`the socket did not stay open for ${WS_HOLD_MS}ms: ${socket.text}`);
  }
  ok("WebSocket held open for over two minutes through Caddy");

  // Every credential header has to stay out of the access log: Caddy redacts Authorization
  // and cookies only, and a field name with the wrong case deletes nothing (server.md §9).
  // This call needs both: a device token, a well-formed auth key, and the admin header.
  const authKey = (crypto.randomUUID() + crypto.randomUUID()).replaceAll("-", "");
  secrets.push(authKey);
  const authed = await api(`${BASE}/vaults/${vault.vault_id}/auth`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${device.token}`,
      "x-geode-admin-token": ADMIN,
      "x-geode-auth-key": authKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ auth_key: authKey }),
  });
  if (authed.status !== 200) throw new Error(`auth probe failed: ${authed.status}`);
  const https = await compose(["ps", "-q", "https"]);
  const logs = (await exec(["docker", "logs", https])).text;
  for (
    const [name, secret] of [["device token", device.token], ["admin token", ADMIN], [
      "auth key",
      authKey,
    ]]
  ) {
    if (logs.includes(secret)) throw new Error(`Caddy's log holds the ${name} in clear`);
  }
  if (!logs.includes("/sync") || !logs.includes("/auth")) {
    throw new Error("Caddy's log does not show the requests the filter ran on");
  }
  ok("Caddy logs the sync and auth requests without any credential");

  const health = await sh(["docker", "inspect", "--format", "{{.State.Health.Status}}", geode]);
  if (health !== "healthy") throw new Error(`healthcheck reports ${health}`);
  ok("healthcheck passes without curl");

  // An untrusted client cannot pick its own address: Caddy overwrites X-Forwarded-For with
  // the real peer, so a rotating header buys no bucket.
  const bad = (xff: string) =>
    api(`${BASE}/vaults`, {
      headers: { authorization: "Bearer wrong", "x-forwarded-for": xff },
    });
  for (let i = 0; i < 5; i++) await bad(`10.0.0.${i}`);
  const limited = await bad("9.9.9.9");
  if (limited.status !== 429) {
    throw new Error(`a spoofed X-Forwarded-For escaped the bucket: ${limited.status}`);
  }
  ok("admin rate limit buckets the real peer behind Caddy");

  const stopAt = performance.now();
  await sh(["docker", "stop", geode]);
  const seconds = (performance.now() - stopAt) / 1000;
  if (seconds > 10) throw new Error(`docker stop took ${seconds}s`);
  ok("docker stop is quick", `${seconds.toFixed(2)}s`);

  console.log("==> recreate the container");
  await down();
  await compose(["up", "-d", "--wait", "--wait-timeout", "120"]);
  await ready();
  const after = await (await admin("/vaults")).json() as Array<{ id: string }>;
  if (!after.some((v) => v.id === vault.vault_id)) {
    throw new Error(`the vault did not survive the recreate: ${JSON.stringify(after)}`);
  }
  ok("data survives recreating the container");

  // internal: true leaves no default route, so the internet and the host's LAN address are
  // both unreachable. The bridge gateway is a separate story, probed below.
  const inner = await compose(["ps", "-q", "geode"]);
  const routes = await sh(["docker", "exec", inner, "cat", "/proc/net/route"]);
  const defaultRoute = routes.split("\n").slice(1).find((line) => {
    const fields = line.trim().split(/\s+/);
    return fields[1] === "00000000" && fields[2] !== "00000000";
  });
  const hostIp = await sh([
    "bash",
    "-c",
    "ip route get 1.1.1.1 | sed -n 's/.* src \\([0-9.]*\\) .*/\\1/p'",
  ]);
  if (!hostIp) throw new Error("no default route on the host: cannot test the way out");
  const tries: Array<{ code: number; text: string }> = [];
  for (const target of ["1.1.1.1:443", `${hostIp}:22`]) {
    tries.push(
      await exec([
        "docker",
        "exec",
        inner,
        "bash",
        "-c",
        `timeout 5 bash -c "exec 3<>/dev/tcp/${target}"`,
      ]),
    );
  }
  if (defaultRoute || tries.some((t) => t.code === 0)) {
    throw new Error(`Geode reached out: ${JSON.stringify({ defaultRoute, tries })}`);
  }
  ok("Geode has no route to the internet or the host's LAN address");

  // What stays open: a host service bound to 0.0.0.0 answers on the internal network's
  // gateway, and only the host's firewall decides. Reported, never asserted: the firewall
  // may block the probe port here and allow another.
  const gateway = await sh([
    "docker",
    "network",
    "inspect",
    `${PROJECT}_internal`,
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  const listener = Deno.listen({ port: 0 });
  const probePort = (listener.addr as Deno.NetAddr).port;
  const gatewayReach = await exec([
    "docker",
    "exec",
    inner,
    "bash",
    "-c",
    `timeout 5 bash -c "exec 3<>/dev/tcp/${gateway}/${probePort}"`,
  ]);
  listener.close();
  console.log(
    `info  gateway ${gateway}:${probePort} ` +
      (gatewayReach.code === 0
        ? "reachable: a shared host's firewall has to block this (server.md §11)"
        : "unreachable: the host firewall blocks it"),
  );

  console.log("==> compose up (forward profile, own-proxy setup)");
  const publishedPort = freePort();
  phase = {
    COMPOSE_PROFILES: "forward",
    GEODE_PUBLISH: `127.0.0.1:${publishedPort}`,
    GEODE_TRUST_PROXY: "1",
  };
  await down();
  await compose(["up", "-d", "--wait", "--wait-timeout", "120"]);
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${publishedPort}/version`)).ok,
    "the forwarder",
  );

  // The forwarder is a TCP relay, so what the outer proxy sets arrives untouched: with
  // GEODE_TRUST_PROXY=1 two client addresses are two buckets.
  const forwarded = (xff: string) =>
    fetch(`http://127.0.0.1:${publishedPort}/vaults`, {
      headers: { authorization: "Bearer wrong", "x-forwarded-for": xff },
    });
  for (let i = 0; i < 5; i++) await forwarded("203.0.113.7");
  const [first, second] = [await forwarded("203.0.113.7"), await forwarded("203.0.113.8")];
  if (first.status !== 429 || second.status !== 401) {
    throw new Error(`buckets: A=${first.status} (want 429) B=${second.status} (want 401)`);
  }
  ok("forwarder passes X-Forwarded-For through, one bucket per client");

  console.log("==> all checks passed");
} catch (error) {
  await dump();
  throw error;
} finally {
  client?.close();
  // uid 1993 owns ./data, so the tree has to go back to this user before it can be removed.
  const steps = [
    downArgs(true),
    chownTree(dir, `${Deno.uid()}:${Deno.gid()}`),
    ["docker", "image", "rm", "--force", IMAGE],
  ];
  for (const step of steps) {
    const result = await exec(step, token);
    if (result.code !== 0) console.warn(`cleanup failed: ${step.join(" ")}\n${result.text}`);
  }
  await Deno.remove(dir, { recursive: true }).catch((e) =>
    console.warn(`cleanup failed: ${dir}: ${e.message}`)
  );
}
