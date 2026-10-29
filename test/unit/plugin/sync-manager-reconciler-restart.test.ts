import { SyncManager } from "../../../plugin/sync/sync-manager.ts";
import { openStateDB } from "../../../plugin/plumbing/state.ts";
import { FakeVault } from "../../two-vault-driver.ts";
import { DEFAULT_SETTINGS } from "../../../plugin/plumbing/settings-types.ts";
import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";

/**
 * #622: every go-live calls SyncManager.startReconciler(), which replaced
 * `this.reconciler` without stopping the previous one: each reconnect leaked a
 * reconciler still scanning the whole vault every 5 minutes.
 *
 * A pass is observable: every pass enumerates the vault root through
 * adapter.list(""). Each go-live scans once immediately (intended); after that,
 * one interval must drive exactly one scan however many reconnects happened.
 */
Deno.test("sync-manager - N go-lives leave exactly one running reconciler", async () => {
  const time = new FakeTime(Date.now());
  try {
    const vault = new FakeVault();
    vault.write("a.md", "hello");
    const state = openStateDB();
    const transport = { getState: () => "live", addEventListener: () => {}, stop: () => {} } as any;
    const sm = new SyncManager(transport, {
      vault: vault as any,
      settings: { ...DEFAULT_SETTINGS },
      configDir: ".obsidian",
      reconnect: () => Promise.resolve(),
    });
    // Keys null: flushReplayBuffer() is a no-op, so a go-live is pure reconciler start.
    sm.setState(state, null as any);

    let passes = 0;
    const list = vault.list.bind(vault);
    vault.list = (path: string) => {
      if (path === "") passes++;
      return list(path);
    };

    for (let i = 0; i < 3; i++) await sm.startReconciler();
    await time.tickAsync(1000);
    assertEquals(passes, 3, "each go-live still scans once immediately");

    passes = 0;
    await time.tickAsync(5 * 60 * 1000);
    assertEquals(passes, 1, "one interval drives one scan, however many reconnects happened");

    passes = 0;
    sm.stop();
    await time.tickAsync(5 * 60 * 1000);
    assertEquals(passes, 0, "a stopped reconciler scans no more");

    state.close();
  } finally {
    time.restore();
  }
});

/**
 * #622: a pass stopped mid-scan (a go-live replaced it) must not enqueue its
 * batch afterwards: the flush that came with the new connection already changed
 * what that snapshot describes.
 */
Deno.test("sync-manager - a pass stopped mid-scan enqueues no ops", async () => {
  const time = new FakeTime(Date.now());
  try {
    const vault = new FakeVault();
    vault.write("a.md", "hello");
    const state = openStateDB();
    const transport = { getState: () => "live", addEventListener: () => {}, stop: () => {} } as any;
    const mkManager = () => {
      const sm = new SyncManager(transport, {
        vault: vault as any,
        settings: { ...DEFAULT_SETTINGS },
        configDir: ".obsidian",
        reconnect: () => Promise.resolve(),
      });
      sm.setState(state, null as any);
      // An emitted batch reaches the commit queue as a "pending" status with its count.
      const enqueued: number[] = [];
      sm.setOnStatusUpdate((status, data) => {
        if (status === "pending" && Number(data) > 0) enqueued.push(Number(data));
      });
      return { sm, enqueued };
    };
    const settle = async () => {
      for (let i = 0; i < 20; i++) await time.tickAsync(1);
    };

    // Hold the pass at its first disk read, so it can be stopped mid-scan.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const list = vault.list.bind(vault);
    vault.list = async (path: string) => {
      if (path === "") await gate;
      return list(path);
    };

    const stopped = mkManager();
    await stopped.sm.startReconciler();
    await time.tickAsync(1);
    stopped.sm.pause(); // stop the scanner before its pass emits anything
    release();
    await settle();
    assertEquals(stopped.enqueued, [], "a stopped pass must enqueue nothing");

    // Control: the same pass, left running, does enqueue the create it found.
    const running = mkManager();
    await running.sm.startReconciler();
    await settle();
    assertEquals(running.enqueued, [1], "a running pass still enqueues its create");

    running.sm.pause();
    state.close();
  } finally {
    time.restore();
  }
});
