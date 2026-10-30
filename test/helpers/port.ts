/**
 * Serve `handler` in-process on an OS-assigned port (bind 0) and return the
 * port the listener actually got. Random base+offset ports collide between
 * parallel test files (#402); the OS never hands one port to two live
 * listeners. Pass `port` to re-bind a freed port instead: the two-vault driver's
 * simulated server restart keeps the URL its clients already hold.
 */
export function serveOnPortZero(
  handler: Deno.ServeHandler,
  opts: { hostname?: string; port?: number } = {},
): { port: number; shutdown: () => Promise<void>; finished: Promise<void> } {
  const server = Deno.serve({ port: opts.port ?? 0, hostname: opts.hostname }, handler);
  return {
    port: server.addr.port,
    shutdown: () => server.shutdown(),
    finished: server.finished,
  };
}
