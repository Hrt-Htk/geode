// FIFO ticket queue for the shared test phone (#508). Each waiter registers a
// ticket (a file under /tmp/geode-phone.queue/ named <ts>-<pid>) and only
// attempts the flock once it is at the head of the queue, so runs are served in
// arrival order instead of flock's unspecified wake order. Dead-pid tickets are
// pruned. Shell `flock` users without a ticket still interoperate: they just
// aren't ordered. Pure parts (parse/sort/prune/position) are unit-tested in
// test/unit/e2e/phone-queue.test.ts.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const QUEUE_DIR = "/tmp/geode-phone.queue";

export type Ticket = { worktree: string; pid: number; waitingSince: number };
export type QueueEntry = { worktree: string; waitingSince: number };

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function ticketFileName(waitingSince: number, pid: number): string {
  return `${waitingSince}-${pid}`;
}

export function parseTicketName(name: string): { waitingSince: number; pid: number } | null {
  const m = /^(\d+)-(\d+)$/.exec(name);
  if (!m) return null;
  const waitingSince = Number(m[1]);
  const pid = Number(m[2]);
  if (!Number.isSafeInteger(waitingSince) || !Number.isSafeInteger(pid)) return null;
  return { waitingSince, pid };
}

export function orderTickets(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) => a.waitingSince - b.waitingSince || a.pid - b.pid);
}

export function pruneStaleTickets(tickets: Ticket[], isAlive: (pid: number) => boolean): Ticket[] {
  return tickets.filter((t) => isAlive(t.pid));
}

export function queuePosition(
  tickets: Ticket[],
  pid: number,
  isAlive: (pid: number) => boolean = isPidAlive,
): number | null {
  const index = orderTickets(pruneStaleTickets(tickets, isAlive)).findIndex((t) => t.pid === pid);
  return index < 0 ? null : index + 1;
}

export function registerTicket(worktree: string, pid: number, waitingSince: number): void {
  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(
    join(QUEUE_DIR, ticketFileName(waitingSince, pid)),
    JSON.stringify({ worktree, pid, waitingSince }),
  );
}

export function removeTicket(pid: number): void {
  if (!existsSync(QUEUE_DIR)) return;
  for (const name of readdirSync(QUEUE_DIR)) {
    const meta = parseTicketName(name);
    if (meta && meta.pid === pid) rmSync(join(QUEUE_DIR, name), { force: true });
  }
}

export function readTickets(): Ticket[] {
  if (!existsSync(QUEUE_DIR)) return [];
  const tickets: Ticket[] = [];
  for (const name of readdirSync(QUEUE_DIR)) {
    const meta = parseTicketName(name);
    if (!meta) continue;
    let worktree = String(meta.pid);
    try {
      const raw = JSON.parse(readFileSync(join(QUEUE_DIR, name), "utf8")) as { worktree?: unknown };
      if (typeof raw.worktree === "string") worktree = raw.worktree;
    } catch {
      // half-written ticket: keep it ordered, fall back to pid as identity
    }
    tickets.push({ worktree, pid: meta.pid, waitingSince: meta.waitingSince });
  }
  return tickets;
}

export function readQueue(): QueueEntry[] {
  return orderTickets(pruneStaleTickets(readTickets(), isPidAlive)).map(
    ({ worktree, waitingSince }) => ({ worktree, waitingSince }),
  );
}
