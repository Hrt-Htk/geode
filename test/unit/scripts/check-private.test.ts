// Unit tests for the private-data gate (#642): private IPv4, Tailscale hosts and
// home paths in tracked files, the exact-address allow-list, and the local
// denylist layer read from GEODE_PRIVATE_DENYLIST. Every address here is made up
// or from an RFC 5737 documentation range.

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  checkPrivate,
  formatViolation,
  readDenylist,
  scan,
} from "../../../scripts/check-private.ts";

const file = (path: string, text: string) => [{ path, text }];

Deno.test("scan: private IPv4 in every blocked block is reported", () => {
  const hits = scan(file("a.md", "10.1.2.3\n172.20.0.5\n192.168.1.10\n100.101.102.103"), []);
  assertEquals(hits.map((h) => [h.line, h.kind, h.detail]), [
    [1, "private ipv4", "10.1.2.3"],
    [2, "private ipv4", "172.20.0.5"],
    [3, "private ipv4", "192.168.1.10"],
    [4, "private ipv4", "100.101.102.103"],
  ]);
});

Deno.test("scan: documentation ranges and loopback are not private", () => {
  assertEquals(scan(file("a.md", "192.0.2.10 198.51.100.7 203.0.113.9 127.0.0.1 0.0.0.0"), []), []);
});

Deno.test("scan: a public address is not a hit", () => {
  assertEquals(scan(file("a.md", "8.8.8.8 and 172.32.0.1 and 100.128.0.1"), []), []);
});

Deno.test("scan: two hits on one line are both reported, a repeat is not", () => {
  const hits = scan(file("a.md", "10.1.2.3 then 10.1.2.3 then 192.168.0.9"), []);
  assertEquals(hits.map((h) => h.detail), ["10.1.2.3", "192.168.0.9"]);
  assertEquals(hits.map((h) => h.line), [1, 1]);
});

Deno.test("scan: tailscale hosts, including the device name", () => {
  const hits = scan(file("a.md", "ssh box.tail1234.ts.net"), []);
  assertEquals(hits.map((h) => [h.kind, h.detail]), [["tailscale host", "box.tail1234.ts.net"]]);
});

Deno.test("scan: the tailscale ipv6 ula prefix in either case", () => {
  const hits = scan(file("a.md", "http://[fd7a:115c:a1e0::1]:6767\nFD7A:115C:A1E0:ab12::2"), []);
  assertEquals(hits.map((h) => [h.line, h.kind, h.detail]), [
    [1, "tailscale ipv6", "fd7a:115c:a1e0:"],
    [2, "tailscale ipv6", "FD7A:115C:A1E0:"],
  ]);
});

Deno.test("scan: home paths on linux, macOS and both Windows separators", () => {
  const hits = scan(
    file(
      "a.md",
      "/home/alice/vaults/x.md\n/Users/alice/vaults/x.md\nC:\\Users\\alice\\vaults\\x.md\nC:/Users/alice/x.md",
    ),
    [],
  );
  assertEquals(hits.map((h) => [h.line, h.kind]), [
    [1, "home path"],
    [2, "home path"],
    [3, "home path"],
    [4, "home path"],
  ]);
});

Deno.test("scan: generic placeholder home names are allowed", () => {
  assertEquals(
    scan(
      file(
        "a.md",
        [
          "/home/you/vaults/example",
          "/home/user/x",
          "/Users/you/x",
          "/Users/user/x",
          "/Users/Shared/x",
          "C:\\Users\\User\\x",
          "C:\\Users\\you\\x",
          "C:/Users/user/x",
          "C:/Users/you/x",
        ].join("\n"),
      ),
      [],
    ),
    [],
  );
});

Deno.test("scan: an allow-listed address is exempt only in the file that needs it", () => {
  assertEquals(scan(file("README.md", "192.168.1.20"), []), []);
  assertEquals(scan(file("test/integration/provisioning-client.test.ts", "192.168.1.5"), []), []);
  assertEquals(
    scan(file("a.md", "192.168.1.20 192.168.1.5 192.168.1.21"), []).map((h) => h.detail),
    ["192.168.1.20", "192.168.1.5", "192.168.1.21"],
  );
});

Deno.test("scan: denylist reports the entry line, never the value", () => {
  const hits = scan(file("a.md", "nothing\nsecret-value here"), [
    { entry: "Secret-Value", line: 3 },
  ]);
  assertEquals(hits, [{ file: "a.md", line: 2, kind: "denylist", detail: "denylist entry #3" }]);
});

Deno.test("scan: the denylist applies to the gate's own files, the patterns do not", () => {
  const path = "scripts/check-private.ts";
  assertEquals(scan(file(path, "10.1.2.3"), []), []);
  assertEquals(
    scan(file(path, "10.1.2.3 secret-value"), [{ entry: "secret-value", line: 1 }]).length,
    1,
  );
});

Deno.test("readDenylist: blank and comment lines are skipped, line numbers keep", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denylist-" });
  const path = join(dir, "denylist.txt");
  try {
    await Deno.writeTextFile(path, "# header\nfirst\n\n  # indented comment\nsecond\n");
    assertEquals(await readDenylist(path), [
      { entry: "first", line: 2 },
      { entry: "second", line: 5 },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readDenylist: unset skips the layer, set-but-unusable is loud", async () => {
  assertEquals(await readDenylist(undefined), []);
  const dir = await Deno.makeTempDir({ prefix: "denylist-" });
  try {
    await assertRejects(
      () => readDenylist(join(dir, "absent.txt")),
      Error,
      "denylist set but unreadable or empty",
    );
    const commentsOnly = join(dir, "comments-only.txt");
    await Deno.writeTextFile(commentsOnly, "# a comment\n\n   \n");
    await assertRejects(
      () => readDenylist(commentsOnly),
      Error,
      "denylist set but unreadable or empty",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readDenylist: a leading ~ resolves against HOME", async () => {
  const dir = await Deno.makeTempDir({ prefix: "denylist-home-" });
  const home = Deno.env.get("HOME");
  try {
    await Deno.writeTextFile(join(dir, "list.txt"), "first\nsecond\n");
    Deno.env.set("HOME", dir);
    assertEquals(await readDenylist("~/list.txt"), [
      { entry: "first", line: 1 },
      { entry: "second", line: 2 },
    ]);
  } finally {
    if (home === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", home);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("formatViolation: file:line - kind - match", () => {
  assertEquals(
    formatViolation({ file: "a.md", line: 7, kind: "home path", detail: "/home/alice/" }),
    "a.md:7: home path: /home/alice/",
  );
});

Deno.test("checkPrivate: tracks text files only, skipping binaries and lock files", async () => {
  const dir = await Deno.makeTempDir({ prefix: "private-gate-" });
  try {
    const git = (args: string[]) =>
      new Deno.Command("git", { args, cwd: dir, stdout: "null", stderr: "null" }).output();
    await git(["init"]);
    await Deno.writeTextFile(join(dir, "notes.md"), "10.1.2.3\n");
    await Deno.writeTextFile(join(dir, "deno.lock"), "10.1.2.3\n");
    await Deno.writeFile(join(dir, "blob.bin"), new Uint8Array([0x31, 0x30, 0x00, 0x31]));
    await git(["add", "-A"]);
    assertEquals((await checkPrivate(dir)).map((v) => v.file), ["notes.md"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
