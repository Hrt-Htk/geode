const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
// One bucket per IP is a leak the moment a client can rotate addresses (an IPv6 /64 holds
// 2^64 of them), so the map is bounded: at the cap every expired bucket is dropped, then
// the oldest (#680 N-7). This bounds memory only; it is not a security control. Eviction
// can drop an attacker's own bucket and with it its failure count, which buys nothing: a
// caller holding 10 000 addresses already has 10 000 free guesses.
export const MAX_TRACKED_IPS = 10_000;
const failures = new Map<string, number[]>(); // ip -> failure timestamps (ms)

function prune(ip: string, now: number): void {
  const list = failures.get(ip);
  if (!list) return;
  const cutoff = now - WINDOW_MS;
  const fresh = list.filter((ts) => ts > cutoff);
  if (fresh.length === 0) {
    failures.delete(ip);
  } else if (fresh.length !== list.length) {
    failures.set(ip, fresh);
  }
}

export function checkAdminRate(ip: string, now = Date.now()): {
  allowed: boolean;
  retryAfterSec: number;
} {
  prune(ip, now);
  const count = failures.get(ip)?.length ?? 0;
  if (count < MAX_FAILURES) {
    return { allowed: true, retryAfterSec: 0 };
  }
  const oldest = failures.get(ip)![0];
  const retryAfterSec = Math.ceil((oldest + WINDOW_MS - now) / 1000);
  return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
}

export function recordAdminFailure(ip: string, now = Date.now()): void {
  if (failures.size >= MAX_TRACKED_IPS) bound(now);
  const list = failures.get(ip) ?? [];
  list.push(now);
  failures.set(ip, list);
}

function bound(now: number): void {
  for (const ip of [...failures.keys()]) prune(ip, now);
  while (failures.size >= MAX_TRACKED_IPS) {
    const oldest = failures.keys().next().value;
    if (oldest === undefined) break;
    failures.delete(oldest);
  }
}

export function trackedIps(): number {
  return failures.size;
}

export function recordAdminSuccess(ip: string): void {
  failures.delete(ip);
}

export function resetRateLimits(): void {
  failures.clear();
}
