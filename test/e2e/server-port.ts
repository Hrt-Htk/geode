// Frees the fixed phone/hybrid E2E server port left by a killed run (#519):
// kills only verified Geode E2E servers; any other holder fails the run.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function parseListenerPids(ssOutput: string, port: number): number[] {
  const pids = new Set<number>();
  for (const line of ssOutput.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== "LISTEN") continue;
    const local = fields[3] ?? "";
    const localPort = Number(local.slice(local.lastIndexOf(":") + 1));
    if (localPort !== port) continue;
    const pid = line.match(/pid=(\d+)/)?.[1];
    if (pid) pids.add(Number(pid));
  }
  return [...pids];
}

export function isGeodeE2EServer(args: string[], port: number): boolean {
  if (!args.some((a) => a.endsWith("server/main.ts"))) return false;
  const portIdx = args.indexOf("--port");
  if (portIdx === -1 || args[portIdx + 1] !== String(port)) return false;
  const dirIdx = args.indexOf("--data-dir");
  return dirIdx !== -1 && (args[dirIdx + 1] ?? "").includes("geode-e2e-server-");
}

function readCmdline(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function freeServerPort(port: number): Promise<void> {
  const ss = spawnSync("ss", ["-ltnp"], { encoding: "utf8", timeout: 10_000 });
  if (ss.status !== 0 || ss.error) {
    throw new Error(`freeServerPort: ss failed: ${ss.error?.message ?? ss.stderr?.trim()}`);
  }
  const pids = parseListenerPids(ss.stdout ?? "", port);
  if (pids.length === 0) return;

  // Verify every listener before killing any: never kill one and then refuse
  // the other, leaving the port half-freed.
  for (const pid of pids) {
    if (!isAlive(pid)) continue; // died between ss and the check: port frees itself
    const args = readCmdline(pid);
    if (!isGeodeE2EServer(args, port)) {
      throw new Error(
        `port ${port} is held by a non-Geode process (pid ${pid}: ${
          args.join(" ") || "unknown"
        }): ` +
          "free it manually; refusing to kill it",
      );
    }
  }

  for (const pid of pids) {
    if (!isAlive(pid)) continue;
    process.kill(pid, "SIGTERM");
    const deadline = Date.now() + 3_000;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isAlive(pid)) process.kill(pid, "SIGKILL");
  }
}
