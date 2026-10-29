import { compareSemVer, meetsMinimum, parseSemVer } from "../../../core/version.ts";
import { assert, assertEquals } from "@std/assert";

// ── parseSemVer ──────────────────────────────────────────────────────

Deno.test("version - parseSemVer parses valid semver", () => {
  assertEquals(parseSemVer("0.5.0"), { major: 0, minor: 5, patch: 0 });
  assertEquals(parseSemVer("1.0.0"), { major: 1, minor: 0, patch: 0 });
  assertEquals(parseSemVer("2.10.3"), { major: 2, minor: 10, patch: 3 });
});

Deno.test("version - parseSemVer rejects invalid inputs", () => {
  assertEquals(parseSemVer(""), null);
  assertEquals(parseSemVer("abc"), null);
  assertEquals(parseSemVer("1.0"), null);
  assertEquals(parseSemVer("1.0.0.0"), null);
  assertEquals(parseSemVer("v1.0.0"), null);
  assertEquals(parseSemVer("1.0.0-beta"), null);
  assertEquals(parseSemVer("1.0.x"), null);
  assertEquals(parseSemVer("-1.0.0"), null);
  assertEquals(parseSemVer("1.-1.0"), null);
  assertEquals(parseSemVer("1.0.-1"), null);
  assertEquals(parseSemVer("unknown"), null);
});

// ── compareSemVer ────────────────────────────────────────────────────

Deno.test("version - compareSemVer returns 0 for equal versions", () => {
  assertEquals(compareSemVer("1.2.3", "1.2.3"), 0);
  assertEquals(compareSemVer("0.0.0", "0.0.0"), 0);
});

Deno.test("version - compareSemVer returns 1 when a > b", () => {
  assertEquals(compareSemVer("1.0.0", "0.9.9"), 1);
  assertEquals(compareSemVer("0.2.0", "0.1.9"), 1);
  assertEquals(compareSemVer("0.1.2", "0.1.1"), 1);
});

Deno.test("version - compareSemVer returns -1 when a < b", () => {
  assertEquals(compareSemVer("0.9.9", "1.0.0"), -1);
  assertEquals(compareSemVer("0.1.9", "0.2.0"), -1);
  assertEquals(compareSemVer("0.1.1", "0.1.2"), -1);
});

Deno.test("version - compareSemVer treats unparseable as below any valid version", () => {
  assertEquals(compareSemVer("invalid", "0.0.1"), -1);
  assertEquals(compareSemVer("0.0.1", "invalid"), 1);
  assertEquals(compareSemVer("invalid", "invalid"), 0);
});

// ── meetsMinimum ─────────────────────────────────────────────────────

Deno.test("version - meetsMinimum: version >= minimum returns true", () => {
  assert(meetsMinimum("1.0.0", "1.0.0"));
  assert(meetsMinimum("1.0.1", "1.0.0"));
  assert(meetsMinimum("2.0.0", "1.0.0"));
  assert(meetsMinimum("0.5.0", "0.4.0"));
  assert(meetsMinimum("0.5.0", "0.5.0"));
});

Deno.test("version - meetsMinimum: version < minimum returns false", () => {
  assert(!meetsMinimum("0.9.9", "1.0.0"));
  assert(!meetsMinimum("0.4.0", "0.5.0"));
  assert(!meetsMinimum("1.0.0", "1.0.1"));
});

Deno.test("version - meetsMinimum: minimum 0.0.0 is always met", () => {
  assert(meetsMinimum("0.0.0", "0.0.0"));
  assert(meetsMinimum("1.0.0", "0.0.0"));
  assert(meetsMinimum("0.0.1", "0.0.0"));
});

Deno.test("version - meetsMinimum: unparseable version fails non-zero minimum", () => {
  assert(!meetsMinimum("invalid", "0.0.1"));
  assert(!meetsMinimum("", "0.0.1"));
  assert(!meetsMinimum("unknown", "1.0.0"));
});

Deno.test("version - meetsMinimum: unparseable version meets 0.0.0 minimum", () => {
  assert(meetsMinimum("invalid", "0.0.0"));
  assert(meetsMinimum("", "0.0.0"));
  assert(meetsMinimum("unknown", "0.0.0"));
});
