import { assertEquals } from "@std/assert";
import { shouldStampBackup } from "../../../plugin/sync/backup-stamp.ts";

Deno.test("backup-stamp - clean live pass stamps", () => {
  assertEquals(
    shouldStampBackup({ live: true, dirty: 0, pending: 0, dropped: 0 }),
    true,
  );
});

Deno.test("backup-stamp - a pass with a dropped op does not stamp", () => {
  assertEquals(
    shouldStampBackup({ live: true, dirty: 0, pending: 0, dropped: 1 }),
    false,
    "last_backup_at must not move while a commit is dropped",
  );
});

Deno.test("backup-stamp - dirty, pending, or not-live do not stamp", () => {
  assertEquals(shouldStampBackup({ live: true, dirty: 1, pending: 0, dropped: 0 }), false);
  assertEquals(shouldStampBackup({ live: true, dirty: 0, pending: 2, dropped: 0 }), false);
  assertEquals(shouldStampBackup({ live: false, dirty: 0, pending: 0, dropped: 0 }), false);
});
