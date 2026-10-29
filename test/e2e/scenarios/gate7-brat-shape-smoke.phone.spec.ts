import { test } from "@playwright/test";

test("gate7 BRAT-shape smoke (phone): skipped - desktop-only", () => {
  test.skip(
    true,
    "BRAT-shape smoke test is desktop-only: it tests the specific file layout (main.js + manifest.json) of a BRAT install. On phone, BRAT install is verified manually per release. gate4-plugin-loads.phone.spec.ts covers the plugin loading path on phone.",
  );
});
