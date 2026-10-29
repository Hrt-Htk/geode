import { assertEquals } from "@std/assert";
import { rejoinStamp } from "../../../plugin/sync/rejoin.ts";

// #701: the rejoin backup's sub-folder name: plain, sortable, and free of dashes like
// every other user-visible string (test/unit/plugin/copy-no-dashes.test.ts pins the rule).

const DASHES = /[\u2010-\u2015\u2212-]/;

Deno.test("rejoin-stamp - a plain sortable stamp with no dashes", () => {
  const stamp = rejoinStamp(new Date(2026, 9, 29, 14, 6, 42).getTime());
  assertEquals(stamp, "2026.10.29 14.06.42");
  assertEquals(DASHES.test(stamp), false, `stamp "${stamp}" carries a dash`);
});

Deno.test("rejoin-stamp - single digit parts are padded", () => {
  assertEquals(rejoinStamp(new Date(2026, 0, 2, 3, 4, 5).getTime()), "2026.01.02 03.04.05");
});
