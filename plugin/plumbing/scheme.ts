// Strip any scheme (ws/wss/http/https) and trailing slashes. Returns bare host:port.
export function normalizeServerInput(raw: string): string {
  return raw.replace(SCHEME, "").replace(/\/+$/, "");
}

// Is the host a local address? (localhost, 127.x, or bare IP: heuristic for http vs https)
function isLocalHost(host: string): boolean {
  return (
    host.startsWith("localhost") ||
    host.startsWith("127.") ||
    // bare IPv4: first char is a digit and contains a dot (good enough heuristic)
    (/^\d+\./.test(host))
  );
}

export const SCHEME = /^(wss?|https?):\/\//i;

// An explicit scheme in the input is honored; only schemeless hosts get the
// local heuristic. http↔ws and https↔wss are the same server, so each function
// maps the input scheme to its own kind (httpBase maps ws→http, wsBase http→ws).
export function httpBase(host: string): string {
  const base = normalizeServerInput(host);
  const m = SCHEME.exec(host);
  if (m) {
    const s = m[1].toLowerCase();
    return `${s === "wss" ? "https" : s === "ws" ? "http" : s}://${base}`;
  }
  return `${isLocalHost(base) ? "http:" : "https:"}//${base}`;
}

// Derive a WebSocket base URL. http://host → ws://host, https://host → wss://host.
export function wsBase(host: string): string {
  const base = normalizeServerInput(host);
  const m = SCHEME.exec(host);
  if (m) {
    const s = m[1].toLowerCase();
    return `${s === "https" ? "wss" : s === "http" ? "ws" : s}://${base}`;
  }
  return `${isLocalHost(base) ? "ws:" : "wss:"}//${base}`;
}
