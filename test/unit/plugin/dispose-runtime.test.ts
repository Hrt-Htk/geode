import { assertEquals } from "@std/assert";
import { disposeRuntime } from "../../../plugin/plumbing/vault-lock.ts";

// #464: the keys-changed hook closes surfaces that decrypted under the old
// keys. A close that throws must not abort the rest of the teardown.

type Host = Parameters<typeof disposeRuntime>[0];

function makeHost(onKeysChanged: () => void): { host: Host; states: string[] } {
  const states: string[] = [];
  const host = {
    keys: null as unknown,
    blockedNoticeShown: true,
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

Deno.test("disposeRuntime: a throwing keys-changed hook cannot abort the teardown", () => {
  const { host, states } = makeHost(() => {
    throw new Error("closing the history modal blew up");
  });

  disposeRuntime(host, { clearKeys: true, updateStatus: true });

  assertEquals(host.keys, null);
  assertEquals(host.blockedNoticeShown, false);
  assertEquals(states, ["disconnected"], "the status bar still gets its teardown");
});
