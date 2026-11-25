import { assertEquals } from "@std/assert";
import {
  disposeRuntime,
  resumeAfterServerUpdate,
  type ServerUpdateResumeHost,
} from "../../../plugin/plumbing/vault-lock.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";

// #464: the keys-changed hook closes surfaces that decrypted under the old
// keys. A close that throws must not abort the rest of the teardown.

type Host = Parameters<typeof disposeRuntime>[0];

function makeHost(onKeysChanged: () => void): { host: Host; states: string[] } {
  const states: string[] = [];
  const host = {
    keys: null as unknown,
    blockedNoticeShown: true,
    versionStatus: { kind: "blocked", side: "server" },
    isUnlocked: true,
    onKeysChanged,
    statusBar: {
      updateState: (state: string) => states.push(state),
      updatePending: () => {},
      updateDirty: () => {},
      setVersionStatus: () => {},
    },
  } as unknown as Host;
  return { host, states };
}

function makeResumeHost(overrides: Partial<ServerUpdateResumeHost> = {}) {
  let restarts = 0;
  let bannerUpdates = 0;
  const barStatuses: unknown[] = [];
  const host = {
    pluginSettings: { ...structuredClone(DEFAULT_SETTINGS) },
    isUnlocked: true,
    versionStatus: { kind: "blocked", side: "server" },
    serverVersion: "0.9.0",
    blockedNoticeShown: true,
    rekeyInProgress: false,
    rekeyCursor: null,
    transport: { isBlocked: () => true },
    statusBar: { setVersionStatus: (s: unknown) => barStatuses.push(s) },
    settingTab: {
      applyLockState: () => {},
      refresh: () => {},
      updateVersionBanner: () => {
        bannerUpdates++;
      },
    },
    restartUnlockedSession: () => {
      restarts++;
      return Promise.resolve();
    },
    ...overrides,
  } as unknown as ServerUpdateResumeHost;
  return { host, restarts: () => restarts, bannerUpdates: () => bannerUpdates, barStatuses };
}

Deno.test("disposeRuntime: a throwing keys-changed hook cannot abort the teardown", () => {
  const { host, states } = makeHost(() => {
    throw new Error("closing the history modal blew up");
  });

  disposeRuntime(host, { clearKeys: true, updateStatus: true });

  assertEquals(host.keys, null);
  assertEquals(host.blockedNoticeShown, false);
  assertEquals(host.versionStatus, { kind: "ok" });
  assertEquals(states, ["disconnected"], "the status bar still gets its teardown");
});

Deno.test("resumeAfterServerUpdate: blocked(server) + updated resumes sync", () => {
  const ctx = makeResumeHost();
  assertEquals(resumeAfterServerUpdate(ctx.host, "updated", "1.0.2", false), true);
  assertEquals(ctx.host.versionStatus, { kind: "ok" });
  assertEquals(ctx.host.blockedNoticeShown, false);
  assertEquals(ctx.barStatuses, [{ kind: "ok" }]);
  assertEquals(ctx.bannerUpdates(), 1);
  assertEquals(ctx.restarts(), 1);
});

Deno.test("resumeAfterServerUpdate: blocked(server) + up-to-date resumes only when server moved ahead", () => {
  const newer = makeResumeHost({ serverVersion: "0.9.0" });
  assertEquals(resumeAfterServerUpdate(newer.host, "up-to-date", "1.0.2", false), true);
  assertEquals(newer.restarts(), 1);

  const same = makeResumeHost({ serverVersion: "0.9.0" });
  assertEquals(resumeAfterServerUpdate(same.host, "up-to-date", "0.9.0", false), false);
  assertEquals(same.restarts(), 0);
});

Deno.test("resumeAfterServerUpdate: does not restart for plugin side, locked, unblocked transport, or busy", () => {
  const pluginSide = makeResumeHost({ versionStatus: { kind: "blocked", side: "plugin" } });
  assertEquals(resumeAfterServerUpdate(pluginSide.host, "updated", "1.0.2", false), false);
  assertEquals(pluginSide.restarts(), 0);

  const locked = makeResumeHost({ isUnlocked: false });
  assertEquals(resumeAfterServerUpdate(locked.host, "updated", "1.0.2", false), false);
  assertEquals(locked.restarts(), 0);

  const notBlocked = makeResumeHost({
    transport: { isBlocked: () => false } as unknown as ServerUpdateResumeHost["transport"],
  });
  assertEquals(resumeAfterServerUpdate(notBlocked.host, "updated", "1.0.2", false), false);
  assertEquals(notBlocked.restarts(), 0);

  const noTransport = makeResumeHost({ transport: null });
  assertEquals(resumeAfterServerUpdate(noTransport.host, "updated", "1.0.2", false), false);
  assertEquals(noTransport.restarts(), 0);

  const resyncing = makeResumeHost();
  assertEquals(resumeAfterServerUpdate(resyncing.host, "updated", "1.0.2", true), false);
  assertEquals(resyncing.restarts(), 0);

  const rekeying = makeResumeHost({ rekeyInProgress: true });
  assertEquals(resumeAfterServerUpdate(rekeying.host, "updated", "1.0.2", false), false);
  assertEquals(rekeying.restarts(), 0);

  const rekeyPaused = makeResumeHost({
    rekeyCursor: {
      vaultId: "v",
    } as unknown as ServerUpdateResumeHost["rekeyCursor"],
  });
  assertEquals(resumeAfterServerUpdate(rekeyPaused.host, "updated", "1.0.2", false), false);
  assertEquals(rekeyPaused.restarts(), 0);

  const resyncStopped = makeResumeHost({
    pluginSettings: { ...structuredClone(DEFAULT_SETTINGS), resyncStop: "stopped" },
  });
  assertEquals(resumeAfterServerUpdate(resyncStopped.host, "updated", "1.0.2", false), false);
  assertEquals(resyncStopped.restarts(), 0);
});
