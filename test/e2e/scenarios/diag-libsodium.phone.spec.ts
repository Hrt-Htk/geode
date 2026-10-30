import { expect, test } from "@playwright/test";
import { connectPhone } from "../fixtures/phone-obsidian";

const SALT_B64 = "B4WsbfyEvRrBUCsOcnp4vg==";
const PASSPHRASE = "diagnostic-passphrase";

test("diagnose full unlock path in the real Obsidian renderer", async () => {
  test.skip(process.env.GEODE_PHONE !== "1", "requires connected phone (GEODE_PHONE=1)");

  test.setTimeout(180_000);

  const instance = await connectPhone({
    geodeSettings: {
      serverUrl: "http://127.0.0.1:1",
      vaultId: "diag-vault",
      deviceId: "diag-device",
      deviceToken: "diag-token",
      salt: SALT_B64,
    },
  });

  const consoleMsgs: string[] = [];
  instance.win.on("console", (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  instance.win.on("pageerror", (e) => consoleMsgs.push(`[pageerror] ${e.message}`));

  await expect
    .poll(async () => await instance.eval<boolean>("Boolean(app.plugins.plugins.geode)"), {
      timeout: 60_000,
    })
    .toBe(true);

  // Full unlock: NO verifier configured, so unlockVault runs the entire post-deriveKeys path
  // (openState -> saveKeyCache -> restartUnlockedSession -> transport.start to an unreachable
  // server). This reproduces exactly what the passphrase modal awaits while showing "Working…".
  const raw = await instance.eval<string>(`
    const out = {};
    out.wasmGlobalSet = !!globalThis.__GEODE_LIBSODIUM_WASM__;
    out.wasmByteLength = globalThis.__GEODE_LIBSODIUM_WASM__ ? globalThis.__GEODE_LIBSODIUM_WASM__.byteLength : null;

    // Spy on network primitives the sync layer might use.
    const fetchUrls = [];
    const wsUrls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = function (...a) { try { fetchUrls.push(String(a[0])); } catch (_) {} return origFetch.apply(this, a); };
    const OrigWS = globalThis.WebSocket;
    globalThis.WebSocket = function (url, ...rest) { try { wsUrls.push(String(url)); } catch (_) {} return new OrigWS(url, ...rest); };
    globalThis.WebSocket.prototype = OrigWS.prototype;

    const g = app.plugins.plugins.geode;
    g.pluginSettings.verifier = "";

    let outcome;
    const startedAt = Date.now();
    try {
      outcome = await Promise.race([
        g.unlockVault(${
    JSON.stringify(PASSPHRASE)
  }).then(() => "RESOLVED").catch((e) => "REJECTED: " + ((e && e.message) || e)),
        new Promise((r) => setTimeout(() => r("TIMEOUT_30s"), 30000)),
      ]);
    } catch (e) {
      outcome = "THREW: " + ((e && e.message) || e);
    }
    out.unlockMs = Date.now() - startedAt;
    out.unlockOutcome = outcome;
    out.isUnlocked = (() => { try { return g.isUnlockedCheck(); } catch (_) { return "n/a"; } })();
    out.fetchUrls = fetchUrls;
    out.wsUrls = wsUrls;

    globalThis.fetch = origFetch;
    globalThis.WebSocket = OrigWS;
    return JSON.stringify(out);
  `);

  const result = JSON.parse(raw);
  console.log("\n===== FULL-UNLOCK DIAGNOSTIC =====");
  console.log(JSON.stringify(result, null, 2));
  console.log("----- renderer console -----");
  console.log(consoleMsgs.join("\n") || "(none captured)");
  console.log("===== END DIAGNOSTIC =====\n");

  await instance.close();

  expect(result.unlockOutcome).toBe("RESOLVED");
});
