import {
  checkAdminRate,
  MAX_TRACKED_IPS,
  recordAdminFailure,
  recordAdminSuccess,
  resetRateLimits,
  trackedIps,
} from "../../../server/rate-limit.ts";
import { attachRemoteAddr, clientIp } from "../../../server/http-helpers.ts";
import { assert, assertEquals } from "@std/assert";

const WINDOW_MS = 15 * 60_000;

// ── checkAdminRate ──────────────────────────────────────────────────

Deno.test("rate-limit - under threshold (4 failures) is allowed", () => {
  resetRateLimits();
  for (let i = 0; i < 4; i++) recordAdminFailure("1.1.1.1");
  const result = checkAdminRate("1.1.1.1");
  assert(result.allowed);
});

Deno.test("rate-limit - at threshold (5 failures) is blocked with retryAfterSec > 0", () => {
  resetRateLimits();
  for (let i = 0; i < 5; i++) recordAdminFailure("1.1.1.1");
  const result = checkAdminRate("1.1.1.1");
  assertEquals(result.allowed, false);
  assert(result.retryAfterSec > 0);
});

Deno.test("rate-limit - recordAdminSuccess clears the bucket → allowed again", () => {
  resetRateLimits();
  for (let i = 0; i < 5; i++) recordAdminFailure("1.1.1.1");
  assertEquals(checkAdminRate("1.1.1.1").allowed, false);
  recordAdminSuccess("1.1.1.1");
  assert(checkAdminRate("1.1.1.1").allowed);
});

Deno.test("rate-limit - window expiry: 5 failures at now=0, allowed past window", () => {
  resetRateLimits();
  for (let i = 0; i < 5; i++) recordAdminFailure("1.1.1.1", 0);
  assertEquals(checkAdminRate("1.1.1.1", 0).allowed, false);
  assert(checkAdminRate("1.1.1.1", WINDOW_MS + 1).allowed);
});

Deno.test("rate-limit - per-IP isolation: failures on ip A don't block ip B", () => {
  resetRateLimits();
  for (let i = 0; i < 5; i++) recordAdminFailure("1.1.1.1");
  assertEquals(checkAdminRate("1.1.1.1").allowed, false);
  assert(checkAdminRate("2.2.2.2").allowed);
});

// ── bounded map (#680 N-7) ───────────────────────────────────────────

Deno.test("rate-limit - IP rotation cannot grow the map past its cap", () => {
  resetRateLimits();
  for (let i = 0; i < MAX_TRACKED_IPS + 500; i++) recordAdminFailure(`2001:db8::${i}`, 0);
  assert(trackedIps() <= MAX_TRACKED_IPS, `tracked ${trackedIps()} buckets`);
});

Deno.test("rate-limit - reaching the cap drops every expired bucket first", () => {
  resetRateLimits();
  for (let i = 0; i < MAX_TRACKED_IPS; i++) recordAdminFailure(`198.51.100.${i}`, 0);
  recordAdminFailure("203.0.113.9", WINDOW_MS + 1);
  assertEquals(trackedIps(), 1);
  assert(checkAdminRate("203.0.113.9", WINDOW_MS + 1).allowed);
});

// ── clientIp ─────────────────────────────────────────────────────────

function addrWith(hostname: string): Deno.Addr {
  return { transport: "tcp", hostname, port: 1234 } as Deno.Addr;
}

Deno.test("rate-limit - clientIp: non-loopback socket ignores X-Forwarded-For", () => {
  const req = new Request("http://geode/vaults", {
    headers: { "x-forwarded-for": "9.9.9.9" },
  });
  attachRemoteAddr(req, addrWith("203.0.113.7"));
  assertEquals(clientIp(req), "203.0.113.7");
});

Deno.test("rate-limit - clientIp: loopback socket (Caddy) trusts last XFF entry", () => {
  const req = new Request("http://geode/vaults", {
    headers: { "x-forwarded-for": "1.2.3.4,  5.6.7.8  " },
  });
  attachRemoteAddr(req, addrWith("127.0.0.1"));
  assertEquals(clientIp(req), "5.6.7.8");
});

Deno.test("rate-limit - clientIp: loopback socket without XFF uses socket peer", () => {
  const req = new Request("http://geode/vaults");
  attachRemoteAddr(req, addrWith("::1"));
  assertEquals(clientIp(req), "::1");
});

Deno.test("rate-limit - clientIp: no socket info falls back to XFF, else unknown", () => {
  const req = new Request("http://geode/vaults", {
    headers: { "x-forwarded-for": "5.6.7.8" },
  });
  assertEquals(clientIp(req), "5.6.7.8");
  assertEquals(clientIp(new Request("http://geode/vaults")), "unknown");
});
