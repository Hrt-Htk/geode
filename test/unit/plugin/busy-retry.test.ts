// #680 - the server answers 503 `server busy` with `retry-after: 1` when its in-flight
// body budget is full. That is a busy server, not a failure: the budget refills as reads
// finish. The client used to throw on it, which aborted a re-key mid-run: rekey_mode
// stays set, so every blob POST on that vault answers 409 and the vault stops syncing.
// The retry budget has to outlast that advertised second, or the same abort happens one
// window later.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { putVerifier, setHttpImpl } from "../../../plugin/plumbing/provisioning-client.ts";
import { makeRekeyClient } from "../../../plugin/plumbing/rekey-client.ts";
import { HttpClient, setTransportHttp } from "../../../plugin/sync/http-client.ts";

const SERVER = "https://geode.example.com";
const VAULT = "vault-1";
const TOKEN = "device-token";
const AUTH_KEY = "ab".repeat(32);

/** Answer the plain JSON surface with `statuses` in order (repeating the last), count calls. */
function scriptedHttp(statuses: number[]): () => number {
  let calls = 0;
  setHttpImpl(() => {
    const status = statuses[Math.min(calls, statuses.length - 1)];
    calls++;
    return Promise.resolve({ status, text: status < 300 ? "{}" : '{"error":"server busy"}' });
  });
  return () => calls;
}

/** The same for the blob transport (binary bodies, lazy text). */
function scriptedTransport(statuses: number[]): () => number {
  let calls = 0;
  setTransportHttp(() => {
    const status = statuses[Math.min(calls, statuses.length - 1)];
    calls++;
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      text: () => "{}",
      arrayBuffer: () => new ArrayBuffer(1),
    });
  });
  return () => calls;
}

function rekeyClient() {
  return makeRekeyClient(SERVER, VAULT, TOKEN, AUTH_KEY);
}

Deno.test("busy retry - the re-key rows batch retries a 503 and lands", async () => {
  const calls = scriptedHttp([503, 503, 200]);
  await rekeyClient().postRows([], []);
  assertEquals(calls(), 3, "503, 503, then the accepted batch");
});

Deno.test("busy retry - the re-key switch retries a 503 and lands", async () => {
  const calls = scriptedHttp([503, 200]);
  await rekeyClient().switch({
    verifier: "v",
    argon2_ops: 2,
    argon2_mem: 65536,
    auth_hash: "a".repeat(64),
  });
  assertEquals(calls(), 2);
});

Deno.test("busy retry - the re-key blob PUT retries a 503 and lands", async () => {
  const calls = scriptedHttp([503, 200]);
  await rekeyClient().putBlob("a".repeat(64), new Uint8Array([1, 2, 3]));
  assertEquals(calls(), 2);
});

Deno.test("busy retry - a 503 that never clears spends the bounded budget, then fails", async () => {
  const calls = scriptedHttp([503]);
  const started = performance.now();
  const error = await assertRejects(() => rekeyClient().postRows([], []));
  assertEquals((error as { status?: number }).status, 503);
  assertEquals(calls(), 5, "the retry is bounded");
  assert(performance.now() - started < 10_000, "a bounded budget, not an endless wait");
});

Deno.test("busy retry - a 403 is terminal, not retried", async () => {
  const calls = scriptedHttp([403]);
  await assertRejects(() => rekeyClient().postRows([], []));
  assertEquals(calls(), 1);
});

Deno.test("busy retry - HttpClient.putBlob retries a 503 and lands", async () => {
  const calls = scriptedTransport([503, 503, 200]);
  await new HttpClient(SERVER, VAULT, TOKEN).putBlob("b".repeat(64), new Uint8Array([1]));
  assertEquals(calls(), 3);
});

Deno.test("busy retry - HttpClient.putBlob keeps a 507 (vault full) terminal", async () => {
  const calls = scriptedTransport([507]);
  await assertRejects(() =>
    new HttpClient(SERVER, VAULT, TOKEN).putBlob("b".repeat(64), new Uint8Array([1]))
  );
  assertEquals(calls(), 1);
});

// The reviewer's round-2 probe: a 900 ms window ends the old 3-attempt / 600 ms budget on
// a 503, and the re-key aborts anyway. The budget must outlast the second the server
// advertises, so this keeps the server busy well past it.
Deno.test("busy retry - a re-key rows batch survives a two-second busy window", async () => {
  const start = performance.now();
  let calls = 0;
  setHttpImpl(() => {
    calls++;
    const busy = performance.now() - start < 1800;
    return Promise.resolve({ status: busy ? 503 : 200, text: "{}" });
  });
  await rekeyClient().postRows([], []);
  assert(calls > 3, `the old budget gave up after 3 attempts, this one landed on ${calls}`);
  assert(performance.now() - start >= 1800, "the retry actually waited out the window");
});

// #680 note: the one-shot surfaces (join, verifier, purge, admin) go through request(),
// not the re-key client, and they hit the same budget.
Deno.test("busy retry - the shared request() surface retries a busy 503", async () => {
  const calls = scriptedHttp([503, 200]);
  await putVerifier(SERVER, VAULT, TOKEN, "verifier-b64");
  assertEquals(calls(), 2);
});

Deno.test("busy retry - the shared request() surface keeps a terminal 403 immediate", async () => {
  const calls = scriptedHttp([403]);
  await assertRejects(() => putVerifier(SERVER, VAULT, TOKEN, "verifier-b64"));
  assertEquals(calls(), 1);
});
