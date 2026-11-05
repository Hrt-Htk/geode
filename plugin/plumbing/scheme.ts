export const SCHEME = /^(wss?|https?):\/\//i;

// The address as the plugin stores it: an explicit scheme is kept (it decides
// http or tls for every request), a bare host gets one from the local rule, and
// trailing slashes go.
export function normalizeServerInput(raw: string): string {
  const { scheme, host } = splitAddress(raw);
  return `${scheme}://${host}`;
}

// Loopback and the private ranges a home server or Tailscale sits on: no real
// certificate there, so a bare address means plain http.
function isLocalHost(host: string): boolean {
  const name = host.toLowerCase().replace(/:\d+$/, "");
  if (name === "localhost") return true;
  const octets = name.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

// The typed scheme and the bare host:port behind it, whichever way the user
// wrote the address. A missing scheme comes from isLocalHost.
function splitAddress(raw: string): { scheme: string; host: string } {
  const typed = raw.trim();
  const host = typed.replace(SCHEME, "").replace(/\/+$/, "");
  const scheme = SCHEME.exec(typed)?.[1].toLowerCase() ??
    (isLocalHost(host) ? "http" : "https");
  return { scheme, host };
}

// http and ws are the same server, so each maps the scheme to its own kind:
// httpBase turns ws into http, wsBase turns http into ws.
export function httpBase(raw: string): string {
  const { scheme, host } = splitAddress(raw);
  const httpScheme = scheme === "ws" ? "http" : scheme === "wss" ? "https" : scheme;
  return `${httpScheme}://${host}`;
}

// Derive a WebSocket base URL. http://host → ws://host, https://host → wss://host.
export function wsBase(raw: string): string {
  const { scheme, host } = splitAddress(raw);
  const wsScheme = scheme === "http" ? "ws" : scheme === "https" ? "wss" : scheme;
  return `${wsScheme}://${host}`;
}
