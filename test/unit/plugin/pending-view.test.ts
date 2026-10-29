import { assertEquals } from "@std/assert";
import { mergePendingViews } from "../../../plugin/sync/pending-view.ts";

Deno.test("mergePendingViews: only queued -> every entry stage queued, same order", () => {
  const queued = [
    { path: "a.md", kind: "commit" },
    { path: "b.md", kind: "commit" },
    { path: "c.md", kind: "delete" },
  ];
  const inFlight: Array<{ path: string; kind: string }> = [];

  const result = mergePendingViews(queued, inFlight);

  assertEquals(result, [
    { path: "a.md", kind: "commit", stage: "queued" },
    { path: "b.md", kind: "commit", stage: "queued" },
    { path: "c.md", kind: "delete", stage: "queued" },
  ]);
});

Deno.test("mergePendingViews: only inFlight -> every entry stage pushing", () => {
  const queued: Array<{ path: string; kind: string }> = [];
  const inFlight = [
    { path: "x.md", kind: "commit" },
    { path: "y.md", kind: "delete" },
  ];

  const result = mergePendingViews(queued, inFlight);

  assertEquals(result, [
    { path: "x.md", kind: "commit", stage: "pushing" },
    { path: "y.md", kind: "delete", stage: "pushing" },
  ]);
});

Deno.test("mergePendingViews: overlap dedup by path, pushing first then queued", () => {
  const queued = [
    { path: "a.md", kind: "commit" },
    { path: "b.md", kind: "commit" },
  ];
  const inFlight = [
    { path: "b.md", kind: "commit" },
    { path: "c.md", kind: "delete" },
  ];

  const result = mergePendingViews(queued, inFlight);

  assertEquals(result, [
    { path: "b.md", kind: "commit", stage: "pushing" },
    { path: "c.md", kind: "delete", stage: "pushing" },
    { path: "a.md", kind: "commit", stage: "queued" },
  ]);
});

Deno.test("mergePendingViews: both empty -> []", () => {
  const queued: Array<{ path: string; kind: string }> = [];
  const inFlight: Array<{ path: string; kind: string }> = [];

  const result = mergePendingViews(queued, inFlight);

  assertEquals(result, []);
});
