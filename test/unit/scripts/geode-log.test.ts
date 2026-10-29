// #680 L-6 - deploy/geode-log interpolates its two arguments into SQL text, so both
// are held to the shape they can legitimately have before any query runs.
import { assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT = new URL("../../../deploy/geode-log", import.meta.url).pathname;
const UUID = "01234567-89ab-cdef-0123-456789abcdef";

async function run(...args: string[]): Promise<{ code: number; stderr: string }> {
  const out = await new Deno.Command("bash", {
    args: [SCRIPT, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
}

Deno.test({
  name: "geode-log - a vault id carrying SQL is refused before any query",
  async fn() {
    for (const bad of ["1'; DROP TABLE file_versions; --", "abc%'", "$(id)", "a b"]) {
      const r = await run(bad);
      assertEquals(r.code, 1, `accepted ${bad}`);
      assertStringIncludes(r.stderr, "not a vault id");
    }
  },
});

Deno.test({
  name: "geode-log - a limit that is not an integer is refused",
  async fn() {
    for (const bad of ["30; DROP TABLE file_versions", "-1", "1e3"]) {
      const r = await run(UUID, bad);
      assertEquals(r.code, 1, `accepted limit ${bad}`);
      assertStringIncludes(r.stderr, "limit must be");
    }
  },
});
