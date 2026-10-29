// #695: B renames Untitled.md away; A applies it, then creates a new note that reuses
// the free name (Obsidian names every new note "Untitled" while that name is free). The
// new note stays where it is: it is never carried into the renamed note as a conflict copy.
// Obsidian reports it as a vault `create`, which is no evidence either way: the content
// decides, so an empty one or one with its own text both stay.
import { assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";
import { isConflictPath } from "../../../plugin/sync/conflicts.ts";

const UNTITLED = "Untitled.md";
const RENAMED = "Ggf fhj.md";

function text(dev: { fakeVault: { files: Map<string, Uint8Array> } }, path: string): string | null {
  const body = dev.fakeVault.files.get(path);
  return body ? new TextDecoder().decode(body) : null;
}

function conflictFiles(dev: { fakeVault: { files: Map<string, Uint8Array> } }): string[] {
  return [...dev.fakeVault.files.keys()].filter(isConflictPath);
}

for (const [label, body] of [["an empty", ""], ["an unrelated", "groceries\nmilk\n"]]) {
  Deno.test({
    name: `new note - ${label} new note at a name the peer renamed away stays a new note`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const { A, B, stop } = await pair();
      try {
        B.fakeVault.write(UNTITLED, "phone note\n");
        await B.flushPending();
        await A.waitForVersion(UNTITLED);

        B.fakeVault.rename(UNTITLED, RENAMED);
        await B.flushPending();
        await A.waitForDeleted(UNTITLED);
        await A.waitForVersion(RENAMED);

        A.fakeVault.write(UNTITLED, body);
        await A.flushPending();
        await A.reconcileNow();
        await A.waitForIdle();

        assertEquals(conflictFiles(A), [], "no conflict copy on A");
        assertEquals(text(A, UNTITLED), body, "the new note stays under its own name");
        assertEquals(text(A, RENAMED), "phone note\n", "the renamed note is untouched");
        await B.waitForVersion(UNTITLED);
        assertEquals(text(B, UNTITLED), body);
        assertEquals(conflictFiles(B), []);
      } finally {
        await stop();
      }
    },
  });
}

Deno.test({
  name: "new note - a file the scan alone finds with unrelated text stays a new note",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      B.fakeVault.write(UNTITLED, "phone note\n");
      await B.flushPending();
      await A.waitForVersion(UNTITLED);

      B.fakeVault.rename(UNTITLED, RENAMED);
      await B.flushPending();
      await A.waitForDeleted(UNTITLED);
      await A.waitForVersion(RENAMED);

      // Written straight to disk: no vault event ever reports this file, so it carries no
      // create flag and only its content can say what it is. The reconciler's own "create"
      // op comes from the closed name, not from an observation.
      const body = "groceries\nmilk\n";
      A.fakeVault.files.set(UNTITLED, new TextEncoder().encode(body));
      A.fakeVault.mtimes.set(UNTITLED, Date.now() + 1_000);
      await A.reconcileNow();
      await A.waitForIdle();

      assertEquals(conflictFiles(A), [], "no conflict copy on A");
      assertEquals(text(A, UNTITLED), body, "the unrelated file stays under its own name");
      assertEquals(text(A, RENAMED), "phone note\n", "the renamed note is untouched");
      await B.waitForVersion(UNTITLED);
      assertEquals(text(B, UNTITLED), body);
      assertEquals(conflictFiles(B), []);
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "new note - an attachment at a name the peer renamed away stays a new file",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      // Byte-identical, so any content measure would carry it, but it is not text.
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7]);
      B.fakeVault.writeBinary("diagram.png", png);
      await B.flushPending();
      await A.waitForVersion("diagram.png");

      B.fakeVault.rename("diagram.png", "renamed.png");
      await B.flushPending();
      await A.waitForDeleted("diagram.png");
      await A.waitForVersion("renamed.png");

      A.fakeVault.files.set("diagram.png", new Uint8Array(png));
      A.fakeVault.mtimes.set("diagram.png", Date.now() + 1_000);
      await A.reconcileNow();
      await A.waitForIdle();

      assertEquals(conflictFiles(A), [], "no conflict copy on A");
      assertEquals(A.fakeVault.files.get("diagram.png"), png, "the new attachment stays");
      assertEquals(A.fakeVault.files.get("renamed.png"), png, "the renamed one is untouched");
      await B.waitForVersion("diagram.png");
      assertEquals(B.fakeVault.files.get("diagram.png"), png);
    } finally {
      await stop();
    }
  },
});
