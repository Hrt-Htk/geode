import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Machine-specific values (ANDROID_SERIAL, GEODE_SERVER_URL, …) come from the
// environment, never from the repo (see .env.example). Locally they live in the
// gitignored .env.local; CI sets none of them and needs none.
const envLocal = path.resolve(__dirname, "../../.env.local");
if (existsSync(envLocal)) process.loadEnvFile(envLocal);

export default defineConfig({
  testDir: "./scenarios",
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ["list"],
    // Publishes holder progress (project, d/t) to the phone-lock sidecar so
    // queued waiters / `deno task phone:status` can show an ETA. No-ops for
    // runs that don't hold the phone lock. #508
    ["./phone-progress-reporter.ts"],
  ],
  outputDir: "./test-results",
  // Phone/hybrid projects take the shared test-phone flock for the whole run
  // (global-setup.ts); desktop-only runs skip it (gated on GEODE_PHONE). #496
  globalSetup: "./global-setup.ts",
  use: {
    actionTimeout: 45_000,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "default",
      testMatch: /\.spec\.ts$/,
      testIgnore: /\.(phone|hybrid)\.spec\.ts$/,
    },
    {
      name: "phone",
      testMatch: /\.phone\.spec\.ts$/,
    },
    {
      name: "hybrid",
      testMatch: /\.hybrid\.spec\.ts$/,
    },
  ],
});
