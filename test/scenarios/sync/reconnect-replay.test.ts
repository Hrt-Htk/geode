import { assertEquals } from "@std/assert";
import { pair, pathVersionCount, versionCount, waitFor } from "../../two-vault-driver.ts";

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

Deno.test({
  name: "reconnect-replay - B disconnects, A commits 3 times, B reconnects and receives all",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Establish baseline: both see the same initial file
      A.fakeVault.write("shared.md", "initial");
      await A.flushPending();
      await B.waitForVersion("shared.md");

      // B disconnects
      B.disconnect();

      // A makes 3 commits while B is offline
      const contents = ["edit 1", "edit 2", "edit 3"];
      for (const content of contents) {
        A.fakeVault.write("shared.md", content);
        await A.flushPending();
      }

      // B reconnects: should replay missing versions
      await B.reconnect();

      // B should converge to A's latest content
      await B.waitForVersion("shared.md", 4); // version 1 (initial) + 3 edits
      const bContent = new TextDecoder().decode(await B.fakeVault.readBinary("shared.md"));
      assertEquals(bContent, contents[contents.length - 1]);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "reconnect-replay - a server restart mid-session resumes both clients without a replay",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, server, vaultId, stop } = await pair();
    try {
      for (const [path, content] of [["shared.md", "initial"], ["second.md", "two"]]) {
        A.fakeVault.write(path, content);
      }
      await A.flushPending();
      await B.waitForVersion("shared.md");
      await B.waitForVersion("second.md");
      await waitFor(() => versionCount(server, vaultId) === 2, "two versions on the server");
      const seqBefore = A.state!.getSyncCursor();
      assertEquals(
        B.state!.getSyncCursor(),
        seqBefore,
        "both clients are caught up before the restart",
      );

      // Every file B writes from here on is an apply: a client that resumed from its stored
      // cursor applies the post-restart edit only.
      const applied: string[] = [];
      const writeBinary = B.fakeVault.writeBinary.bind(B.fakeVault);
      B.fakeVault.writeBinary = (path, data, opts) => {
        if (!path.startsWith(".obsidian/")) applied.push(path);
        writeBinary(path, data, opts);
      };

      // "Both live" right after restart() proves nothing: the transports still report live until
      // the dropped socket is processed. Wait for the reconnect each one schedules on close, then
      // for both to be live again.
      const dropped = [A, B].map((plugin) =>
        new Promise<void>((resolve) => {
          const transport = plugin.transport!;
          if (!transport.isLive()) return resolve();
          transport.addEventListener("reconnect", () => resolve(), { once: true });
        })
      );
      await server.restart();
      await Promise.all(dropped);
      await waitFor(
        () => A.transport?.isLive() === true && B.transport?.isLive() === true,
        "both clients live again after the restart",
        30_000,
      );

      assertEquals(A.state!.getSyncCursor(), seqBefore, "A resumes from its stored last_seen_seq");
      assertEquals(B.state!.getSyncCursor(), seqBefore, "B resumes from its stored last_seen_seq");
      assertEquals(applied, [], "the restart replays no already-applied version");

      A.fakeVault.write("shared.md", "after restart");
      await A.flushPending();
      await B.waitForVersion("shared.md", 2, 30_000);
      assertEquals(decode(await B.fakeVault.readBinary("shared.md")), "after restart");
      assertEquals(applied, ["shared.md"], "one edit, one apply");

      // One new version, not one per reconnect: the commit ran once.
      const pathHash = B.state!.getLocalFile("shared.md")!.path_hash;
      assertEquals(pathVersionCount(server, vaultId, pathHash), 2);
    } finally {
      await stop();
    }
  },
});
