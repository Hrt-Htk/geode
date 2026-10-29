import { formatServerLine } from "../../../server/log.ts";
import type { LogEntry } from "../../../core/log.ts";
import { assert, assertEquals } from "@std/assert";

Deno.test("server log - formatServerLine produces flat JSON with ISO ts", () => {
  const entry: LogEntry = {
    ts: 1700000000000,
    level: "info",
    msg: "hello",
    fields: { hash: "abc" },
  };
  const line = formatServerLine(entry);
  const parsed = JSON.parse(line);

  // ts rendered as ISO 8601 string (not epoch number)
  assertEquals(typeof parsed.ts, "string");
  assert(parsed.ts.startsWith("2023"));

  // level and msg present
  assertEquals(parsed.level, "info");
  assertEquals(parsed.msg, "hello");

  // fields flattened to top level
  assertEquals(parsed.hash, "abc");
});

Deno.test("server log - formatServerLine handles empty fields", () => {
  const entry: LogEntry = {
    ts: 1700000000000,
    level: "error",
    msg: "boom",
    fields: {},
  };
  const parsed = JSON.parse(formatServerLine(entry));
  assertEquals(parsed.level, "error");
  assertEquals(parsed.msg, "boom");
  // only ts, level, msg: no extra keys
  assertEquals(Object.keys(parsed).length, 3);
});
