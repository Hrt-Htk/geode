// #535: machine-specific E2E values come from the environment; never a personal
// default. A missing value must name the variable and the committed `.env.example`.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { phoneTestVault, requireEnv } from "../../e2e/env.ts";

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const prev = Deno.env.get(name);
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
  try {
    fn();
  } finally {
    if (prev === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prev);
  }
}

Deno.test("requireEnv: a missing value names the variable and .env.example", () => {
  withEnv("GEODE_TEST_UNSET", undefined, () => {
    const err = assertThrows(() => requireEnv("GEODE_TEST_UNSET"), Error);
    assert(err.message.includes("GEODE_TEST_UNSET"), err.message);
    assert(err.message.includes(".env.example"), err.message);
  });
});

Deno.test("requireEnv: an empty or blank value counts as missing", () => {
  for (const value of ["", "   "]) {
    withEnv("GEODE_TEST_BLANK", value, () => {
      assertThrows(() => requireEnv("GEODE_TEST_BLANK"), Error, "GEODE_TEST_BLANK");
    });
  }
});

Deno.test("requireEnv: returns the value verbatim", () => {
  withEnv("GEODE_TEST_SET", "192.0.2.10:5555", () => {
    assertEquals(requireEnv("GEODE_TEST_SET"), "192.0.2.10:5555");
  });
});

Deno.test("phoneTestVault: requires GEODE_PHONE_VAULT and drops a trailing slash", () => {
  withEnv("GEODE_PHONE_VAULT", undefined, () => {
    assertThrows(() => phoneTestVault(), Error, "GEODE_PHONE_VAULT");
  });
  withEnv("GEODE_PHONE_VAULT", "/storage/emulated/0/Documents/TestVault/", () => {
    assertEquals(phoneTestVault(), "/storage/emulated/0/Documents/TestVault");
  });
});

Deno.test("phoneTestVault: refuses a filesystem root", () => {
  for (const value of ["/", "///"]) {
    withEnv("GEODE_PHONE_VAULT", value, () => {
      assertThrows(
        () => phoneTestVault(),
        Error,
        "GEODE_PHONE_VAULT must be a vault folder, not a filesystem root",
      );
    });
  }
});
