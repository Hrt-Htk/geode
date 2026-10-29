import {
  describePauseBanner,
  pauseAgeColor,
  pauseAgeLabel,
  pauseTooltip,
} from "../../../plugin/ui/pause.ts";
import { assertEquals } from "@std/assert";

const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

Deno.test("pause - grey under 10 min", () => {
  assertEquals(pauseAgeColor(NOW, NOW), "grey");
  assertEquals(pauseAgeColor(NOW - 9 * MIN, NOW), "grey");
});

Deno.test("pause - orange from 10 to 30 min", () => {
  assertEquals(pauseAgeColor(NOW - 10 * MIN, NOW), "orange");
  assertEquals(pauseAgeColor(NOW - 29 * MIN, NOW), "orange");
});

Deno.test("pause - red at and after 30 min", () => {
  assertEquals(pauseAgeColor(NOW - 30 * MIN, NOW), "red");
  assertEquals(pauseAgeColor(NOW - 2 * HOUR, NOW), "red");
});

Deno.test("pause - label just now, minutes, hours", () => {
  assertEquals(pauseAgeLabel(NOW, NOW), "paused just now");
  assertEquals(pauseAgeLabel(NOW - 59_000, NOW), "paused just now");
  assertEquals(pauseAgeLabel(NOW - MIN, NOW), "paused 1 min ago");
  assertEquals(pauseAgeLabel(NOW - 15 * MIN, NOW), "paused 15 min ago");
  assertEquals(pauseAgeLabel(NOW - HOUR, NOW), "paused 1 h ago");
  assertEquals(pauseAgeLabel(NOW - 25 * HOUR, NOW), "paused 25 h ago");
});

Deno.test("pause - tooltip names the age, no dashes", () => {
  assertEquals(pauseTooltip(NOW - 2 * MIN, NOW), "Sync paused. Paused 2 min ago.");
  assertEquals(pauseTooltip(NOW - 2 * HOUR, NOW), "Sync paused. Paused 2 h ago.");
  assertEquals(pauseTooltip(NOW - 59_000, NOW), "Sync paused. Paused just now.");
  assertEquals(pauseTooltip(NOW - 2 * MIN, NOW).includes("-"), false);
});

Deno.test("pause - banner null when not paused", () => {
  assertEquals(describePauseBanner(0, NOW), null);
});

Deno.test("pause - banner desc and colour track the age", () => {
  assertEquals(describePauseBanner(NOW - 12 * MIN, NOW), {
    desc: "paused 12 min ago",
    color: "orange",
  });
  assertEquals(describePauseBanner(NOW - 40 * MIN, NOW), {
    desc: "paused 40 min ago",
    color: "red",
  });
});
