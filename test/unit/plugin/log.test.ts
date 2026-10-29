import { getRecentLog, log, setDebugLogging, subscribeLog } from "../../../plugin/plumbing/log.ts";
import { assertEquals } from "@std/assert";

Deno.test("plugin log - info entry appears in getRecentLog with fields", () => {
  log.info("m", { a: 1 });
  const entries = getRecentLog();
  const entry = entries[entries.length - 1];
  assertEquals(entry.msg, "m");
  assertEquals(entry.fields.a, 1);
});

Deno.test("plugin log - ring holds more than 200 entries", () => {
  const before = getRecentLog().length;
  for (let i = 0; i < 500; i++) {
    log.info(`ring test ${i}`);
  }
  const after = getRecentLog();
  // With RING_SIZE 2000, adding 500 should increase by exactly 500
  assertEquals(after.length - before, 500);
});

Deno.test("plugin log - subscribeLog fires on emit and unsubscribe stops it", () => {
  let callCount = 0;
  const unsub = subscribeLog(() => callCount++);
  log.info("sub test 1");
  assertEquals(callCount, 1);
  log.info("sub test 2");
  assertEquals(callCount, 2);
  unsub();
  log.info("sub test 3");
  assertEquals(callCount, 2);
});

Deno.test("plugin log - debug gate: disabled drops, enabled delivers", () => {
  setDebugLogging(false);
  const before = getRecentLog().length;
  log.debug("should be dropped");
  assertEquals(getRecentLog().length, before);

  setDebugLogging(true);
  log.debug("should appear");
  const entries = getRecentLog();
  assertEquals(entries[entries.length - 1].msg, "should appear");

  // Reset debug state for subsequent tests
  setDebugLogging(false);
});

Deno.test("plugin log - console sink gated off when debugLogging is false", () => {
  // Save originals and replace with spies
  const origDebug = console.debug;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;
  const calls: { method: string; args: unknown[] }[] = [];

  const spy = (method: string) => (...args: unknown[]) => calls.push({ method, args });

  console.debug = spy("debug");
  console.info = spy("info");
  console.warn = spy("warn");
  console.error = spy("error");

  try {
    setDebugLogging(false);

    log.error("console-test-error");
    log.info("console-test-info");
    log.warn("console-test-warn");

    // Console sink must NOT fire when debugLogging is false
    assertEquals(calls.length, 0, "no console.* calls when debugLogging is false");

    // But ring buffer must still capture everything
    const entries = getRecentLog();
    const msgs = entries.map((e) => e.msg);
    assertEquals(msgs.includes("console-test-error"), true, "error in ring");
    assertEquals(msgs.includes("console-test-info"), true, "info in ring");
    assertEquals(msgs.includes("console-test-warn"), true, "warn in ring");
  } finally {
    console.debug = origDebug;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
  }
});

Deno.test("plugin log - console sink fires when debugLogging is true", () => {
  const origInfo = console.info;
  const calls: unknown[][] = [];

  console.info = (...args: unknown[]) => calls.push(args);

  try {
    setDebugLogging(true);
    log.info("console-enabled-test");

    assertEquals(calls.length, 1, "console.info called once");
    assertEquals(typeof calls[0][0], "string");
    assertEquals((calls[0][0] as string).includes("console-enabled-test"), true);
  } finally {
    console.info = origInfo;
    setDebugLogging(false);
  }
});
