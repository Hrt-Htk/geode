import { describeStorage, type StorageState } from "../../../plugin/ui/storage-status.ts";
import { assertEquals } from "@std/assert";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function data(used: number, free: number, total: number, vaultUsed?: number): StorageState {
  return { kind: "data", used, free, total, vault_used: vaultUsed };
}

Deno.test("storage-status - loading", () => {
  assertEquals(describeStorage({ kind: "loading" }), {
    text: "Checking storage…",
    level: "loading",
    vaultPct: 0,
    otherPct: 0,
  });
});

Deno.test("storage-status - unavailable", () => {
  assertEquals(describeStorage({ kind: "unavailable" }), {
    text: "Storage info unavailable. The server didn't answer.",
    level: "unavailable",
    vaultPct: null,
    otherPct: null,
  });
});

Deno.test("storage-status - normal shows this vault's size first, then server free space", () => {
  assertEquals(describeStorage(data(40 * GB, 60 * GB, 100 * GB, 10 * GB)), {
    text: "This vault 10 GB · 60 GB free",
    level: "normal",
    vaultPct: 10,
    otherPct: 30,
  });
});

Deno.test("storage-status - older server without vault_used falls back to disk text", () => {
  assertEquals(describeStorage(data(1.2 * GB, 478 * GB, 480 * GB)), {
    text: "1.2 GB used · 478 GB free",
    level: "normal",
    vaultPct: 0,
    otherPct: 0,
  });
});

Deno.test("storage-status - warning by percentage (free < 10 % of total)", () => {
  assertEquals(describeStorage(data(91 * GB, 9 * GB, 100 * GB, 5 * GB)), {
    text: "This vault 5 GB · Low on server space. 9 GB free.",
    level: "warning",
    vaultPct: 5,
    otherPct: 86,
  });
});

Deno.test("storage-status - warning by absolute floor (free < 5 GB, pct ≥ 10 %)", () => {
  assertEquals(describeStorage(data(35.5 * GB, 4.5 * GB, 40 * GB, 2 * GB)), {
    text: "This vault 2 GB · Low on server space. 4.5 GB free.",
    level: "warning",
    vaultPct: 5,
    otherPct: 84,
  });
});

Deno.test("storage-status - normal at the boundaries (exactly 10 % and ≥ 5 GB)", () => {
  assertEquals(describeStorage(data(90 * GB, 10 * GB, 100 * GB, 10 * GB)).level, "normal");
  assertEquals(describeStorage(data(45 * GB, 5 * GB, 50 * GB, 5 * GB)).level, "normal");
});

Deno.test("storage-status - full (free = 0)", () => {
  assertEquals(describeStorage(data(100 * GB, 0, 100 * GB, 100 * GB)), {
    text: "This vault 100 GB · Server full, uploads paused",
    level: "error",
    vaultPct: 100,
    otherPct: 0,
  });
});

Deno.test("storage-status - byte formatting", () => {
  assertEquals(
    describeStorage(data(1.2 * GB, 478 * GB, 480 * GB, 1.2 * GB)).text,
    "This vault 1.2 GB · 478 GB free",
  );
  assertEquals(
    describeStorage(data(850 * MB, 478 * GB, 479 * GB, 850 * MB)).text,
    "This vault 850 MB · 478 GB free",
  );
  assertEquals(
    describeStorage(data(478 * GB, 60 * GB, 538 * GB, 478 * GB)).text,
    "This vault 478 GB · 60 GB free",
  );
});

Deno.test("storage-status - a small vault keeps a visible meter slice", () => {
  assertEquals(describeStorage(data(30 * GB, 60 * GB, 90 * GB, 169 * MB)).vaultPct, 2);
  assertEquals(describeStorage(data(30 * GB, 60 * GB, 90 * GB, 0)).vaultPct, 0);
});

Deno.test("storage-status - older server without vault_used keeps the old warning and full texts", () => {
  assertEquals(
    describeStorage(data(91 * GB, 9 * GB, 100 * GB)).text,
    "Low on server space. 9 GB free.",
  );
  assertEquals(
    describeStorage(data(100 * GB, 0, 100 * GB)).text,
    "Server storage is full. Uploads resume when space frees up.",
  );
});
