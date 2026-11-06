import { assert, assertEquals } from "@std/assert";
import { openDb } from "../../../server/db.ts";
import { updateRoutes } from "../../../server/update-routes.ts";
import { makeTempDataDir, removeTempDir } from "../../helpers/temp-dir.ts";

// #44: the two HTTP routes behind the plugin's server update. The POST leaves the empty
// request the host job answers (server.md §11); the GET reads the job's heartbeat and its
// last `<status> <epoch>`, and answers "no job" for anything missing or unreadable.

const ADMIN = "test-admin-token";
const STATUS_ENV = "GEODE_UPDATE_STATUS_DIR";

type Harness = {
  dataDir: string;
  statusDir: string;
  token: string;
  handler: (req: Request) => Promise<Response>;
  stop: () => void;
};

function setup(): Harness {
  const dataDir = makeTempDataDir();
  const statusDir = makeTempDataDir();
  Deno.env.set(STATUS_ENV, statusDir);
  const db = openDb(dataDir);
  const vaultId = crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  const token = "tok-" + crypto.randomUUID();
  db.run(
    "INSERT INTO vaults(id, name, salt, created_at) VALUES(?,?,?,?)",
    vaultId,
    "update-vault",
    new Uint8Array(16),
    Date.now(),
  );
  db.run(
    "INSERT INTO devices(id, vault_id, name, token) VALUES(?,?,?,?)",
    deviceId,
    vaultId,
    "test-device",
    token,
  );
  return {
    dataDir,
    statusDir,
    token,
    handler: updateRoutes(db, ADMIN, dataDir),
    stop: () => {
      Deno.env.delete(STATUS_ENV);
      db.close();
      removeTempDir(dataDir);
      removeTempDir(statusDir);
    },
  };
}

function req(path: string, method: string, auth?: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: auth ? { authorization: `Bearer ${auth}` } : {},
  });
}

const epochNow = () => Math.floor(Date.now() / 1000);

Deno.test("update route - POST /update refuses a caller without the admin token", async () => {
  const h = setup();
  try {
    assertEquals((await h.handler(req("/update", "POST"))).status, 401);
    assertEquals((await h.handler(req("/update", "POST", "wrong"))).status, 401);
    const left = await Deno.stat(`${h.dataDir}/update-request`).catch(() => null);
    assertEquals(left, null, "a refused POST leaves no request");
  } finally {
    h.stop();
  }
});

Deno.test("update route - POST /update leaves an empty request and answers the epoch", async () => {
  const h = setup();
  try {
    const before = epochNow();
    const res = await h.handler(req("/update", "POST", ADMIN));
    assertEquals(res.status, 200);
    const body = (await res.json()) as { epoch: number };
    assert(body.epoch >= before, `epoch ${body.epoch} dates the request`);
    assertEquals(await Deno.readTextFile(`${h.dataDir}/update-request`), "");
  } finally {
    h.stop();
  }
});

Deno.test("update route - a second POST replaces a request the job has not taken", async () => {
  const h = setup();
  try {
    assertEquals((await h.handler(req("/update", "POST", ADMIN))).status, 200);
    assertEquals((await h.handler(req("/update", "POST", ADMIN))).status, 200);
    assertEquals(await Deno.readTextFile(`${h.dataDir}/update-request`), "");
  } finally {
    h.stop();
  }
});

Deno.test("update route - GET /update/status needs a device token", async () => {
  const h = setup();
  try {
    assertEquals((await h.handler(req("/update/status", "GET"))).status, 401);
    assertEquals((await h.handler(req("/update/status", "GET", "unknown"))).status, 401);
  } finally {
    h.stop();
  }
});

Deno.test("update route - a missing status folder means no job and no result", async () => {
  const h = setup();
  try {
    const res = await h.handler(req("/update/status", "GET", h.token));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { installed: false, result: null });
  } finally {
    h.stop();
  }
});

Deno.test("update route - a fresh heartbeat means the job is installed", async () => {
  const h = setup();
  try {
    await Deno.writeTextFile(`${h.statusDir}/heartbeat`, `${epochNow()}\n`);
    const res = await h.handler(req("/update/status", "GET", h.token));
    const body = (await res.json()) as { installed: boolean };
    assertEquals(body.installed, true);
  } finally {
    h.stop();
  }
});

Deno.test("update route - a heartbeat older than three minutes means no job", async () => {
  const h = setup();
  try {
    await Deno.writeTextFile(`${h.statusDir}/heartbeat`, `${epochNow() - 181}\n`);
    const res = await h.handler(req("/update/status", "GET", h.token));
    const body = (await res.json()) as { installed: boolean };
    assertEquals(body.installed, false);
  } finally {
    h.stop();
  }
});

Deno.test("update route - a garbage heartbeat means no job, never an error", async () => {
  const h = setup();
  try {
    await Deno.writeTextFile(`${h.statusDir}/heartbeat`, "not a number\n");
    const res = await h.handler(req("/update/status", "GET", h.token));
    assertEquals(res.status, 200);
    const body = (await res.json()) as { installed: boolean };
    assertEquals(body.installed, false);
  } finally {
    h.stop();
  }
});

Deno.test("update route - the last result word and its epoch are returned", async () => {
  const h = setup();
  try {
    await Deno.writeTextFile(`${h.statusDir}/heartbeat`, `${epochNow()}\n`);
    await Deno.writeTextFile(`${h.statusDir}/result`, "updated 1700000000\n");
    const res = await h.handler(req("/update/status", "GET", h.token));
    assertEquals(await res.json(), {
      installed: true,
      result: { word: "updated", epoch: 1700000000 },
    });
  } finally {
    h.stop();
  }
});

Deno.test("update route - a running result is returned as is", async () => {
  const h = setup();
  try {
    await Deno.writeTextFile(`${h.statusDir}/heartbeat`, `${epochNow()}\n`);
    await Deno.writeTextFile(`${h.statusDir}/result`, "running 1700000123\n");
    const res = await h.handler(req("/update/status", "GET", h.token));
    const body = (await res.json()) as { result: { word: string; epoch: number } | null };
    assertEquals(body.result, { word: "running", epoch: 1700000123 });
  } finally {
    h.stop();
  }
});

Deno.test("update route - a garbage result is no result", async () => {
  const h = setup();
  try {
    await Deno.writeTextFile(`${h.statusDir}/heartbeat`, `${epochNow()}\n`);
    for (const text of ["updated", "UPDATED 12", "updated later", "  \n"]) {
      await Deno.writeTextFile(`${h.statusDir}/result`, text);
      const res = await h.handler(req("/update/status", "GET", h.token));
      const body = (await res.json()) as { installed: boolean; result: unknown };
      assertEquals(body.result, null, `"${text}" is not a result`);
      assertEquals(body.installed, true, "the heartbeat still says the job is there");
    }
  } finally {
    h.stop();
  }
});

Deno.test("update route - an unknown update path is 404", async () => {
  const h = setup();
  try {
    assertEquals((await h.handler(req("/update/nope", "GET", ADMIN))).status, 404);
    assertEquals((await h.handler(req("/update/status", "POST", ADMIN))).status, 404);
  } finally {
    h.stop();
  }
});
