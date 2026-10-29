import { assertEquals } from "@std/assert";
import { VaultEventHandler } from "../../../plugin/sync/events.ts";

interface AdapterRecord {
  writeJSONCalls: Array<{ path: string; data: unknown }>;
  removeCalls: string[];
  readJSONMap: Map<string, unknown>;
  existsMap: Map<string, boolean>;
}

function makeMockVault(records: AdapterRecord) {
  return {
    on: (_name: string, _cb: (...args: unknown[]) => void) => {},
    off: (_name: string, _cb: (...args: unknown[]) => void) => {},
    adapter: {
      readJSON: (path: string) => {
        const val = records.readJSONMap.get(path);
        if (val === undefined) throw new Error(`ENOENT: ${path}`);
        return val;
      },
      writeJSON: (path: string, data: unknown) => {
        records.writeJSONCalls.push({ path, data });
      },
      remove: (path: string) => {
        records.removeCalls.push(path);
        records.readJSONMap.delete(path);
      },
      exists: (path: string) => {
        return records.existsMap.get(path) ?? false;
      },
    },
  };
}

function makeMockVaultWithEvents(records: AdapterRecord) {
  const listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();
  return {
    on: (name: string, cb: (...args: unknown[]) => void) => {
      listeners.set(name, [...(listeners.get(name) ?? []), cb]);
    },
    off: (name: string, cb: (...args: unknown[]) => void) => {
      const arr = listeners.get(name) ?? [];
      listeners.set(name, arr.filter((f) => f !== cb));
    },
    adapter: {
      readJSON: (path: string) => {
        const val = records.readJSONMap.get(path);
        if (val === undefined) throw new Error(`ENOENT: ${path}`);
        return val;
      },
      writeJSON: (path: string, data: unknown) => {
        records.writeJSONCalls.push({ path, data });
      },
      remove: (path: string) => {
        records.removeCalls.push(path);
        records.readJSONMap.delete(path);
      },
      exists: (path: string) => {
        return records.existsMap.get(path) ?? false;
      },
    },
    trigger: (name: string, ...args: unknown[]) => {
      for (const cb of listeners.get(name) ?? []) {
        cb(...args);
      }
    },
  };
}

const PENDING_FILE = "pending.json";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test({
  name: "events - stop() does NOT persist pending.json",
  sanitizeOps: false,
  fn() {
    const records: AdapterRecord = {
      writeJSONCalls: [],
      removeCalls: [],
      readJSONMap: new Map(),
      existsMap: new Map(),
    };

    const flushOps: unknown[] = [];
    const vault = makeMockVault(records);
    const handler = new VaultEventHandler(
      vault as never,
      (ops) => flushOps.push(ops),
      () => true,
    );

    handler.start();
    handler.stop();

    assertEquals(
      records.writeJSONCalls.filter((c) => c.path === PENDING_FILE).length,
      0,
      "stop() must not write pending.json",
    );
  },
});

Deno.test({
  name: "events - firing events does NOT write pending.json",
  sanitizeOps: false,
  fn() {
    const records: AdapterRecord = {
      writeJSONCalls: [],
      removeCalls: [],
      readJSONMap: new Map(),
      existsMap: new Map(),
    };

    const vault = makeMockVaultWithEvents(records);
    const handler = new VaultEventHandler(
      vault as never,
      () => {},
      () => true,
    );

    handler.start();

    // Fire create and modify events
    (vault as unknown as { trigger: (n: string, ...a: unknown[]) => void }).trigger("create", {
      path: "test.md",
    });
    (vault as unknown as { trigger: (n: string, ...a: unknown[]) => void }).trigger("modify", {
      path: "test.md",
    });

    handler.stop();

    assertEquals(
      records.writeJSONCalls.filter((c) => c.path === PENDING_FILE).length,
      0,
      "no pending.json writes during event processing",
    );
  },
});

Deno.test({
  name: "events - start() does NOT delete a user-owned vault-root pending.json (array content)",
  sanitizeOps: false,
  async fn() {
    const pendingOps = [
      { path: "old.md", kind: "commit" as const, scheduledAt: 1000 },
    ];

    const records: AdapterRecord = {
      writeJSONCalls: [],
      removeCalls: [],
      readJSONMap: new Map([[PENDING_FILE, pendingOps]]),
      existsMap: new Map([[PENDING_FILE, true]]),
    };

    const vault = makeMockVault(records);
    const handler = new VaultEventHandler(
      vault as never,
      () => {},
      () => true,
    );

    handler.start();

    // A legacy cleanup used to remove this file on every start. Assert it
    // survives: it is a user-owned vault-root file.
    await sleep(0);

    assertEquals(
      records.removeCalls.filter((p) => p === PENDING_FILE).length,
      0,
      "start() must not delete a user-owned vault-root pending.json",
    );

    handler.stop();
  },
});
