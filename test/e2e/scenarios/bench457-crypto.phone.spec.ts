import { test } from "@playwright/test";
import path from "node:path";
import { connectPhone } from "../fixtures/phone-obsidian";
import { BENCH457_SALT_B64, runBench457 } from "../helpers/bench457";

const OUT_PATH = path.resolve(__dirname, "..", "test-results", "bench457-phone.json");

test("bench457: argon2 levels + chunk crypto in the real phone renderer", async () => {
  test.skip(
    process.env.GEODE_PHONE !== "1" || process.env.GEODE_BENCH !== "1",
    "manual phone benchmark: run with GEODE_PHONE=1 GEODE_BENCH=1, never in CI",
  );
  test.setTimeout(1_800_000);

  const instance = await connectPhone({
    geodeSettings: {
      serverUrl: "http://127.0.0.1:1",
      vaultId: "bench457-vault",
      deviceId: "bench457-device",
      deviceToken: "bench457-token",
      salt: BENCH457_SALT_B64,
    },
  });

  try {
    await runBench457(instance, "phone", OUT_PATH);
  } finally {
    await instance.close().catch(() => {});
  }
});
