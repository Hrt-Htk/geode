import { assert, assertEquals } from "@std/assert";
import {
  type HeldFile,
  holdOnTrip,
  MASS_DELETE_MIN_FILES,
  MASS_DELETE_MIN_PERCENT,
  type MassDeleteHold,
  planMassDeleteDecision,
  shouldHoldMassDelete,
  thresholdFromInput,
} from "../../../plugin/sync/mass-delete-hold.ts";

Deno.test("mass-delete hold - the defaults are 20 files and 25 percent", () => {
  assertEquals(MASS_DELETE_MIN_FILES, 20);
  assertEquals(MASS_DELETE_MIN_PERCENT, 25);
});

Deno.test("mass-delete hold - the count floor boundary: 19 holds nothing, 20 holds", () => {
  // 19 of 20 is 95%: over the percentage, under the floor.
  assert(!shouldHoldMassDelete(19, 20, MASS_DELETE_MIN_FILES, MASS_DELETE_MIN_PERCENT));
  assert(shouldHoldMassDelete(20, 20, MASS_DELETE_MIN_FILES, MASS_DELETE_MIN_PERCENT));
});

Deno.test("mass-delete hold - the percentage boundary is strict: exactly 25% is not more", () => {
  // 20 of 80 = 25.0%: the floor is met, the percentage is not exceeded.
  assert(!shouldHoldMassDelete(20, 80, MASS_DELETE_MIN_FILES, MASS_DELETE_MIN_PERCENT));
  assert(shouldHoldMassDelete(21, 80, MASS_DELETE_MIN_FILES, MASS_DELETE_MIN_PERCENT));
  // 25 of 100 = 25.0%.
  assert(!shouldHoldMassDelete(25, 100, MASS_DELETE_MIN_FILES, MASS_DELETE_MIN_PERCENT));
});

Deno.test("mass-delete hold - custom values use the same two conditions", () => {
  assert(shouldHoldMassDelete(4, 10, 4, 30), "4 files, 40%");
  assert(!shouldHoldMassDelete(3, 10, 4, 30), "3 files is under a floor of 4");
  assert(!shouldHoldMassDelete(4, 20, 4, 30), "4 files is 20%, under 30%");
  assert(shouldHoldMassDelete(5, 10, 1, 1), "a 1%/1-file guard holds early");
  assert(!shouldHoldMassDelete(0, 10, 1, 1), "no deletes never holds");
});

Deno.test("mass-delete hold - the threshold fields keep the last valid value", () => {
  const files = (raw: string, last = 20) =>
    thresholdFromInput(raw, last, 1, Number.MAX_SAFE_INTEGER);
  assertEquals(files("25"), 25);
  assertEquals(files(" 7 "), 7);
  assertEquals(files("0"), 20, "zero files is not a guard");
  assertEquals(files("-3"), 20);
  assertEquals(files("2.5"), 20, "whole numbers only");
  assertEquals(files("abc"), 20);
  assertEquals(files(""), 20);

  const percent = (raw: string, last = 25) => thresholdFromInput(raw, last, 1, 100);
  assertEquals(percent("30"), 30);
  assertEquals(percent("100"), 100, "100 percent is a valid guard");
  assertEquals(percent("0"), 25);
  assertEquals(percent("101"), 25);
  assertEquals(percent("25.5"), 25);
  assertEquals(percent("x"), 25);
});

Deno.test("mass-delete hold - a decision deletes the selected, restores the rest, skips what came back", async () => {
  const held: HeldFile[] = [
    { path: "gone/a.md", mtime: 1 },
    { path: "gone/b.md", mtime: 2 },
    { path: "gone/c.md", mtime: 3 },
    { path: "back.md", mtime: 4 },
  ];
  const onDisk = new Set(["back.md"]);

  const plan = await planMassDeleteDecision(
    held,
    ["gone/a.md", "back.md"],
    (path) => Promise.resolve(onDisk.has(path)),
  );
  assertEquals(plan.remove, ["gone/a.md"], "only the selected, still missing path is deleted");
  assertEquals(plan.restore, ["gone/b.md", "gone/c.md"], "the unselected held paths are restored");
});

Deno.test("mass-delete hold - a decision with nothing selected restores every missing held path", async () => {
  const held: HeldFile[] = [{ path: "a.md", mtime: 1 }, { path: "b.md", mtime: 2 }];
  const plan = await planMassDeleteDecision(held, [], () => Promise.resolve(false));
  assertEquals(plan.remove, []);
  assertEquals(plan.restore, ["a.md", "b.md"]);
});

Deno.test("mass-delete hold - the first trip wins, a second pass never rewrites it", () => {
  const settings: { massDeleteHold: MassDeleteHold | null } = { massDeleteHold: null };
  const first = holdOnTrip(settings, [{ path: "a.md", mtime: 1 }], 30, 1_000)!;
  assertEquals(first.detectedAt, 1_000, "the trip stamps when it happened");

  const second = holdOnTrip(settings, [{ path: "b.md", mtime: 2 }], 31, 2_000);

  assertEquals(second, null, "an overlapping pass is a no-op");
  assertEquals(settings.massDeleteHold, first, "the held files and their timestamp survive");
});
