import { assertEquals, assertRejects } from "@std/assert";
import { setHttpImpl } from "../../../plugin/plumbing/provisioning-client.ts";
import {
  fetchAvailableReleaseVersion,
  GEODE_LATEST_RELEASE_URL,
  GEODE_VERSIONS_URL,
  getLatestCompatibleVersion,
  isFinalVersion,
} from "../../../plugin/plumbing/release-client.ts";

// #93: startup release check reads GitHub releases/latest and raw versions.json on main
// via the platform HTTP layer (never a release asset).

Deno.test("release-client - isFinalVersion distinguishes finals from betas and invalid strings", () => {
  assertEquals(isFinalVersion("1.0.2"), true);
  assertEquals(isFinalVersion("0.0.1"), true);
  assertEquals(isFinalVersion("1.0.2-beta.1"), false);
  assertEquals(isFinalVersion("v1.0.2"), false);
  assertEquals(isFinalVersion(""), false);
});

Deno.test("release-client - getLatestCompatibleVersion honors minAppVersion via versions.json", () => {
  const versions = { "1.0.1": "1.8.7", "1.0.2": "1.8.7", "2.0.0": "2.5.0" };
  assertEquals(
    getLatestCompatibleVersion("2.0.0", versions, (min) => min === "1.8.7"),
    "1.0.2",
  );
  assertEquals(
    getLatestCompatibleVersion("2.0.0", versions, () => true),
    "2.0.0",
  );
  assertEquals(
    getLatestCompatibleVersion("2.0.0", versions, () => false),
    null,
  );
  // Version not listed in versions.json: assume compatible rather than dropping it.
  assertEquals(
    getLatestCompatibleVersion("1.0.3", versions, (min) => min === "1.8.7"),
    "1.0.3",
  );
});

Deno.test("release-client - skips versions.json when already up to date", async () => {
  const seen: string[] = [];
  setHttpImpl((req) => {
    seen.push(req.url);
    return Promise.resolve({ status: 200, text: JSON.stringify({ tag_name: "1.0.2" }) });
  });
  const version = await fetchAvailableReleaseVersion({
    currentVersion: "1.0.2",
    canRunMinAppVersion: () => true,
  });
  assertEquals(version, "1.0.2");
  assertEquals(seen, [GEODE_LATEST_RELEASE_URL]);
});

Deno.test("release-client - checks raw versions.json when a newer release exists", async () => {
  const seen: string[] = [];
  setHttpImpl((req) => {
    seen.push(req.url);
    if (req.url === GEODE_LATEST_RELEASE_URL) {
      return Promise.resolve({ status: 200, text: JSON.stringify({ tag_name: "2.0.0" }) });
    }
    return Promise.resolve({
      status: 200,
      text: JSON.stringify({ "1.0.2": "1.8.7", "1.0.3": "1.8.7", "2.0.0": "2.5.0" }),
    });
  });
  const version = await fetchAvailableReleaseVersion({
    currentVersion: "1.0.2",
    canRunMinAppVersion: (min) => min === "1.8.7",
  });
  assertEquals(version, "1.0.3");
  assertEquals(seen, [GEODE_LATEST_RELEASE_URL, GEODE_VERSIONS_URL]);
});

Deno.test("release-client - rejects on HTTP failure so caller fails silently", async () => {
  setHttpImpl(() => Promise.resolve({ status: 403, text: "rate limited" }));
  await assertRejects(() =>
    fetchAvailableReleaseVersion({
      currentVersion: "1.0.2",
      canRunMinAppVersion: () => true,
    })
  );
});

Deno.test("release-client - rejects on malformed or non-final latest tag so caller stays unchecked", async () => {
  for (
    const body of [
      JSON.stringify({ tag_name: "1.0.3-beta.1" }),
      JSON.stringify({ tag_name: "v1.0.3" }),
      JSON.stringify({ tag_name: "" }),
      JSON.stringify({}),
      "null",
    ]
  ) {
    setHttpImpl(() => Promise.resolve({ status: 200, text: body }));
    await assertRejects(
      () =>
        fetchAvailableReleaseVersion({
          currentVersion: "1.0.2",
          canRunMinAppVersion: () => true,
        }),
      Error,
      undefined,
      `expected reject for ${body}`,
    );
  }
});
