// Two facts about a transfer that stops mid-flight, measured through the bundled Caddy:
//
//   1. Caddy cuts a stalled upload at 60 s (read_body_idle; measured 60.04 s, 502,
//      `readfrom ... i/o timeout`) and the plugin resends it.
//   2. A stalled reader aborts the download (Caddy logs `writing: client disconnected`)
//      and the plugin fetches the chunks again. Caddy does not cut it mid-body: one
//      Geode response is at most one chunk, which fits the client's HTTP/2 window, so a
//      frozen reader never blocks Caddy's write.
//
// Both files still land on the other device, so neither transfer wedges.
//
// Not part of a normal run: it needs the container behind the bundled Caddy and holds two
// sockets still for 65 s each. Setup, from the repo root:
//
//   export GEODE_ADMIN_TOKEN=$(openssl rand -hex 16) COMPOSE_PROFILES=https \
//     GEODE_DOMAIN=localhost GEODE_TRUST_PROXY=1 GEODE_STALL=1
//   mkdir -p /tmp/geode-stall/data && sudo chown 1993:1993 /tmp/geode-stall/data
//   printf 'services:\n  geode:\n    image: geode-stall:local\n' > /tmp/geode-stall/override.yaml
//   docker build --build-arg VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1) \
//     -t geode-stall:local .
//   docker compose -f compose.yaml -f /tmp/geode-stall/override.yaml -p geode-stall \
//     --project-directory /tmp/geode-stall up -d
//   docker cp geode-stall-https-1:/data/caddy/pki/authorities/local/root.crt /tmp/geode-stall/ca.crt
//   NODE_EXTRA_CA_CERTS=/tmp/geode-stall/ca.crt GEODE_E2E_SERVER_URL=https://localhost \
//     GEODE_E2E_DATA_DIR=/tmp/geode-stall/data \
//     xvfb-run -a node node_modules/@playwright/test/cli.js test \
//     --config=test/e2e/playwright.config.ts --project=default \
//     test/e2e/scenarios/stall-recovery.spec.ts
//
// The plugin trusts Caddy's own CA through `--ignore-certificate-errors`, which is a
// test-only launch switch: production installs have a real certificate.
import { test } from "@playwright/test";
import { launchObsidian, type ObsidianInstance, TEST_ARGON2_PARAMS } from "../fixtures/obsidian";
import { startServer } from "../fixtures/server";
import { type StallProxy, startStallProxy } from "../helpers/stall-proxy";
import { waitForContent, waitForStatusBar } from "../helpers/waits";

const PASSPHRASE = "stall-recovery-passphrase";
// Just past Caddy's 60 s timeout: long enough to guarantee the cut, short enough to fit.
const HOLD_MS = 65_000;
// 320 KB: one FastCDC chunk or two, so an upload is several records and a stall lands in it.
const UPLOAD_BODY = "stall-test-upload\n".repeat(17_000);
// 9 MB: one response per chunk (1 MB at most) fits the client's HTTP/2 window, but the file's
// chunks do not, so Caddy's write blocks and its 60 s timeout fires mid-download.
const DOWNLOAD_BODY = "y".repeat(9 * 1024 * 1024);

test.skip(
  process.env.GEODE_STALL !== "1",
  "GEODE_STALL=1 runs the 60 s stall gate: it needs the container behind Caddy",
);

async function waitForStall(proxy: StallProxy, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proxy.stalled()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the freeze never fired: no transfer of that size crossed the relay");
}

async function writeAndCommit(instance: ObsidianInstance, path: string, content: string) {
  await instance.eval(`
    const path = ${JSON.stringify(path)};
    const folder = path.split("/").slice(0, -1).join("/");
    if (folder && !(await app.vault.adapter.exists(folder))) {
      await app.vault.createFolder(folder);
    }
    await app.vault.create(path, ${JSON.stringify(content)});
    await app.plugins.plugins.geode.syncManager.handlePendingOps([{ path, kind: "commit" }]);
    return true;
  `);
}

/** Rewrite a file that already synced, so the edit has to travel the other way. */
async function editAndCommit(instance: ObsidianInstance, path: string, content: string) {
  await instance.eval(`
    const path = ${JSON.stringify(path)};
    await app.vault.modify(app.vault.getFileByPath(path), ${JSON.stringify(content)});
    await app.plugins.plugins.geode.syncManager.handlePendingOps([{ path, kind: "commit" }]);
    return true;
  `);
}

test("Caddy cuts a stalled upload at 60 s and a stalled reader aborts, and both recover", async () => {
  // Two freezes past Caddy's 60 s, a 9 MB file each way, and the plugin's retries. Generous
  // on purpose: it is the only assertion, so a slow machine must not turn it into a failure.
  test.setTimeout(600_000);

  const server = await startServer();
  const upstream = { host: "127.0.0.1", port: Number(new URL(server.url).port || 443) };
  const scheme = new URL(server.url).protocol.replace(":", "");
  const [deviceA, deviceB] = await Promise.all([
    server.mintToken("device-A"),
    server.mintToken("device-B"),
  ]);
  await server.registerAuthHash(deviceA.token, PASSPHRASE, TEST_ARGON2_PARAMS);

  const uploadProxy = await startStallProxy(upstream);
  const downloadProxy = await startStallProxy(upstream);
  const settings = (device: typeof deviceA, url: string) => ({
    serverUrl: url,
    vaultId: server.vaultId,
    deviceId: device.deviceId,
    deviceToken: device.token,
    salt: server.salt,
  });
  const A = await launchObsidian({
    geodeSettings: settings(deviceA, uploadProxy.url(scheme)),
    unlockPassphrase: PASSPHRASE,
    extraArgs: ["--ignore-certificate-errors"],
  });
  const B = await launchObsidian({
    geodeSettings: settings(deviceB, downloadProxy.url(scheme)),
    unlockPassphrase: PASSPHRASE,
    extraArgs: ["--ignore-certificate-errors"],
  });

  try {
    await Promise.all([
      waitForStatusBar(A.win, "Geode: synced", 90_000),
      waitForStatusBar(B.win, "Geode: synced", 90_000),
    ]);

    // Upload: A's body stops arriving, so Caddy's read_body_idle cuts the request at 60 s
    // (502, `readfrom ... i/o timeout`, part of the body read), and the plugin resends it.
    const uploadPath = "stall/upload.md";
    uploadProxy.arm("up", { holdMs: HOLD_MS });
    await writeAndCommit(A, uploadPath, UPLOAD_BODY);
    await waitForStall(uploadProxy);
    await waitForContent(A, B, uploadPath, UPLOAD_BODY, 120_000);
    await waitForStatusBar(B.win, "Geode: synced", 60_000);

    // Download: B stops reading. Caddy is not the one that cuts here (one response fits the
    // client's HTTP/2 window): the frozen reader makes the requests abort, and the plugin asks
    // for the chunks again. A whole file's worth of unread chunks is what makes it noticeable.
    const downloadPath = "stall/download.md";
    downloadProxy.arm("down", { holdMs: HOLD_MS });
    await writeAndCommit(A, downloadPath, DOWNLOAD_BODY);
    await waitForStall(downloadProxy);
    await waitForContent(A, B, downloadPath, DOWNLOAD_BODY, 240_000);
    await waitForStatusBar(B.win, "Geode: synced", 60_000);

    // Both transports have to be alive afterwards: an edit from B reaches A.
    await editAndCommit(B, uploadPath, `${UPLOAD_BODY}edited after the stalls\n`);
    await waitForContent(B, A, uploadPath, `${UPLOAD_BODY}edited after the stalls\n`, 120_000);
  } finally {
    await Promise.allSettled([A.close(), B.close()]);
    await Promise.allSettled([uploadProxy.close(), downloadProxy.close()]);
  }
});
