import { assert, assertEquals } from "@std/assert";
import { pair } from "../../two-vault-driver.ts";

// #590: "Resync from scratch" rebuilds the local state registry. A file that
// diverged from the server while the registry was lost is a local edit: the
// rebuild must never delete it (or silently replace it): the session restart
// merges it like any other edit.

function read(files: Map<string, Uint8Array>, path: string): string {
  const data = files.get(path);
  return data ? new TextDecoder().decode(data) : "";
}

function allText(files: Map<string, Uint8Array>): string {
  const decoder = new TextDecoder();
  return [...files.values()].map((data) => decoder.decode(data)).join("\n");
}

Deno.test({
  name: "resync-keeps-divergent-local-file - a resync never deletes an edit it did not apply",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const path = "note.md";
      A.fakeVault.write(path, "server copy\n");
      await A.flushPending();
      await B.waitForVersion(path);

      // The state registry is rebuilt from scratch; the file on disk moved on.
      B.disconnect();
      B.fakeVault.write(path, "edit made while the registry was lost\n");

      await B.resyncFromScratch();
      await B.reconcileNow();
      for (let round = 0; round < 10; round++) {
        await A.pushNow();
        await B.pushNow();
        if (
          allText(A.fakeVault.files).includes("registry was lost") &&
          allText(B.fakeVault.files).includes("registry was lost")
        ) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      for (const [label, plugin] of [["A", A], ["B", B]] as const) {
        const text = allText(plugin.fakeVault.files);
        assert(text.includes("server copy"), `${label} lost the server copy`);
        assert(text.includes("registry was lost"), `${label} lost the rebuild-time edit`);
      }
      assertEquals(read(B.fakeVault.files, path), "server copy\n");
    } finally {
      await stop();
    }
  },
});

Deno.test({
  name: "resync-keeps-divergent-local-file - non-markdown edits survive too (.canvas, binary)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const { A, B, stop } = await pair();
    try {
      const canvas = "board.canvas";
      const image = "photo.png";
      const serverCanvas = JSON.stringify({ nodes: ["server"] });
      A.fakeVault.write(canvas, serverCanvas);
      A.fakeVault.write(image, "SERVER-PNG-BYTES");
      await A.flushPending();
      await B.waitForVersion(canvas);
      await B.waitForVersion(image);

      // The registry is rebuilt from scratch while both files moved on locally.
      B.disconnect();
      B.fakeVault.write(canvas, JSON.stringify({ nodes: ["local-edit"] }));
      B.fakeVault.write(image, "LOCAL-PNG-BYTES");

      await B.resyncFromScratch();
      await B.reconcileNow();
      const tokens = ["local-edit", "LOCAL-PNG-BYTES", "server", "SERVER-PNG-BYTES"];
      for (let round = 0; round < 20; round++) {
        await A.pushNow();
        await B.pushNow();
        const settled = [A, B].every((plugin) =>
          tokens.every((token) => allText(plugin.fakeVault.files).includes(token))
        );
        if (settled) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      for (const [label, plugin] of [["A", A], ["B", B]] as const) {
        const text = allText(plugin.fakeVault.files);
        assert(text.includes("local-edit"), `${label} lost the rebuild-time .canvas edit`);
        assert(text.includes("LOCAL-PNG-BYTES"), `${label} lost the rebuild-time binary edit`);
        assert(text.includes("server"), `${label} lost the server .canvas copy`);
        assert(text.includes("SERVER-PNG-BYTES"), `${label} lost the server binary copy`);
      }
      assertEquals(read(B.fakeVault.files, canvas), serverCanvas);
      assertEquals(read(B.fakeVault.files, image), "SERVER-PNG-BYTES");
    } finally {
      await stop();
    }
  },
});
