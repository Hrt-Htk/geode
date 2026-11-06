import {
  createServer as createHttpServer,
  type IncomingMessage,
  request as httpRequest,
  type ServerResponse,
} from "node:http";

// #44: a transparent proxy in front of the throwaway server, for the two behaviours the server
// itself cannot show: how often a run reads the job's state (a poll that must stop when the
// plugin unloads) and a `/version` that cannot answer (the result line waits for it).
// Same shape as the Devices-poll counter (#502): the desktop plugin issues HTTP from the main
// process, so the only place to see it is the network layer.

export type UpdateProxy = {
  url: string;
  /** GET /update/status reads counted so far. */
  statusReads: () => number;
  /** Answer 503 to GET /version while `failing` is true. */
  failVersion: (failing: boolean) => void;
  /** Delay the next GET /update/status by `ms`, so a poll is provably mid read. */
  holdNextStatusRead: (ms: number) => void;
  close: () => Promise<void>;
};

export function startUpdateProxy(targetUrl: string): Promise<UpdateProxy> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    let reads = 0;
    let failing = false;
    let hold = 0;
    const forward = (req: IncomingMessage, res: ServerResponse): void => {
      const upstream = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    };
    const srv = createHttpServer((req, res) => {
      if (req.url?.includes("/update/status")) {
        reads++;
        if (hold > 0) {
          const ms = hold;
          hold = 0;
          setTimeout(() => forward(req, res), ms);
          return;
        }
      }
      if (failing && req.url?.startsWith("/version")) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      forward(req, res);
    });
    // A run reaches the server over HTTP alone; the transport's socket is not part of it.
    srv.on("upgrade", (_req, socket) => socket.destroy());
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address !== "object") {
        reject(new Error("update proxy has no address"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        statusReads: () => reads,
        failVersion: (on) => {
          failing = on;
        },
        holdNextStatusRead: (ms) => {
          hold = ms;
        },
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}
