import {
  addSink,
  clearSinks,
  emit,
  type LogEntry,
  setDebugEnabled,
  type Sink,
} from "../../../core/log.ts";
import { assertEquals, assertNotEquals } from "@std/assert";

const reset = () => {
  clearSinks();
  setDebugEnabled(false);
};

Deno.test({
  name: "log - emit fans out a well-formed entry",
  fn() {
    reset();
    const entries: LogEntry[] = [];
    addSink((e) => entries.push(e));

    emit("info", "hello", { key: "val" });

    assertEquals(entries.length, 1);
    const entry = entries[0];
    assertNotEquals(typeof entry.ts, "undefined");
    assertEquals(typeof entry.ts, "number");
    assertEquals(entry.level, "info");
    assertEquals(entry.msg, "hello");
    assertEquals(entry.fields, { key: "val" });
  },
});

Deno.test({
  name: "log - emit defaults fields to {} when omitted",
  fn() {
    reset();
    const entries: LogEntry[] = [];
    addSink((e) => entries.push(e));

    emit("warn", "no fields");

    assertEquals(entries.length, 1);
    assertEquals(entries[0].fields, {});
  },
});

Deno.test({
  name: "log - multiple sinks all receive the same entry",
  fn() {
    reset();
    const a: LogEntry[] = [];
    const b: LogEntry[] = [];
    addSink((e) => a.push(e));
    addSink((e) => b.push(e));

    emit("error", "boom", { code: 500 });

    assertEquals(a.length, 1);
    assertEquals(b.length, 1);
    assertEquals(a[0], b[0]);
    assertEquals(a[0].msg, "boom");
  },
});

Deno.test({
  name: "log - unsubscribe removes only that sink",
  fn() {
    reset();
    const a: LogEntry[] = [];
    const b: LogEntry[] = [];
    const unsubA = addSink((e) => a.push(e));
    addSink((e) => b.push(e));

    unsubA();

    emit("info", "after unsub");

    assertEquals(a.length, 0);
    assertEquals(b.length, 1);
  },
});

Deno.test({
  name: "log - debug gating: disabled drops debug, enabled delivers",
  fn() {
    reset();
    const entries: LogEntry[] = [];
    addSink((e) => entries.push(e));

    emit("debug", "should be dropped");
    assertEquals(entries.length, 0);

    setDebugEnabled(true);
    emit("debug", "should arrive");
    assertEquals(entries.length, 1);
    assertEquals(entries[0].msg, "should arrive");
  },
});

Deno.test({
  name: "log - debug gating: info/warn/error always deliver regardless of gate",
  fn() {
    reset();
    const entries: LogEntry[] = [];
    addSink((e) => entries.push(e));

    emit("info", "info msg");
    emit("warn", "warn msg");
    emit("error", "error msg");

    assertEquals(entries.length, 3);
    assertEquals(entries[0].level, "info");
    assertEquals(entries[1].level, "warn");
    assertEquals(entries[2].level, "error");
  },
});

Deno.test({
  name: "log - throwing sink doesn't stop other sinks or emit",
  fn() {
    reset();
    const good: LogEntry[] = [];
    const badSink: Sink = () => {
      throw new Error("boom");
    };

    addSink(badSink);
    addSink((e) => good.push(e));

    // Should not throw
    emit("info", "resilient");

    assertEquals(good.length, 1);
    assertEquals(good[0].msg, "resilient");
  },
});

Deno.test({
  name: "log - clearSinks stops all delivery",
  fn() {
    reset();
    const entries: LogEntry[] = [];
    addSink((e) => entries.push(e));

    emit("info", "before clear");
    assertEquals(entries.length, 1);

    clearSinks();

    emit("info", "after clear");
    assertEquals(entries.length, 1);
  },
});

Deno.test({
  name: "log - fields passed through verbatim",
  fn() {
    reset();
    const entries: LogEntry[] = [];
    addSink((e) => entries.push(e));

    const fields = { hash: "abc", version: 7, nested: { a: 1 } };
    emit("debug", "test", fields);

    // debug is dropped by default, so enable it and re-test
    clearSinks();
    setDebugEnabled(true);
    addSink((e) => entries.push(e));
    emit("debug", "test", fields);

    assertEquals(entries.length, 1);
    assertEquals(entries[0].fields, fields);
    assertEquals(entries[0].fields.hash, "abc");
    assertEquals(entries[0].fields.version, 7);
  },
});
