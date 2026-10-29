// Shared test-phone queue (#496, #500, #508): a real flock(2) on
// /tmp/geode-phone.lock that interoperates with shell users who
// `flock /tmp/geode-phone.lock -c '...'`, plus a sidecar recording the holder
// (worktree, pid, start time, run progress) for `deno task phone:status`.
//
// The lock is held by a `flock -F <lock> -c 'echo ACQUIRED; read'` child whose
// stdin is a pipe we keep open. On release we close the pipe (EOF → `read`
// returns → flock exits); if the parent is SIGKILLed, the OS closes the pipe
// write end and the child exits the same way: no orphaned lock.
//
// FIFO order (#508): each waiter registers a ticket in /tmp/geode-phone.queue/
// (test/e2e/phone-queue.ts) and only spawns the flock child once its ticket is
// at the head, so runs are served in arrival order. Pure parts
// (serialize/parse/format/position/ETA) are unit-tested in
// test/unit/e2e/phone-lock.test.ts and test/unit/e2e/phone-queue.test.ts.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename } from "node:path";
import {
  isPidAlive,
  type QueueEntry,
  queuePosition,
  readTickets,
  registerTicket,
  removeTicket,
} from "./phone-queue.ts";

export { isPidAlive } from "./phone-queue.ts";

export const LOCK_PATH = "/tmp/geode-phone.lock";
export const SIDECAR_PATH = "/tmp/geode-phone.lock.json";

export type LockProgress = { project: string; done: number; total: number };
export type LockHolder =
  & { worktree: string; pid: number; startTime: number }
  & Partial<LockProgress>;

export function serializeHolder(holder: LockHolder): string {
  return JSON.stringify(holder);
}

export function parseHolder(raw: string): LockHolder | null {
  try {
    const h = JSON.parse(raw) as Record<string, unknown>;
    const worktree = h.worktree;
    const pid = h.pid;
    const startTime = h.startTime;
    if (
      typeof worktree === "string" &&
      typeof pid === "number" &&
      Number.isInteger(pid) &&
      typeof startTime === "number" &&
      Number.isInteger(startTime)
    ) {
      const holder: LockHolder = { worktree, pid, startTime };
      if (typeof h.project === "string") holder.project = h.project;
      if (typeof h.done === "number" && Number.isInteger(h.done)) holder.done = h.done;
      if (typeof h.total === "number" && Number.isInteger(h.total)) holder.total = h.total;
      return holder;
    }
  } catch {
    // malformed sidecar: treated as absent
  }
  return null;
}

// Rate-scaled remaining time in whole minutes; null before the first spec
// finishes or once all specs are done.
export function etaMinutes(elapsedMs: number, done: number, total: number): number | null {
  if (done <= 0 || total <= done) return null;
  return Math.max(1, Math.round((elapsedMs / done) * (total - done) / 60_000));
}

export function formatStatus(
  holder: LockHolder | null,
  now: number = Date.now(),
  progress: LockProgress | null = null,
): string {
  if (!holder) return "phone lock: free";
  const elapsedMs = Math.max(0, now - holder.startTime);
  const m = Math.floor(elapsedMs / 60_000);
  const s = Math.floor((elapsedMs % 60_000) / 1_000);
  let line = `phone lock: held by ${holder.worktree} (pid ${holder.pid}) for ${m}m${s}s`;
  if (progress && progress.total > 0) {
    const bits: string[] = [];
    if (progress.project) bits.push(progress.project);
    bits.push(`${progress.done}/${progress.total} specs`);
    const eta = etaMinutes(elapsedMs, progress.done, progress.total);
    if (eta !== null) bits.push(`~${eta} min left`);
    line += `: ${bits.join(", ")}`;
  }
  return line;
}

export function formatQueue(entries: QueueEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map(
    (e, i) => `${i + 1}. ${e.worktree} since ${new Date(e.waitingSince).toISOString()}`,
  );
  return `queued:\n${lines.join("\n")}`;
}

export function readSidecar(): LockHolder | null {
  if (!existsSync(SIDECAR_PATH)) return null;
  const holder = parseHolder(readFileSync(SIDECAR_PATH, "utf8"));
  // A dead holder pid means a stale sidecar from a killed run: the flock itself
  // was already released when that parent died (see module comment).
  return holder && isPidAlive(holder.pid) ? holder : null;
}

// Non-blocking flock(2) probe: true iff another process holds the lock. Catches
// shell `flock /tmp/geode-phone.lock` users who never write a sidecar.
export function lockHeld(): boolean {
  const res = spawnSync("flock", ["-n", LOCK_PATH, "-c", "true"], { timeout: 5_000 });
  return res.status !== 0;
}

function writeSidecar(holder: LockHolder): void {
  writeFileSync(SIDECAR_PATH, serializeHolder(holder));
}

function clearSidecar(): void {
  try {
    rmSync(SIDECAR_PATH, { force: true });
  } catch {
    // best-effort; a stale sidecar reads as "free" once the holder pid is gone
  }
}

// The holder's run progress (from the Playwright reporter): written only when
// this process owns the sidecar (the reporter runs in the same process as the
// globalSetup that wrote it), so an unrelated run can never clobber the
// current holder's progress.
export function updateProgress(progress: LockProgress): void {
  const holder = readSidecar();
  if (!holder || holder.pid !== process.pid) return;
  writeSidecar({ ...holder, ...progress });
}

export type WaitInfo = { position?: number; progress?: LockProgress | null };

export function waitLine(
  holder: LockHolder | null,
  now: number = Date.now(),
  info: WaitInfo = {},
): string {
  const base = `queued for the phone: position ${info.position ?? 1}`;
  if (!holder) return `${base}, phone lock free`;
  let holderPart = `holder ${holder.worktree}`;
  if (info.progress && info.progress.total > 0) {
    const bits: string[] = [];
    if (info.progress.project) bits.push(info.progress.project);
    bits.push(`${info.progress.done}/${info.progress.total} specs`);
    const eta = etaMinutes(now - holder.startTime, info.progress.done, info.progress.total);
    if (eta !== null) bits.push(`~${eta} min left`);
    holderPart += ` (${bits.join(", ")})`;
  }
  return `${base}, ${holderPart}`;
}

// #500: a run started inside `flock /tmp/geode-phone.lock …` must not wait on
// its own ancestor. The walk is pure with an injectable reader so it is unit-tested
// against a fake /proc tree.
export type ProcReader = {
  ppidOf: (pid: number) => number | null;
  fdTargets: (pid: number) => string[] | null;
};

export function findLockAncestor(
  lockPath: string,
  startPid: number,
  proc: ProcReader,
): number | null {
  let pid = startPid;
  while (pid >= 1) {
    const fds = proc.fdTargets(pid);
    if (fds && fds.includes(lockPath)) return pid;
    const parent = proc.ppidOf(pid);
    if (parent === null || parent < 1 || parent >= pid) return null;
    pid = parent;
  }
  return null;
}

function realProcReader(): ProcReader {
  return {
    ppidOf(pid) {
      try {
        // comm (field 2) may contain spaces/parens: parse after the last ')'.
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } catch {
        return null;
      }
    },
    fdTargets(pid) {
      try {
        return readdirSync(`/proc/${pid}/fd`)
          .map((fd) => {
            try {
              return readlinkSync(`/proc/${pid}/fd/${fd}`);
            } catch {
              return null; // fd closed between readdir and readlink
            }
          })
          .filter((t): t is string => t !== null);
      } catch {
        return null;
      }
    },
  };
}

export type PhoneLock = {
  holder: LockHolder;
  release: () => Promise<void>;
};

export function acquirePhoneLock(opts?: {
  onWait?: (holder: LockHolder | null, info: WaitInfo) => void;
}): Promise<PhoneLock> {
  const holder: LockHolder = {
    worktree: basename(process.cwd()),
    pid: process.pid,
    startTime: Date.now(),
  };
  // #500: already running under the lock (ancestor `flock` or the explicit
  // GEODE_PHONE_LOCK_HELD=1 escape hatch): skip the acquire, which would
  // deadlock on our own ancestor. release is a no-op: the ancestor owns it.
  if (process.env.GEODE_PHONE_LOCK_HELD === "1") {
    console.log("phone lock: GEODE_PHONE_LOCK_HELD=1: assuming the lock is held");
    return Promise.resolve({ holder, release: async () => {} });
  }
  const ancestor = findLockAncestor(LOCK_PATH, process.ppid, realProcReader());
  if (ancestor !== null) {
    console.log(`phone lock already held by parent shell (pid ${ancestor})`);
    return Promise.resolve({ holder, release: async () => {} });
  }
  // #508: FIFO: register our place; the flock child is only spawned once this
  // ticket is at the head, so runs are served in arrival order.
  registerTicket(holder.worktree, holder.pid, holder.startTime);
  return new Promise((resolve, reject) => {
    let flockChild: ReturnType<typeof spawn> | null = null;
    let acquired = false;
    let stdoutBuf = "";
    let lastLogged: string | null = null;
    let lastLoggedAt = Date.now();

    const release = async (): Promise<void> => {
      if (flockChild) {
        try {
          flockChild.stdin?.end(); // EOF → `read` returns → flock exits → lock released
        } catch {
          // stdin already closed
        }
        await new Promise<void>((res) =>
          flockChild.exitCode !== null ? res() : flockChild.once("exit", () => res())
        );
      }
      removeTicket(holder.pid);
      clearSidecar();
    };

    const poll = setInterval(() => {
      if (acquired) return;
      const tickets = readTickets();
      let position = queuePosition(tickets, holder.pid, isPidAlive);
      if (position === null) {
        // Ticket lost (queue dir wiped): re-register so the waiter isn't stuck
        // out of the queue forever.
        registerTicket(holder.worktree, holder.pid, holder.startTime);
        position = 1;
      }
      if (position === 1 && flockChild === null) {
        flockChild = spawn(
          "flock",
          ["-F", LOCK_PATH, "-c", "echo ACQUIRED; read"],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        flockChild.stdout?.on("data", (d: Buffer) => {
          stdoutBuf += d.toString();
          if (acquired || !stdoutBuf.includes("ACQUIRED")) return;
          acquired = true;
          clearInterval(poll);
          removeTicket(holder.pid);
          // Elapsed/ETA measure actual run time, not queue wait: the sidecar
          // is written now, not when this waiter first registered its ticket.
          holder.startTime = Date.now();
          writeSidecar(holder);
          resolve({ holder, release });
        });
        flockChild.on("error", (err) => {
          if (!acquired) {
            clearInterval(poll);
            removeTicket(holder.pid);
            reject(err);
          }
        });
        flockChild.on("exit", (code, signal) => {
          clearInterval(poll);
          if (!acquired) {
            removeTicket(holder.pid);
            reject(new Error(`flock exited (${code ?? signal}) before acquiring the phone lock`));
          }
        });
      }
      const current = readSidecar();
      const progress: LockProgress | null = current && current.total != null
        ? { project: current.project ?? "", done: current.done ?? 0, total: current.total }
        : null;
      const key = [
        String(current?.pid ?? ""),
        position,
        progress ? `${progress.done}/${progress.total}` : "",
      ]
        .join("|");
      // Log on change and at least once a minute while waiting (#500, #508).
      if (key === lastLogged && Date.now() - lastLoggedAt < 60_000) return;
      lastLogged = key;
      lastLoggedAt = Date.now();
      const log = opts?.onWait ??
        ((h: LockHolder | null, info: WaitInfo) => console.log(waitLine(h, Date.now(), info)));
      log(current, { position, progress });
    }, 1_000);
  });
}
