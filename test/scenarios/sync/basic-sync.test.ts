import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

Deno.test({
  name: "basic-sync - A creates a file → B receives it",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // A creates a file
      const content = "Hello from vault A!";
      A.fakeVault.write("test.md", content);
      await A.flushPending();

      // B should receive it
      await B.waitForVersion("test.md");

      const bContent = new TextDecoder().decode(await B.fakeVault.readBinary("test.md"));
      assertEquals(bContent, content);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "basic-sync - A modifies a file → B sees the modification",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Create initial file from A
      A.fakeVault.write("notes.md", "original content");
      await A.flushPending();
      await B.waitForVersion("notes.md");

      // A modifies the file
      const newContent = "modified by A";
      A.fakeVault.write("notes.md", newContent);
      await A.flushPending();

      // B should receive the modification (version 2)
      await B.waitForVersion("notes.md", 2);

      const bContent = new TextDecoder().decode(await B.fakeVault.readBinary("notes.md"));
      assertEquals(bContent, newContent);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "basic-sync - A deletes a file → B's copy is deleted",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Create initial file from A
      A.fakeVault.write("todo.md", "buy milk");
      await A.flushPending();
      await B.waitForVersion("todo.md");
      assertEquals(B.fakeVault.fileExists("todo.md"), true);

      // A deletes the file
      A.fakeVault.delete("todo.md");
      await A.flushPending();

      // B should receive the deletion
      await B.waitForDeleted("todo.md");
      assertEquals(B.fakeVault.fileExists("todo.md"), false);
    } finally {
      await stop();
    }
  },
});
