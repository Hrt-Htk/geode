/**
 * Serve `handler` in-process on an OS-assigned port (bind 0) and return the
 * port the listener actually got. Random base+offset ports collide between
 * parallel test files (#402); the OS never hands one port to two live
 * listeners.
 */
export function serveOnPortZero(
  handler: Deno.ServeHandler,
  opts: { hostname?: string } = {},
): { port: number; shutdown: () => Promise<void>; finished: Promise<void> } {
  const server = Deno.serve({ port: 0, ...opts }, handler);
  return {
    port: server.addr.port,
    shutdown: () => server.shutdown(),
    finished: server.finished,
  };
}
