import { assert, assertEquals } from "@std/assert";
import { type Adapter, atomicWriteBinary } from "../../../plugin/plumbing/atomic-write.ts";

// --- Helpers ---

function makeFakeAdapter(
  opts: { rejectRename?: boolean; rejectTempWrite?: boolean; noRemove?: boolean } = {},
): {
  adapter: Adapter;
  calls: { type: string; args: unknown[] }[];
} {
  const { rejectRename = false, rejectTempWrite = false, noRemove = false } = opts;
  const calls: { type: string; args: unknown[] }[] = [];

  const adapter: Adapter = {
    writeBinary: (path: string, data: Uint8Array) => {
      calls.push({ type: "writeBinary", args: [path, Array.from(data)] });
      if (rejectTempWrite && path.endsWith(".tmp")) {
        return Promise.reject(new Error("temp write failed"));
      }
      return Promise.resolve();
    },
    rename: (from: string, to: string) => {
      calls.push({ type: "rename", args: [from, to] });
      if (rejectRename) {
        return Promise.reject(new Error("rename failed"));
      }
      return Promise.resolve();
    },
    ...(noRemove ? {} : {
      remove: (path: string) => {
        calls.push({ type: "remove", args: [path] });
        return Promise.resolve();
      },
    }),
  };

  return { adapter, calls };
}

// --- Tests ---

Deno.test("atomic-write - happy path writes tmp then renames", async () => {
  const { adapter, calls } = makeFakeAdapter();
  const bytes = new Uint8Array([1, 2, 3]);

  await atomicWriteBinary(adapter, "state.json", bytes);

  // Should write to tmp first, then rename tmp -> target
  assertEquals(calls.length, 2);
  assertEquals(calls[0].type, "writeBinary");
  assertEquals(calls[0].args[0], "state.json.tmp");
  assertEquals(calls[0].args[1], [1, 2, 3]);

  assertEquals(calls[1].type, "rename");
  assertEquals(calls[1].args[0], "state.json.tmp");
  assertEquals(calls[1].args[1], "state.json");
});

Deno.test("atomic-write - rename failure falls back to direct writeBinary", async () => {
  const { adapter, calls } = makeFakeAdapter({ rejectRename: true });
  const bytes = new Uint8Array([4, 5, 6]);

  await atomicWriteBinary(adapter, "state.json", bytes);

  // write tmp -> rename fails -> fallback writeBinary(path, bytes) -> best-effort remove tmp
  const writeBinaryCalls = calls.filter((c) => c.type === "writeBinary");
  const renameCalls = calls.filter((c) => c.type === "rename");

  assert(renameCalls.length === 1, "rename should be attempted");
  assertEquals(renameCalls[0].args[0], "state.json.tmp");
  assertEquals(renameCalls[0].args[1], "state.json");

  // Fallback: direct write to the actual target path (not .tmp)
  const fallbackWrite = writeBinaryCalls.find(
    (c) => c.args[0] === "state.json",
  );
  assert(fallbackWrite !== undefined, "fallback writeBinary(state.json, bytes) should fire");
  assertEquals(fallbackWrite.args[1], [4, 5, 6]);
});

Deno.test("atomic-write - temp write failure falls back to direct writeBinary", async () => {
  const { adapter, calls } = makeFakeAdapter({ rejectTempWrite: true });
  const bytes = new Uint8Array([7, 8, 9]);

  await atomicWriteBinary(adapter, "state.json", bytes);

  // temp write fails -> fallback writeBinary(path, bytes)
  const writeBinaryCalls = calls.filter((c) => c.type === "writeBinary");

  // The first writeBinary (to .tmp) should have thrown, then fallback fires
  const fallbackWrite = writeBinaryCalls.find(
    (c) => c.args[0] === "state.json",
  );
  assert(fallbackWrite !== undefined, "fallback writeBinary(state.json, bytes) should fire");
  assertEquals(fallbackWrite.args[1], [7, 8, 9]);

  // No rename should happen since temp write failed
  const renameCalls = calls.filter((c) => c.type === "rename");
  assertEquals(renameCalls.length, 0, "no rename after temp write failure");
});

Deno.test("atomic-write - adapter without remove still falls back on rename failure", async () => {
  const { adapter, calls } = makeFakeAdapter({ rejectRename: true, noRemove: true });

  await atomicWriteBinary(adapter, "state.json", new Uint8Array([10]));

  const fallbackWrite = calls.find((c) => c.type === "writeBinary" && c.args[0] === "state.json");
  assert(fallbackWrite !== undefined, "fallback should fire even without remove");
});
