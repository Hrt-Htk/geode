// #516: the benchmark and soak read the source vault in place: fail if either
// (or their shared helper) ever gains a call that writes to the vault path.
import { assertEquals } from "@std/assert";

const FORBIDDEN = [
  "Deno.writeFile",
  "Deno.writeTextFile",
  "Deno.remove",
  "Deno.rename",
  "Deno.mkdir",
  "Deno.copyFile",
  "Deno.create",
  "Deno.truncate",
  "Deno.open",
];

for (const name of ["bench-real.ts", "bench-helpers.ts", "soak.ts"]) {
  Deno.test(`${name} stays read-only against the source vault`, async () => {
    const src = await Deno.readTextFile(new URL(`./${name}`, import.meta.url));
    assertEquals(FORBIDDEN.filter((call) => src.includes(call)), []);
  });
}
