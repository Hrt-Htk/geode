import { assertEquals } from "@std/assert";
import {
  RESYNC_BUSY,
  RESYNC_RENDER_MS,
  RESYNC_RETRY,
  RESYNC_ROW,
  resyncButtonText,
  resyncCopy,
  resyncDoneNotice,
  resyncIcon,
  resyncRenderDue,
  resyncRowDot,
  resyncStopReason,
  resyncStopsSync,
} from "../../../plugin/ui/resync-status.ts";

// #54: the approved copy, on every surface a resync shows (notice, status bar, settings
// row, button). One function so the four cannot drift apart.

const running = { phase: "running", progress: { current: 312, total: 822 } } as const;
const uncounted = { phase: "running", progress: { current: 0, total: 0 } } as const;
const stopped = { phase: "failed", reason: "Server unreachable.", syncStopped: false } as const;
const leftStopped = { phase: "failed", reason: "Server unreachable.", syncStopped: true } as const;

Deno.test("resync-status - running carries the progress into all three surfaces", () => {
  assertEquals(resyncCopy(running), {
    notice: "Geode: resyncing 312 of 822 files",
    tooltip: "Geode: resyncing 312 of 822",
    row: "Resyncing: 312 of 822 files.",
  });
  assertEquals(resyncRowDot(running), "blue");
  assertEquals(resyncButtonText(running), RESYNC_BUSY);
  assertEquals(resyncIcon(running), {
    icon: "refresh-cw",
    color: "geode-statusbar-syncing",
    spin: true,
  });
});

Deno.test("resync-status - before the file count arrives the running copy has no numbers", () => {
  assertEquals(resyncCopy(uncounted), {
    notice: "Geode: resyncing",
    tooltip: "Geode: resyncing",
    row: "Resyncing.",
  });
});

Deno.test("resync-status - stopped names the reason and offers a retry", () => {
  assertEquals(resyncCopy(stopped), {
    notice: "Geode: resync stopped. Server unreachable.",
    tooltip: "Geode: resync stopped. Server unreachable.",
    row: "Resync stopped. Server unreachable.",
  });
  assertEquals(resyncRowDot(stopped), "orange");
  assertEquals(resyncButtonText(stopped), RESYNC_RETRY);
  assertEquals(resyncIcon(stopped), { icon: "triangle-alert", color: "geode-statusbar-error" });
});

Deno.test("resync-status - only a rebuild that left sync stopped owns the status", () => {
  // #54 review: a restart happened, so the restarted session's own state (offline,
  // paused, a refusal, a hold) is the truth; the stop shows only when it is the whole story.
  assertEquals(resyncStopsSync(null), false);
  assertEquals(resyncStopsSync(running), false);
  assertEquals(resyncStopsSync(stopped), false);
  assertEquals(resyncStopsSync(leftStopped), true);
});

Deno.test("resync-status - a connection failure stops in words, not in a network code", () => {
  assertEquals(
    resyncStopReason(new TypeError("net::ERR_CONNECTION_REFUSED")),
    "Server unreachable.",
  );
  assertEquals(resyncStopReason(new TypeError("Failed to fetch")), "Server unreachable.");
  // Everything else keeps its own message: the reason is the real one, not a guess.
  assertEquals(resyncStopReason(new Error("heads GET: 403")), "heads GET: 403");
});

Deno.test("resync-status - done counts what it updated, and nothing to update says so", () => {
  assertEquals(resyncDoneNotice(4), "Geode: resync done. 4 files updated.");
  assertEquals(resyncDoneNotice(1), "Geode: resync done. 1 file updated.");
  assertEquals(resyncDoneNotice(0), "Geode: resync done. Nothing to update.");
  assertEquals(resyncButtonText(null), RESYNC_ROW);
});

Deno.test("resync-status - progress renders at most about four times a second", () => {
  const start = 1_000;
  const p = (current: number, total = 822) => ({ current, total });
  assertEquals(resyncRenderDue(p(1), 0, start), true, "the first progress renders");
  assertEquals(resyncRenderDue(p(2), start, start + RESYNC_RENDER_MS - 1), false);
  assertEquals(resyncRenderDue(p(3), start, start + RESYNC_RENDER_MS), true);
  // The final count always renders, whatever the clock says.
  assertEquals(resyncRenderDue(p(822), start, start + 1), true);
});
