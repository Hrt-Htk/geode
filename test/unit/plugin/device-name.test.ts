import { assert, assertEquals } from "@std/assert";
import { generateDeviceName, validateDeviceName } from "../../../plugin/ui/device-name.ts";

Deno.test("generateDeviceName - desktop prefix", () => {
  const name = generateDeviceName(false);
  assert(name.startsWith("Desktop "), `expected Desktop prefix, got ${name}`);
  const suffix = name.slice("Desktop ".length);
  assert(suffix.length > 0, "noun part must be non-empty");
  assert(!suffix.includes(" "), "noun part must have no spaces");
});

Deno.test("generateDeviceName - mobile prefix", () => {
  const name = generateDeviceName(true);
  assert(name.startsWith("Mobile "), `expected Mobile prefix, got ${name}`);
  const suffix = name.slice("Mobile ".length);
  assert(suffix.length > 0, "noun part must be non-empty");
  assert(!suffix.includes(" "), "noun part must have no spaces");
});

Deno.test("validateDeviceName - trims and accepts", () => {
  assertEquals(validateDeviceName("  ok "), { ok: true, name: "ok" });
});

Deno.test("validateDeviceName - rejects empty", () => {
  const empty = validateDeviceName("");
  assert(!empty.ok, "empty string must fail");
  assert(empty.ok === false && empty.error.length > 0, "must carry a non-empty error");
  const spaces = validateDeviceName("   ");
  assert(!spaces.ok, "whitespace-only must fail");
  assert(spaces.ok === false && spaces.error.length > 0, "must carry a non-empty error");
});

Deno.test("validateDeviceName - enforces 64-char limit", () => {
  const tooLong = validateDeviceName("x".repeat(65));
  assert(!tooLong.ok, "65 chars must fail");
  const max = validateDeviceName("x".repeat(64));
  assertEquals(max, { ok: true, name: "x".repeat(64) });
});
