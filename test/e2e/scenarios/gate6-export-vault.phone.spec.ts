import { test } from "@playwright/test";

test("gate6 export decrypted vault (phone): skipped - desktop-only", () => {
  test.skip(
    true,
    "Export decrypted vault is desktop-only: Android filesystem sandbox prevents writing to arbitrary paths. The export feature requires a user-chosen folder, which is not available on Android.",
  );
});
