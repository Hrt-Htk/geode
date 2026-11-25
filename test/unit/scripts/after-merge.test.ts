// Unit tests for after-merge helpers (#413).

import { assertEquals } from "@std/assert";
import { staleBoardItems } from "../../../scripts/after-merge.ts";

// #413: after-merge moves closed issues and merged PRs to Done on the board.
const item = (id: string, state: string | undefined, status: string | null) => ({
  id,
  content: state ? { state } : {},
  fieldValueByName: status ? { name: status } : null,
});

Deno.test("staleBoardItems: closed or merged but not Done", () => {
  assertEquals(
    staleBoardItems([
      item("closed-in-progress", "CLOSED", "In Progress"),
      item("merged-pr-no-status", "MERGED", null),
      item("closed-done", "CLOSED", "Done"),
      item("open-in-progress", "OPEN", "In Progress"),
      item("draft", undefined, "Todo"),
    ]),
    ["closed-in-progress", "merged-pr-no-status"],
  );
});
