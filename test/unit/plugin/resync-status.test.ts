import { assertEquals } from "@std/assert";
import {
  RESYNC_BUSY_BUTTON,
  RESYNC_BUTTON,
  RESYNC_RETRY_BUTTON,
  resyncButtonText,
  resyncDoneNotice,
  resyncNoticeText,
  resyncRowDot,
  resyncRowText,
  resyncStopReason,
  resyncTooltip,
} from "../../../plugin/ui/resync-status.ts";

// #54: the approved copy, on every surface a resync shows (notice, status bar, settings
// row, button). One module so the four cannot drift apart.

const running = { phase: "running", current: 312, total: 822 } as const;
const uncounted = { phase: "running", current: 0, total: 0 } as const;
const failed = { phase: "failed", reason: "Server unreachable." } as const;

Deno.test("resync-status - running carries the progress into all three surfaces", () => {
  assertEquals(resyncNoticeText(running), "Geode: resyncing 312 of 822 files");
  assertEquals(resyncTooltip(running), "Geode: resyncing 312 of 822");
  assertEquals(resyncRowText(running), "Resyncing: 312 of 822 files.");
  assertEquals(resyncRowDot(running), "blue");
  assertEquals(resyncButtonText(running), RESYNC_BUSY_BUTTON);
});

Deno.test("resync-status - before the file count arrives the running copy has no numbers", () => {
  assertEquals(resyncNoticeText(uncounted), "Geode: resyncing");
  assertEquals(resyncTooltip(uncounted), "Geode: resyncing");
  assertEquals(resyncRowText(uncounted), "Resyncing.");
});

Deno.test("resync-status - stopped names the reason and offers a retry", () => {
  assertEquals(resyncNoticeText(failed), "Geode: resync stopped. Server unreachable.");
  assertEquals(resyncTooltip(failed), "Geode: resync stopped. Server unreachable.");
  assertEquals(resyncRowText(failed), "Resync stopped. Server unreachable.");
  assertEquals(resyncRowDot(failed), "orange");
  assertEquals(resyncButtonText(failed), RESYNC_RETRY_BUTTON);
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
  assertEquals(resyncButtonText(null), RESYNC_BUTTON);
});
