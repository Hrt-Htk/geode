import { assertEquals } from "@std/assert";
import { acquirePathLock } from "../../../plugin/sync/path-lock.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";

// #630 review: one writer per path, and a bounded wait: a commit whose socket is gone
// stays in flight until reconnect, and a resolution (or a queued commit) waiting on it
// unboundedly would stall the version queue behind one path.

const PATH = "notes.md";

Deno.test("path lock - writers on one path are serialized", async () => {
  const state = openStateDB();
  const first = await acquirePathLock(state, PATH);
  assertEquals(typeof first, "function");
  const second = await acquirePathLock(state, PATH, 20);
  assertEquals(second, null, "a held path is not handed out twice");
  first!();
  const third = await acquirePathLock(state, PATH, 20);
  assertEquals(typeof third, "function", "released, so the next writer gets it");
  third!();
  state.close();
});

Deno.test("path lock - a writer that gave up never lets a later one run alongside the holder", async () => {
  const state = openStateDB();
  const holder = await acquirePathLock(state, PATH);
  assertEquals(await acquirePathLock(state, PATH, 10), null, "timed out");
  assertEquals(await acquirePathLock(state, PATH, 10), null, "still held after the timeout");
  holder!();
  const next = await acquirePathLock(state, PATH, 10);
  assertEquals(typeof next, "function");
  next!();
  state.close();
});

Deno.test("path lock - another path and another vault are independent", async () => {
  const state = openStateDB();
  const held = await acquirePathLock(state, PATH);
  const otherPath = await acquirePathLock(state, "other.md", 10);
  const otherState = openStateDB();
  const otherVault = await acquirePathLock(otherState, PATH, 10);
  assertEquals(typeof otherPath, "function");
  assertEquals(typeof otherVault, "function");
  held!();
  otherPath!();
  otherVault!();
  state.close();
  otherState.close();
});
