import { pair, waitFor } from "../../two-vault-driver.ts";
import { assertEquals } from "@std/assert";

const decoder = new TextDecoder();

Deno.test("pause/resume: nothing crosses while paused, both sides converge on resume", async () => {
  const { A, B, stop } = await pair();
  try {
    // Shared baseline on both devices before pausing.
    A.fakeVault.write("note-a.md", "a: v1");
    B.fakeVault.write("note-b.md", "b: v1");
    await A.flushPending();
    await B.flushPending();
    await A.waitForConvergence(B, "note-a.md");
    await A.waitForConvergence(B, "note-b.md");

    // A pauses: transport closed, queue gated.
    A.pause();
    assertEquals(A.transport.isLive(), false);

    // Both edit while A is paused.
    A.fakeVault.write("note-a.md", "a: v2");
    B.fakeVault.write("note-b.md", "b: v2");
    A.eventHandler.flushNow();
    await B.flushPending();
    await waitFor(
      () => A.syncManager.getPendingOps().length > 0,
      "A's edit held in the paused queue",
    );

    // Nothing crosses while paused: A keeps its edit locally and never sees B's.
    assertEquals(decoder.decode(A.fakeVault.files.get("note-b.md")!), "b: v1");
    assertEquals(decoder.decode(B.fakeVault.files.get("note-a.md")!), "a: v1");
    assertEquals(A.transport.isLive(), false);

    // A resumes: queued edit uploads, replay brings B's edit, both converge.
    await A.resume();
    await A.waitForConvergence(B, "note-a.md");
    await A.waitForConvergence(B, "note-b.md");
    assertEquals(decoder.decode(A.fakeVault.files.get("note-b.md")!), "b: v2");
    assertEquals(decoder.decode(B.fakeVault.files.get("note-a.md")!), "a: v2");
  } finally {
    await stop();
  }
});
