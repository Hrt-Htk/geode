import { expect, test } from "@playwright/test";
import path from "node:path";
import { launchObsidian, TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { BENCH457_SALT_B64, runBench457 } from "../helpers/bench457";

const OUT_PATH = path.resolve(__dirname, "..", "test-results", "bench457-desktop.json");

test("bench457: argon2 levels + chunk crypto in the real desktop renderer", async () => {
  test.skip(
    process.env.GEODE_BENCH !== "1",
    "manual benchmark: run with GEODE_BENCH=1, never in CI",
  );
  test.setTimeout(900_000);

  const instance = await launchObsidian({
    geodeSettings: {
      serverUrl: "http://127.0.0.1:1",
      vaultId: "bench457-vault",
      deviceId: "bench457-device",
      deviceToken: "bench457-token",
      salt: BENCH457_SALT_B64,
      argon2Params: TEST_ARGON2_PARAMS,
    },
  });

  try {
    await expect
      .poll(async () => await instance.eval<boolean>("Boolean(app.plugins.plugins.geode)"), {
        timeout: 60_000,
      })
      .toBe(true);

    await runBench457(instance, "desktop", OUT_PATH);
  } finally {
    await instance.close().catch(() => {});
  }
});
