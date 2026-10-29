// #625: a stand-in for an OLD Geode server: it speaks one protocol behind this
// build and refuses a newer plugin exactly the way a pre-#625 server did, with a
// bare 1008 whose reason is the historical text. The literals are a pinned copy
// of v0.36.0 (`git show v0.36.0:server/version-gate.ts`), NOT imports from
// core/protocol.ts: reword the current marker or bump the protocol and this E2E
// must fail until someone updates the fixture deliberately.
const HISTORICAL_PROTOCOL_REFUSAL =
  "protocol version mismatch: server 4, client 5: update required";

const port = Number(Deno.args[0] ?? "0");
const listener = Deno.serve({ port, hostname: "127.0.0.1" }, (req) => {
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    // The settings tab reads /storage; answer it so the shot is not full of NaN.
    if (new URL(req.url).pathname.endsWith("/storage")) {
      return Response.json({
        total: 200 * 1024 ** 3,
        used: 10 * 1024 ** 3,
        free: 190 * 1024 ** 3,
        vault_used: 0,
      });
    }
    return new Response("", { status: 200 });
  }
  // Echo the requested subprotocol, or the browser fails the handshake instead of
  // seeing a clean 1008 close (the same trap server/main.ts documents).
  const protocol = req.headers.get("sec-websocket-protocol") ?? undefined;
  const { response, socket } = Deno.upgradeWebSocket(req, { protocol });
  socket.addEventListener("message", () => {
    socket.close(1008, HISTORICAL_PROTOCOL_REFUSAL);
  });
  return response;
});
console.log(`old-server listening ${listener.addr.port}`);
