import { assertEquals } from "@std/assert";
import {
  deviceDescText,
  devicesSummaryText,
  deviceStatusText,
} from "../../../plugin/ui/device-status.ts";

// #433: per-device row text: "Up to date" vs "N changes behind" (singular
// "1 change behind"), "Never synced", last-seen formatting, and the settings
// summary "N devices · M behind" (never-synced isn't behind).

Deno.test("deviceStatusText - up to date when applied_seq reaches the head", () => {
  assertEquals(deviceStatusText(10, 10), "Up to date");
  assertEquals(deviceStatusText(12, 10), "Up to date", "applied past head stays up to date");
});

Deno.test("deviceStatusText - plural and singular changes behind", () => {
  assertEquals(deviceStatusText(10, 12), "2 changes behind");
  assertEquals(deviceStatusText(11, 12), "1 change behind");
  assertEquals(deviceStatusText(2, 5), "3 changes behind");
});

Deno.test("deviceStatusText - never synced only when applied_seq is null", () => {
  assertEquals(deviceStatusText(null, 0), "Never synced");
  assertEquals(deviceStatusText(null, 5), "Never synced");
});

Deno.test("deviceStatusText - 0 is a real position: up to date on an empty vault", () => {
  assertEquals(deviceStatusText(0, 0), "Up to date");
  assertEquals(deviceStatusText(0, 5), "5 changes behind");
});

Deno.test("deviceDescText - last seen plus status, never synced has no last seen", () => {
  const rel = (_s: number) => "3 hours ago";
  assertEquals(
    deviceDescText({ lastSeenAt: 100, appliedSeq: 10, headSeq: 10 }, rel),
    "Last seen 3 hours ago · Up to date",
  );
  assertEquals(
    deviceDescText({ lastSeenAt: 100, appliedSeq: 10, headSeq: 12 }, rel),
    "Last seen 3 hours ago · 2 changes behind",
  );
  assertEquals(
    deviceDescText({ lastSeenAt: 100, appliedSeq: null, headSeq: 12 }, rel),
    "Never synced",
  );
  assertEquals(
    deviceDescText({ lastSeenAt: 100, appliedSeq: 0, headSeq: 0 }, rel),
    "Last seen 3 hours ago · Up to date",
  );
});

Deno.test("devicesSummaryText - counts devices and behind (never-synced is not behind)", () => {
  const mk = (appliedSeq: number | null, headSeq: number) => ({ appliedSeq, headSeq });
  assertEquals(devicesSummaryText([mk(10, 10), mk(10, 12), mk(null, 12)]), "3 devices · 1 behind");
  assertEquals(devicesSummaryText([mk(null, 12)]), "1 device · 0 behind");
  assertEquals(devicesSummaryText([mk(0, 0), mk(10, 12)]), "2 devices · 1 behind");
  assertEquals(devicesSummaryText([]), "0 devices · 0 behind");
});
