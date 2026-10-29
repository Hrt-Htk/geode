// Hello/handshake gate: parse client_hello, enforce protocol/minimum version,
// register the connection, send hello_ack, and replay the backlog. Own module so
// ws.ts stays a single-responsibility relay loop within the ≤300 LOC tripwire.
import type { Database } from "@db/sqlite";
import type { ClientMessage, ServerMessage, ServerVersionMismatch } from "../core/protocol.ts";
import { b64decode } from "../core/protocol.ts";
import { blake3Hex } from "../core/hash.ts";
import { getReplaySince, rekeyMode } from "./db.ts";
import {
  checkMinVersion,
  checkProtocolVersion,
  SERVER_VERSION,
  updateDevicePluginVersion,
} from "./version-gate.ts";
import { type HubConnection, REPLAY_PACE_HWM, rowToVersion } from "./ws-types.ts";
import { log } from "./log.ts";

const HELLO_TIMEOUT_MS = 5_000; // docs/architecture/server.md §6: close if no hello within 5 s
const MAX_PLUGIN_VERSION_LEN = 64; // semver-ish "1.2.3" + pre-release/build; 64 is far past any real one

export interface HandshakeContext {
  ws: WebSocket;
  db: Database;
  vaultId: string;
  deviceId: string;
  recv: () => Promise<string | null>;
  isClosed: () => boolean;
  register: (ws: WebSocket, deviceId: string) => HubConnection;
  send: (conn: HubConnection, msg: ServerMessage) => void;
}

// Returns the registered connection, or null if the handshake was rejected or the socket closed.
export async function runHandshake(ctx: HandshakeContext): Promise<HubConnection | null> {
  const { ws, db, vaultId, deviceId, recv, isClosed, register, send } = ctx;

  const helloRaw = await recvHello(ws, recv, isClosed);
  if (helloRaw === null) return null;

  let hello: ClientMessage;
  try {
    hello = JSON.parse(helloRaw) as ClientMessage;
  } catch {
    ws.close(1002, "invalid hello");
    return null;
  }
  if (hello.type !== "client_hello") {
    ws.close(1002, "expected hello");
    return null;
  }

  const protoResult = checkProtocolVersion(hello.protocol_version);
  if (!protoResult.ok) {
    rejectVersion(ws, hello.plugin_version ?? "", protoResult.reason);
    return null;
  }

  const lastSeenSeq = hello.last_seen_seq;
  const pluginVersion = hello.plugin_version ?? "";
  if (pluginVersion.length > MAX_PLUGIN_VERSION_LEN) {
    ws.close(1008, "plugin_version too long");
    return null;
  }
  log.info("ws hello received", {
    vault_id: vaultId,
    last_seen_seq: lastSeenSeq,
    plugin_version: pluginVersion,
  });

  const gateResult = checkMinVersion(pluginVersion);
  if (!gateResult.ok) {
    rejectVersion(ws, pluginVersion, gateResult.reason);
    return null;
  }

  updateDevicePluginVersion(db, deviceId, pluginVersion);

  const conn = register(ws, deviceId);
  send(conn, {
    type: "server_hello_ack",
    vault_id: vaultId,
    vault_name: vaultName(db, vaultId),
    seq: currentSeq(db, vaultId),
    server_version: SERVER_VERSION,
    rekey: rekeyMode(db, vaultId) !== null,
    verifier_hash: verifierHash(db, vaultId),
  });

  let replayCount = 0;
  for (const row of getReplaySince(db, vaultId, lastSeenSeq)) {
    if (isClosed()) break;
    send(conn, rowToVersion(row, vaultId));
    replayCount++;
    // Pace: if the socket's send buffer is piling up, await a drain tick.
    if (ws.bufferedAmount > REPLAY_PACE_HWM) {
      for (let waited = 0; waited < 30_000; waited += 20) {
        if (isClosed()) break;
        if (ws.bufferedAmount <= REPLAY_PACE_HWM) break;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
  }
  log.info("ws replay done", { vault_id: vaultId, count: replayCount });
  return conn;
}

// A connected-but-silent peer must not hold a hub slot forever.
async function recvHello(
  ws: WebSocket,
  recv: () => Promise<string | null>,
  isClosed: () => boolean,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const raw = await Promise.race([
    recv(),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), HELLO_TIMEOUT_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (raw === null && !isClosed()) ws.close(1002, "hello timeout");
  return raw;
}

// #625: tell the refused client WHY before closing: every shipped plugin blocks
// on server_version_mismatch with an update prompt, while a bare 1008 only drove
// a reconnect loop. No new field: the message already exists (hard rule 3).
function rejectVersion(ws: WebSocket, clientVersion: string, reason: string | undefined): void {
  const msg: ServerVersionMismatch = {
    type: "server_version_mismatch",
    server_version: SERVER_VERSION,
    client_version: clientVersion,
  };
  ws.send(JSON.stringify(msg));
  ws.close(1008, reason);
}

function currentSeq(db: Database, vaultId: string): number {
  const row = db.prepare(
    "SELECT MAX(seq) AS m FROM file_versions WHERE vault_id = ?",
  ).get(vaultId) as { m: number | null };
  return row.m ?? 0;
}

function vaultName(db: Database, vaultId: string): string {
  const row = db.prepare(
    "SELECT name FROM vaults WHERE id = ?",
  ).get(vaultId) as { name: string } | null;
  return row?.name ?? "";
}

// #560: devices compare this against the hash of their stored verifier to
// detect a passphrase change on another device. A malformed stored verifier
// must never break the handshake: omit the field instead.
function verifierHash(db: Database, vaultId: string): string | undefined {
  const row = db.prepare("SELECT verifier FROM vaults WHERE id = ?").get(vaultId) as {
    verifier: string | null;
  } | null;
  if (!row?.verifier) return undefined;
  try {
    return blake3Hex(b64decode(row.verifier));
  } catch {
    return undefined;
  }
}
