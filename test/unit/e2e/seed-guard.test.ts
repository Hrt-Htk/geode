// #518: hybrid runs fail fast in Playwright global setup when GEODE_SEED_VAULT_DIR
// is missing or not a directory. Tests the pure decision (no Playwright, no fs).
import { assertEquals } from "@std/assert";
import { hybridInRun, seedDirProblem } from "../../e2e/seed-guard.ts";

const isDir = (d: string) => d === "/ok";

Deno.test("hybridInRun: no --project flag means all projects run", () => {
  assertEquals(hybridInRun(["test", "--config=test/e2e/playwright.config.ts"]), true);
});

Deno.test("hybridInRun: --project flag, = and space forms, repeated, comma lists", () => {
  assertEquals(hybridInRun(["test", "--project=hybrid"]), true);
  assertEquals(hybridInRun(["test", "--project", "hybrid"]), true);
  assertEquals(hybridInRun(["test", "--project", "default", "hybrid"]), true);
  assertEquals(hybridInRun(["test", "--project=default,phone"]), false);
  assertEquals(hybridInRun(["test", "--project=phone"]), false);
});

Deno.test("seedDirProblem: hybrid run needs a usable seed dir", () => {
  const missing = seedDirProblem(true, undefined, isDir);
  assertEquals(missing?.includes("GEODE_SEED_VAULT_DIR"), true);
  assertEquals(seedDirProblem(true, "/nope", isDir)?.includes("/nope"), true);
  assertEquals(seedDirProblem(true, "/ok", isDir), null);
});

Deno.test("seedDirProblem: non-hybrid runs never need the seed dir", () => {
  assertEquals(seedDirProblem(false, undefined, isDir), null);
  assertEquals(seedDirProblem(false, "/nope", isDir), null);
});
