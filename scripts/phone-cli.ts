// Wrapper for ad hoc phone commands that takes the phone lock first (#496).
//
//   deno task phone -- <adb args...>   run adb under the lock
//   deno task phone:cdp -- "<js>"      eval JS in the Obsidian WebView under the lock
//   deno task phone:status             print the current lock holder (no lock needed)
//
// Never call adb directly on the shared test phone: every access goes through
// this task so concurrent E2E runs and this queue exclude each other.

import { cdpEvalOnDevice } from "../test/e2e/phone-cdp.ts";
import { requireEnv } from "../test/e2e/env.ts";
import {
  acquirePhoneLock,
  formatQueue,
  formatStatus,
  lockHeld,
  type LockProgress,
  readSidecar,
} from "../test/e2e/phone-lock.ts";
import { readQueue } from "../test/e2e/phone-queue.ts";

const ADB = "adb";

async function main(): Promise<void> {
  // `deno task phone -- <args>` passes the `--` separator through: drop it
  // before dispatch (it is never a legit adb arg in this project).
  const args = Deno.args.filter((a) => a !== "--");
  const [sub, ...rest] = args;
  if (sub === "status") {
    const holder = readSidecar();
    const progress: LockProgress | null = holder && holder.total != null
      ? { project: holder.project ?? "", done: holder.done ?? 0, total: holder.total }
      : null;
    const queue = readQueue();
    const lines = [
      holder
        ? formatStatus(holder, Date.now(), progress)
        : lockHeld()
        ? "phone lock: held (shell flock user; no sidecar)"
        : "phone lock: free",
    ];
    if (queue.length) lines.push(formatQueue(queue));
    console.log(lines.join("\n"));
    return;
  }

  // No ADB default: the serial comes from ANDROID_SERIAL (see .env.example), so
  // `deno task phone` never targets a device baked into the repo. Resolved before
  // the lock, so a misconfigured run fails instead of queueing.
  const serial = requireEnv("ANDROID_SERIAL");

  const { release } = await acquirePhoneLock();
  try {
    if (sub === "cdp") {
      const expr = rest[0];
      if (!expr) throw new Error("usage: deno task phone:cdp -- '<js to eval in the WebView>'");
      console.log(await cdpEvalOnDevice(serial, expr));
      return;
    }
    // adb passthrough: stdout/stderr inherit so binary output (screencap) is preserved
    const { code } = await new Deno.Command(ADB, {
      args: ["-s", serial, ...args],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (code !== 0) Deno.exit(code);
  } finally {
    await release();
  }
}

await main();
