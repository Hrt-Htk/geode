// Unit tests for the after-merge release rule (#409): `nextVersion` maps the
// Conventional Commit subjects of the commits since the last tag (that touch
// shipped code) to the next version, or null for "no release".

import { assertEquals } from "@std/assert";
import { nextVersion, releaseHold, staleBoardItems } from "../../../scripts/after-merge.ts";

const v = "0.24.2";

Deno.test("nextVersion: feat bumps MINOR", () => {
  assertEquals(nextVersion(v, ["feat: add chunk cache"]), "0.25.0");
});

Deno.test("nextVersion: fix bumps PATCH", () => {
  assertEquals(nextVersion(v, ["fix: reconnect on socket drop"]), "0.24.3");
});

Deno.test("nextVersion: perf bumps PATCH", () => {
  assertEquals(nextVersion(v, ["perf: hash in bulk"]), "0.24.3");
});

Deno.test("nextVersion: only refactor/docs/test/chore -> no release", () => {
  assertEquals(
    nextVersion(v, [
      "refactor(sync): split transport",
      "docs: step gates",
      "test: cover replay",
      "chore(ci): pin runner",
    ]),
    null,
  );
});

Deno.test("nextVersion: scoped fix(ci) that reached here bumps PATCH (the path filter, not the scope, decides relevance)", () => {
  assertEquals(nextVersion(v, ["fix(ci): retry flaky install"]), "0.24.3");
});

Deno.test("nextVersion: mixed feat + fix -> MINOR", () => {
  assertEquals(nextVersion(v, ["fix: reconnect", "feat: queue stats"]), "0.25.0");
});

Deno.test("nextVersion: empty subjects -> null", () => {
  assertEquals(nextVersion(v, []), null);
});

Deno.test("nextVersion: a subject merely containing 'fix' doesn't count", () => {
  assertEquals(nextVersion(v, ["remove the flaky fix guard"]), null);
});

Deno.test("nextVersion pre-1.0: breaking change (!) bumps MINOR, not MAJOR", () => {
  assertEquals(nextVersion(v, ["feat!: new wire protocol"]), "0.25.0");
  assertEquals(nextVersion(v, ["fix!: drop legacy endpoint"]), "0.25.0");
});

// #413: auto-ship closes issues with github.token, which never fires the
// board's "Item closed → Done" workflow: after-merge moves them itself.
const item = (id: string, state: string | undefined, status: string | null) => ({
  id,
  content: state ? { state } : {},
  fieldValueByName: status ? { name: status } : null,
});

// #438: a committed RELEASE_HOLD file holds the release: after-merge skips
// the release step and `deno task release` refuses.
Deno.test("releaseHold: returns the trimmed reason when RELEASE_HOLD exists", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/RELEASE_HOLD`,
    "#256 settings tab in progress: remove when the epic closes\n",
  );
  try {
    assertEquals(releaseHold(dir), "#256 settings tab in progress: remove when the epic closes");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("releaseHold: null when RELEASE_HOLD is absent", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(releaseHold(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("staleBoardItems: closed or merged but not Done", () => {
  assertEquals(
    staleBoardItems([
      item("closed-in-progress", "CLOSED", "In Progress"),
      item("merged-pr-no-status", "MERGED", null),
      item("closed-done", "CLOSED", "Done"),
      item("open-in-progress", "OPEN", "In Progress"),
      item("draft", undefined, "Todo"),
    ]),
    ["closed-in-progress", "merged-pr-no-status"],
  );
});
