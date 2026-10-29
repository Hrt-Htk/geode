import { assertEquals, assertMatch, assertStrictEquals } from "@std/assert";
import {
  connectionLabel,
  filterLogEntries,
  formatLogExport,
  formatLogLine,
  LOG_LINE_LIMIT,
  logDetailsText,
  type LogFilter,
} from "../../../plugin/ui/log-format.ts";
import { type LogEntry } from "../../../plugin/plumbing/log.ts";

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    ts: Date.parse("2025-01-15T13:47:09Z"),
    level: "info",
    msg: "test message",
    fields: {},
    ...overrides,
  };
}

/* ── formatLogLine / formatLogExport (moved from the removed debug pane) ── */

Deno.test("formatLogLine - entry with error field includes the error text", () => {
  const line = formatLogLine(entry({
    level: "error",
    msg: "failed to handle remote version",
    fields: { error: "ENOENT: no such file or directory, open 'Untitled 1.md'" },
  }));
  assertMatch(line, /ENOENT/);
  assertMatch(line, /failed to handle remote version/);
  assertMatch(line, /error=/);
});

Deno.test("formatLogLine - multiple fields all appear", () => {
  const line = formatLogLine(entry({
    level: "warn",
    msg: "retrying upload",
    fields: { attempt: 3, chunkId: "abc123", reason: "timeout" },
  }));
  assertMatch(line, /attempt=3/);
  assertMatch(line, /chunkId=abc123/);
  assertMatch(line, /reason=timeout/);
});

Deno.test("formatLogLine - empty fields produces legacy format", () => {
  assertEquals(formatLogLine(entry()), "[13:47:09] [info] test message");
});

Deno.test("formatLogLine - non-string field values are stringified", () => {
  const line = formatLogLine(entry({
    level: "debug",
    msg: "chunk stats",
    fields: { size: 4096, compressed: true, meta: { algorithm: "fastcdc" } },
  }));
  assertMatch(line, /size=4096/);
  assertMatch(line, /compressed=true/);
  assertMatch(line, /meta=/);
  assertMatch(line, /fastcdc/);
});

Deno.test("formatLogExport - empty array returns empty string", () => {
  assertEquals(formatLogExport([]), "");
});

Deno.test("formatLogExport - single entry returns formatLogLine with no trailing newline", () => {
  const sample = entry();
  const result = formatLogExport([sample]);
  assertEquals(result, formatLogLine(sample));
  assertStrictEquals(result.endsWith("\n"), false, "should not have trailing newline");
});

Deno.test("formatLogExport - multiple entries joined by newline", () => {
  const entries = [entry({ msg: "a" }), entry({ msg: "b" }), entry({ msg: "c" })];
  const result = formatLogExport(entries);
  const lines = result.split("\n");
  assertEquals(lines.length, entries.length);
  for (let i = 0; i < entries.length; i++) {
    assertEquals(lines[i], formatLogLine(entries[i]));
  }
});

/* ── filterLogEntries: the All / Warnings / Errors level filter ── */

const MIXED = [
  entry({ level: "info", msg: "sync started" }),
  entry({ level: "warn", msg: "slow response" }),
  entry({ level: "error", msg: "failed to apply op" }),
  entry({ level: "debug", msg: "chunk stats" }),
];

Deno.test("filterLogEntries - all returns every entry unchanged", () => {
  const out = filterLogEntries(MIXED, "all");
  assertEquals(out.length, MIXED.length);
  assertEquals(out, MIXED);
});

Deno.test("filterLogEntries - warn keeps only warn lines", () => {
  const out = filterLogEntries(MIXED, "warn");
  assertEquals(out.map((e) => e.level), ["warn"]);
});

Deno.test("filterLogEntries - error keeps only error lines", () => {
  const out = filterLogEntries(MIXED, "error");
  assertEquals(out.map((e) => e.level), ["error"]);
});

Deno.test("filterLogEntries - empty input stays empty", () => {
  for (const filter of ["all", "warn", "error"] as LogFilter[]) {
    assertEquals(filterLogEntries([], filter), []);
  }
});

/* ── logDetailsText: "Connected · seq 1284 · 2 pending" ── */

Deno.test("logDetailsText - state, seq and pending joined with middots", () => {
  assertEquals(
    logDetailsText({ state: "Connected", seq: 1284, pending: 2 }),
    "Connected · seq 1284 · 2 pending",
  );
});

Deno.test("logDetailsText - zero pending reads naturally", () => {
  assertEquals(
    logDetailsText({ state: "Connected", seq: 0, pending: 0 }),
    "Connected · seq 0 · 0 pending",
  );
});

Deno.test("connectionLabel - maps transport states to user-facing words", () => {
  assertEquals(connectionLabel("live"), "Connected");
  assertEquals(connectionLabel("connected"), "Connected");
  assertEquals(connectionLabel("syncing"), "Syncing");
  assertEquals(connectionLabel("connecting"), "Connecting");
  assertEquals(connectionLabel("disconnected"), "Disconnected");
  assertEquals(connectionLabel("blocked"), "Blocked");
});

Deno.test("connectionLabel - unknown state falls back to Disconnected", () => {
  assertEquals(connectionLabel("something-new"), "Disconnected");
});

/* ── LOG_LINE_LIMIT: the log box renders at most this many lines ── */

Deno.test("LOG_LINE_LIMIT - caps the rendered log box", () => {
  assertEquals(typeof LOG_LINE_LIMIT, "number");
  assertEquals(LOG_LINE_LIMIT > 0, true);
});
