// Test-only TCP relay that can freeze one direction once. The stall spec puts it between
// Obsidian and the bundled Caddy so a body stops mid-transfer and Caddy's own 60 s
// read_body_idle / write_idle cuts it (docs/testing/e2e-playwright.md, "Stall recovery").
//
// Direction, from this relay's point of view:
//   "up"   Obsidian to Caddy, so an upload body stops arriving
//   "down" Caddy to Obsidian, so a download body stops being read
import { connect, createServer, type Socket } from "node:net";

export type StallDirection = "up" | "down";

export type StallProxy = {
  /** The URL to give the plugin: the upstream's scheme on this relay's port. */
  url: (scheme: string) => string;
  /**
   * Freeze the first chunk of at least `minBytes` in `direction`, once, for `holdMs`. The
   * size floor keeps the freeze off the small frames the WebSocket shares the device with.
   */
  arm: (direction: StallDirection, opts?: { minBytes?: number; holdMs?: number }) => void;
  /** Whether an armed freeze actually happened, and has finished. */
  stalled: () => boolean;
  close: () => Promise<void>;
};

export function startStallProxy(upstream: { host: string; port: number }): Promise<StallProxy> {
  const sockets = new Set<Socket>();
  let armed: { direction: StallDirection; minBytes: number; holdMs: number } | null = null;
  let freed = 0;

  const server = createServer((client) => {
    const far = connect(upstream.port, upstream.host);
    sockets.add(client);
    sockets.add(far);
    const watch = (direction: StallDirection) => (chunk: Buffer) => {
      if (!armed || armed.direction !== direction || chunk.length < armed.minBytes) return;
      const { holdMs } = armed;
      armed = null;
      const source = direction === "up" ? client : far;
      source.pause();
      setTimeout(() => {
        source.resume();
        freed++; // only once the freeze is over, so stalled() means "fired and released"
      }, holdMs);
    };
    client.on("data", watch("up"));
    far.on("data", watch("down"));
    client.pipe(far);
    far.pipe(client);
    const drop = () => {
      client.destroy();
      far.destroy();
      sockets.delete(client);
      sockets.delete(far);
    };
    client.on("close", drop);
    far.on("close", drop);
    client.on("error", drop);
    far.on("error", drop);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: (scheme) => `${scheme}://localhost:${port}`,
        arm: (direction, opts) => {
          armed = {
            direction,
            minBytes: opts?.minBytes ?? 8 * 1024,
            holdMs: opts?.holdMs ?? 75_000,
          };
        },
        stalled: () => freed > 0,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}
