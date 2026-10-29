import { buildStatusMenu, type StatusMenuInput } from "../../../plugin/ui/status-menu.ts";
import { assertEquals } from "@std/assert";

function input(overrides: Partial<StatusMenuInput> = {}): StatusMenuInput {
  return {
    unlocked: true,
    configured: true,
    paused: false,
    conflictCount: 0,
    heldCount: 0,
    ...overrides,
  };
}

Deno.test("status menu - unlocked not paused: Pause, Sync activity, Conflicts, deleted, devices, settings", () => {
  const items = buildStatusMenu(input());
  assertEquals(items.map((i) => i.label), [
    "Pause",
    "Sync activity",
    "Conflicts",
    "Deleted files",
    "Devices",
    "Geode settings",
  ]);
  assertEquals(items[0].action, "pause");
  assertEquals(items[0].icon, "pause");
  assertEquals(items[1].icon, "activity");
  assertEquals(items[2].icon, "git-merge");
  assertEquals(items[3].icon, "trash-2");
  assertEquals(items[4].id, "devices");
  assertEquals(items[5].icon, "settings");
});

Deno.test("status menu - the Conflicts entry is the badge: count while open, plain at zero", () => {
  assertEquals(buildStatusMenu(input()).find((i) => i.id === "conflicts")!.label, "Conflicts");
  assertEquals(
    buildStatusMenu(input({ conflictCount: 2 })).find((i) => i.id === "conflicts")!.label,
    "Conflicts (2)",
  );
  assertEquals(
    buildStatusMenu(input({ conflictCount: 1 })).find((i) => i.id === "conflicts")!.label,
    "Conflicts (1)",
  );
});

Deno.test("status menu - paused: first item is Resume with play icon", () => {
  const items = buildStatusMenu(input({ paused: true }));
  assertEquals(items[0].label, "Resume");
  assertEquals(items[0].action, "resume");
  assertEquals(items[0].icon, "play");
});

Deno.test("status menu - settings item carries a separator before it", () => {
  const items = buildStatusMenu(input());
  assertEquals(items[5].id, "settings");
  assertEquals(items[5].separatorBefore, true);
});

Deno.test("status menu - locked hides the pause item, keeps the rest in order", () => {
  const items = buildStatusMenu(input({ unlocked: false }));
  assertEquals(items.map((i) => i.label), [
    "Sync activity",
    "Conflicts",
    "Deleted files",
    "Devices",
    "Geode settings",
  ]);
});

Deno.test("status menu - not set up hides the pause and devices items", () => {
  const items = buildStatusMenu(input({ configured: false }));
  assertEquals(items.map((i) => i.label), ["Sync activity", "Conflicts", "Geode settings"]);
});

Deno.test("status menu - labels carry no hyphens or dashes", () => {
  for (const item of buildStatusMenu(input({ conflictCount: 3 }))) {
    assertEquals(item.label.includes("-"), false);
  }
});

Deno.test("status menu - a held mass delete puts Review missing files first", () => {
  const items = buildStatusMenu(input({ heldCount: 1850 }));
  assertEquals(items[0].id, "missing");
  assertEquals(items[0].label, "Review missing files");
  assertEquals(items[0].icon, "file-search");
  assertEquals(items[1].label, "Pause");
  assertEquals(
    buildStatusMenu(input({ heldCount: 0 })).some((i) => i.id === "missing"),
    false,
    "no hold, no entry",
  );
  assertEquals(
    buildStatusMenu(input({ heldCount: 1850, unlocked: false }))[0].id,
    "activity",
    "a locked device cannot decide the hold, so it offers no review",
  );
});
