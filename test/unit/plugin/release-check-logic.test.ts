import { assertEquals } from "@std/assert";
import {
  GEODE_COMMUNITY_PLUGIN_URL,
  pluginVersionRow,
  selectWhatsNewContent,
  shouldNotifyForRelease,
  whatsNewStartupAction,
} from "../../../plugin/ui/release-check-logic.ts";

// #93: pure logic for notify-once, What's new tab-once, beta rules, and Plugin version row text.

Deno.test("release-check - shouldNotifyForRelease notifies once per newer version", () => {
  assertEquals(shouldNotifyForRelease("1.0.2", null, ""), false);
  assertEquals(shouldNotifyForRelease("1.0.2", "1.0.2", ""), false);
  assertEquals(shouldNotifyForRelease("1.0.2", "1.0.1", ""), false);
  assertEquals(shouldNotifyForRelease("1.0.2", "1.0.3", ""), true);
  assertEquals(shouldNotifyForRelease("1.0.2", "1.0.3", "1.0.3"), false);
  assertEquals(shouldNotifyForRelease("1.0.2", "1.0.4", "1.0.3"), true);
  // Beta semver precedence: 1.0.2-beta.1 < 1.0.2, 1.0.2-beta.1 > 1.0.1.
  assertEquals(shouldNotifyForRelease("1.0.2-beta.1", "1.0.2", ""), true);
  assertEquals(shouldNotifyForRelease("1.0.2-beta.1", "1.0.1", ""), false);
});

Deno.test("release-check - pluginVersionRow per check state", () => {
  assertEquals(
    pluginVersionRow({ own: "1.0.2", checkEnabled: false, checked: true, available: "1.0.3" }),
    { desc: "1.0.2", showUpdate: false },
  );
  assertEquals(
    pluginVersionRow({ own: "1.0.2", checkEnabled: true, checked: false, available: null }),
    { desc: "1.0.2", showUpdate: false },
  );
  assertEquals(
    pluginVersionRow({ own: "1.0.2", checkEnabled: true, checked: true, available: "1.0.2" }),
    { desc: "1.0.2. Up to date.", showUpdate: false },
  );
  assertEquals(
    pluginVersionRow({ own: "1.0.2", checkEnabled: true, checked: true, available: "1.0.3" }),
    { desc: "1.0.2. 1.0.3 is available.", showUpdate: true },
  );
  assertEquals(
    pluginVersionRow({
      own: "1.0.2-beta.1",
      checkEnabled: true,
      checked: true,
      available: "1.0.1",
    }),
    { desc: "1.0.2-beta.1. Up to date.", showUpdate: false },
  );
  assertEquals(
    pluginVersionRow({
      own: "1.0.2-beta.1",
      checkEnabled: true,
      checked: true,
      available: "1.0.2",
    }),
    { desc: "1.0.2-beta.1. 1.0.2 is available.", showUpdate: true },
  );
});

Deno.test("release-check - whatsNewStartupAction: once on final upgrade, never on fresh install, downgrade, or beta", () => {
  // Fresh install: record silently, never open.
  assertEquals(whatsNewStartupAction("1.0.2", ""), { kind: "record", version: "1.0.2" });
  assertEquals(whatsNewStartupAction("1.0.2-beta.1", ""), {
    kind: "record",
    version: "1.0.2-beta.1",
  });
  // Already seen final: do nothing.
  assertEquals(whatsNewStartupAction("1.0.2", "1.0.2"), { kind: "none" });
  // Upgraded to a new final (including beta-to-final): open once and record.
  assertEquals(whatsNewStartupAction("1.0.2", "1.0.1"), { kind: "open", version: "1.0.2" });
  assertEquals(whatsNewStartupAction("1.0.2", "1.0.2-beta.1"), { kind: "open", version: "1.0.2" });
  // Downgrade to an older final: never open and never overwrite lastSeenVersion.
  assertEquals(whatsNewStartupAction("1.0.2", "1.0.3"), { kind: "none" });
  assertEquals(whatsNewStartupAction("1.0.2", "1.0.3-beta.1"), { kind: "none" });
  // Running a beta after an earlier version: never open.
  assertEquals(whatsNewStartupAction("1.0.2-beta.2", "1.0.1"), { kind: "none" });
  assertEquals(whatsNewStartupAction("1.0.2-beta.2", "1.0.2-beta.1"), { kind: "none" });
});

Deno.test("release-check - selectWhatsNewContent handles final, beta, missing, and empty bundles", () => {
  const notes = [
    { version: "1.0.2", body: "## Highlights\n- Added What's new." },
    { version: "1.0.1", body: "## Fixes\n- Sync fix." },
  ];
  assertEquals(selectWhatsNewContent("1.0.2", notes), {
    kind: "release",
    version: "1.0.2",
    body: notes[0].body,
  });
  assertEquals(selectWhatsNewContent("1.0.1", notes), {
    kind: "release",
    version: "1.0.1",
    body: notes[1].body,
  });
  assertEquals(selectWhatsNewContent("1.0.3-beta.1", notes), {
    kind: "beta",
    installedVersion: "1.0.3-beta.1",
    version: "1.0.2",
    body: notes[0].body,
  });
  // Final not yet in bundle falls back to newest bundled final.
  assertEquals(selectWhatsNewContent("1.0.3", notes), {
    kind: "release",
    version: "1.0.2",
    body: notes[0].body,
  });
  // No bundled notes at all.
  assertEquals(selectWhatsNewContent("1.0.2", []), { kind: "empty" });
  assertEquals(GEODE_COMMUNITY_PLUGIN_URL, "obsidian://show-plugin?id=geode");
});
