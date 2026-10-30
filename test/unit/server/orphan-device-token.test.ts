// #680 - deleting a vault row leaves its device rows behind when foreign_keys is off
// (a manual `sqlite3` delete does), and those tokens stayed live: every blob route
// keys storage off the token's own vault_id, so an orphan token could still write
// chunks into a vault directory nothing counts or budgets. Validation joins the vault.
import { validateToken } from "../../../server/auth.ts";
import { blobRoutes } from "../../../server/blob-routes.ts";
import { openDb } from "../../../server/db.ts";
import { assert, assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

const HASH = "a".repeat(64);

Deno.test({
  name: "orphan device token - rejected once its vault row is gone",
  async fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      db.run(
        "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
        "gone-vault",
        "test",
        new Uint8Array(16),
        Date.now(),
      );
      db.run(
        "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
        "dev1",
        "gone-vault",
        "test-device",
        "orphan-token",
      );
      // A manual delete, not the server's: the FK cascade never runs.
      db.exec("PRAGMA foreign_keys=OFF");
      db.run("DELETE FROM vaults WHERE id = ?", "gone-vault");
      assertEquals(
        (db.prepare("SELECT COUNT(*) AS n FROM devices").get() as { n: number }).n,
        1,
        "the device row survives, as it does in production",
      );

      assertEquals(validateToken(db, "orphan-token"), null);

      const res = await blobRoutes(dataDir, db)(
        new Request(`http://localhost/blobs/${HASH}`, {
          method: "POST",
          body: new Uint8Array([1, 2, 3]),
          headers: { authorization: "Bearer orphan-token" },
        }),
      );
      assertEquals(res.status, 401);
      let tree = true;
      try {
        tree = Deno.statSync(`${dataDir}/blobs/gone-vault`).isDirectory;
      } catch {
        tree = false;
      }
      assert(!tree, "an orphan token must not create a blob tree");
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "orphan device token - a lookup stops working the moment its vault is gone",
  fn() {
    const dataDir = makeTempDataDir();
    const db = openDb(dataDir);
    try {
      db.run(
        "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
        "gone-vault",
        "test",
        new Uint8Array(16),
        Date.now(),
      );
      db.run(
        "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
        "dev1",
        "gone-vault",
        "test-device",
        "orphan-token",
      );
      // Delete the vault the way an operator does: the next lookup must fail. The rows outlive
      // the vault because that manual delete runs with foreign_keys off.
      assert(validateToken(db, "orphan-token") !== null);
      db.exec("PRAGMA foreign_keys=OFF");
      db.run("DELETE FROM vaults WHERE id = ?", "gone-vault");
      assertEquals(
        validateToken(db, "orphan-token"),
        null,
        "a token must not outlive its vault",
      );
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});
