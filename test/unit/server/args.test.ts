// #680 L-4 - the admin token is env-only, so a flag that no longer exists must fail
// loudly: an ignored `--admin-token` leaves the server with no admin credential, and a
// 401 on provisioning is the only symptom. Any unknown argument is refused too, so a
// typo cannot start a server with the default port or data dir either.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseArgs } from "../../../server/args.ts";

function message(parsed: ReturnType<typeof parseArgs>): string {
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.message;
}

Deno.test("args - defaults, explicit flags and the env token", () => {
  assertEquals(parseArgs([], null), {
    ok: true,
    args: { dataDir: "./data", port: 8080, host: "0.0.0.0", adminToken: null },
  });
  assertEquals(
    parseArgs(["--data-dir", "/srv/geode/data", "--port", "9000", "--host", "127.0.0.1"], "tok"),
    {
      ok: true,
      args: { dataDir: "/srv/geode/data", port: 9000, host: "127.0.0.1", adminToken: "tok" },
    },
  );
});

Deno.test("args - an unknown flag is refused, never ignored", () => {
  for (const argv of [["--bogus"], ["stray"], ["--data-dir", "/d", "--prot", "1"]]) {
    assertStringIncludes(message(parseArgs(argv, null)), "unknown argument", argv.join(" "));
  }
});

Deno.test("args - a flag without a value is refused", () => {
  for (const argv of [["--data-dir"], ["--port"], ["--host"]]) {
    assertStringIncludes(message(parseArgs(argv, null)), "missing value", argv.join(" "));
  }
});

Deno.test("args - a port outside 0 to 65535, or not a number, is refused", () => {
  for (const bad of ["abc", "1.5", "-1", "65536", "", "8080x"]) {
    assertStringIncludes(message(parseArgs(["--port", bad], null)), "invalid --port", bad);
  }
  for (const ok of ["0", "8080", "65535"]) {
    assertEquals(parseArgs(["--port", ok], null).ok, true, ok);
  }
});

Deno.test("args - --admin-token in either form is refused and names the env var", () => {
  for (const argv of [["--admin-token", "secret"], ["--admin-token=secret"]]) {
    assertStringIncludes(message(parseArgs(argv, null)), "GEODE_ADMIN_TOKEN", argv.join(" "));
  }
});

Deno.test({
  name: "args - the server process exits 64 on --admin-token instead of starting tokenless",
  async fn() {
    const entry = new URL("../../../server/main.ts", import.meta.url).pathname;
    const dataDir = Deno.makeTempDirSync();
    try {
      const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-all", entry, "--data-dir", dataDir, "--admin-token", "secret"],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      // A server that starts anyway would hang this test: kill it so the assertion
      // fails on the exit code instead of blocking the suite.
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        const out = await child.output();
        assertEquals(out.code, 64, "a removed flag must stop the process");
        assertStringIncludes(new TextDecoder().decode(out.stderr), "GEODE_ADMIN_TOKEN");
      } finally {
        clearTimeout(timer);
      }
    } finally {
      Deno.removeSync(dataDir, { recursive: true });
    }
  },
});
