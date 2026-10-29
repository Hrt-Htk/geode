// One-shot CDP eval in the Obsidian mobile WebView over wireless ADB (#496).
// Used by the phone E2E global setup's test-vault interlock, `deno task phone:cdp`,
// and the standalone `cdp-eval.mjs` CLI (Node type-stripping). All ADB access
// happens under the phone lock (test/e2e/phone-lock.ts) at the call sites.

import { spawnSync } from "node:child_process";

export function findObsidianSocket(serial?: string, adbPath = "adb"): string {
  const res = spawnSync(
    adbPath,
    [...(serial ? ["-s", serial] : []), "shell", "cat /proc/net/unix"],
    { encoding: "utf-8", timeout: 15_000 },
  );
  if (res.status !== 0) {
    throw new Error(
      `adb shell cat /proc/net/unix failed: ${
        res.stderr?.trim() || res.error?.message || "unknown"
      }`,
    );
  }
  const sockets = new Set<string>();
  for (const line of (res.stdout || "").split("\n")) {
    const m = line.match(/@(webview_devtools_remote_\S+)/);
    if (m) sockets.add(m[1]);
  }
  if (sockets.size === 0) {
    throw new Error(
      "no webview_devtools_remote socket found: is Obsidian with DevTools enabled running on the phone?",
    );
  }
  const list = [...sockets];
  return list.find((s) => s.includes("md.obsidian")) ?? list[0];
}

export function forwardObsidianDevtools(
  serial?: string,
  adbPath = "adb",
  port = 9222,
): { port: number; socket: string } {
  const socket = findObsidianSocket(serial, adbPath);
  const res = spawnSync(
    adbPath,
    [...(serial ? ["-s", serial] : []), "forward", `tcp:${port}`, `localabstract:${socket}`],
    { encoding: "utf-8", timeout: 15_000 },
  );
  if (res.status !== 0) {
    throw new Error(
      `adb forward tcp:${port} failed: ${res.stderr?.trim() || res.error?.message || "unknown"}`,
    );
  }
  return { port, socket };
}

export function unforwardObsidianDevtools(serial?: string, adbPath = "adb", port = 9222): void {
  try {
    spawnSync(
      adbPath,
      [...(serial ? ["-s", serial] : []), "forward", "--remove", `tcp:${port}`],
      { timeout: 10_000 },
    );
  } catch {
    // best-effort cleanup
  }
}

type CdpResponse = {
  id?: number;
  result?: { result?: { value?: unknown }; exceptionDetails?: unknown };
  error?: { message: string };
};

export async function cdpEval(port: number, expr: string): Promise<string> {
  const targets = (await (await fetch(`http://localhost:${port}/json/list`)).json()) as {
    type: string;
    url: string;
    id: string;
  }[];
  // In /json/list the page target's `id` field appears BEFORE `type`, so a naive
  // `grep -A2 '"type":"page"'` misses it: parse the JSON instead.
  const page = targets.find((t) => t.type === "page" && t.url && !t.url.startsWith("devtools"));
  if (!page) throw new Error("no page target found on port " + port);

  const ws = new WebSocket(`ws://localhost:${port}/devtools/page/${page.id}`);
  let id = 0;
  const send = (method: string, params: Record<string, unknown>): Promise<CdpResponse> =>
    new Promise((resolve) => {
      const myId = ++id;
      const handler = (ev: MessageEvent) => {
        const m = JSON.parse(String(ev.data)) as CdpResponse;
        if (m.id === myId) {
          ws.removeEventListener("message", handler);
          resolve(m);
        }
      };
      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  return await new Promise((resolve, reject) => {
    ws.addEventListener("open", async () => {
      try {
        await send("Runtime.enable", {});
        const r = await send("Runtime.evaluate", {
          expression: expr,
          returnByValue: true,
          awaitPromise: true,
        });
        const out = r.result?.result?.value ?? r.result?.exceptionDetails ?? r.result;
        resolve(typeof out === "string" ? out : JSON.stringify(out, null, 2));
      } catch (err) {
        reject(err);
      } finally {
        ws.close();
      }
    });
    ws.addEventListener("error", () => reject(new Error("cdp websocket error")));
  });
}

export async function cdpEvalOnDevice(
  serial?: string,
  expr?: string,
  adbPath = "adb",
  port = 9222,
): Promise<string> {
  if (!expr) throw new Error("cdpEvalOnDevice: no expression to evaluate");
  const { port: p } = forwardObsidianDevtools(serial, adbPath, port);
  try {
    return await cdpEval(p, expr);
  } finally {
    unforwardObsidianDevtools(serial, adbPath, p);
  }
}
