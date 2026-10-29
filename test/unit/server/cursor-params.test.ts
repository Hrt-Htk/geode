// #680 L-10 - a cursor query param that is not an integer must be a 400, not a
// silently empty answer: parseInt returns NaN, every comparison against it is
// false, and the client reads "no heads" / "no history" as real data.
import { type Database, insertVersion, openDb } from "../../../server/db.ts";
import { vaultRoutes } from "../../../server/routes.ts";
import { assertEquals } from "@std/assert";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

const TOKEN = "test-token";
const PATH_HASH = "a".repeat(64);

function setup(): { db: Database; dataDir: string; call: (url: string) => Promise<Response> } {
  const dataDir = makeTempDataDir();
  const db = openDb(dataDir);
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    "test-vault",
    "test",
    new Uint8Array(16),
    Date.now(),
  );
  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    "dev1",
    "test-vault",
    "test-device",
    TOKEN,
  );
  insertVersion(db, "test-vault", PATH_HASH, 0, new Uint8Array([1]), [], false, "dev1");
  const handler = vaultRoutes(db, null, dataDir);
  return {
    db,
    dataDir,
    call: (url) => handler(new Request(url, { headers: { Authorization: `Bearer ${TOKEN}` } })),
  };
}

Deno.test({
  name: "cursor params - a non-integer after_seq is 400, not an empty heads list",
  async fn() {
    const { db, dataDir, call } = setup();
    try {
      for (const bad of ["abc", "1.5", "", "12abc"]) {
        const res = await call(`http://localhost/vaults/test-vault/heads?after_seq=${bad}`);
        assertEquals(res.status, 400, `after_seq=${bad}`);
        await res.body?.cancel();
      }
      const ok = await call("http://localhost/vaults/test-vault/heads?after_seq=0");
      assertEquals(ok.status, 200);
      await ok.body?.cancel();
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "cursor params - a negative before means no lower bound, as it did before intParam",
  async fn() {
    const { db, dataDir, call } = setup();
    try {
      insertVersion(db, "test-vault", PATH_HASH, 1, new Uint8Array([2]), [], false, "dev1");
      const rows = async (qs: string): Promise<number[]> => {
        const res = await call(`http://localhost/vaults/test-vault/versions/${PATH_HASH}${qs}`);
        assertEquals(res.status, 200, qs);
        return (await res.json() as Array<{ version: number }>).map((r) => r.version);
      };
      assertEquals(await rows(""), [2, 1], "no cursor: the whole chain");
      assertEquals(await rows("?before=-5"), [2, 1], "a negative before is the absent one");
      assertEquals(await rows("?before=2"), [2], "a real before drops the older rows");
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});

Deno.test({
  name: "cursor params - a non-integer up_to is 400, not an empty version chain",
  async fn() {
    const { db, dataDir, call } = setup();
    try {
      for (const bad of ["abc", "2.5", ""]) {
        const res = await call(
          `http://localhost/vaults/test-vault/versions/${PATH_HASH}?up_to=${bad}`,
        );
        assertEquals(res.status, 400, `up_to=${bad}`);
      }
      const ok = await call(`http://localhost/vaults/test-vault/versions/${PATH_HASH}?up_to=1`);
      assertEquals(ok.status, 200);
      assertEquals((await ok.json() as unknown[]).length, 1);
    } finally {
      db.close();
      removeTempDir(dataDir);
    }
  },
});
