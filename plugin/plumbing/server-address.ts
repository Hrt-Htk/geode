// Pure server-address logic (obsidian-free): URL validation and the user-facing
// copy for the #424 server-address edit modal. Copy rule: plain, no dashes.

export type ServerAddressCheck =
  | "ok"
  | "unreachable"
  | "no-vault"
  | "device-unknown"
  | "vault-mismatch";

export type ServerUrlIssue = "empty" | "not-a-url" | "ok";

// A full URL with an http or https scheme. http:// passes (local-network
// servers); the https hint is a warning, not a block.
export function validateServerUrl(raw: string): ServerUrlIssue {
  const url = raw.trim();
  if (!url) return "empty";
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? "ok" : "not-a-url";
  } catch {
    return "not-a-url";
  }
}

export function serverAddressError(issue: Exclude<ServerUrlIssue, "ok">): string {
  return issue === "empty"
    ? "Enter a server URL."
    : "Enter a full server URL, e.g. https://sync.example.org";
}

// Failed check: the old address is kept (rollback model).
export function serverAddressCheckMessage(
  check: Exclude<ServerAddressCheck, "ok">,
  url: string,
): string {
  const kept = "Your previous address is kept.";
  switch (check) {
    case "unreachable":
      return `Couldn't reach ${url}. ${kept}`;
    case "device-unknown":
      return `This device is not recognised. Rejoin the vault. ${kept}`;
    case "vault-mismatch":
      return `This device's token is for a different vault. ${kept}`;
    case "no-vault":
      return `No Geode vault at ${url}. ${kept}`;
  }
}

export function reconnectNotice(url: string): string {
  return `Reconnecting to ${url}…`;
}

// The check endpoint answers with the device token: 2xx means the vault exists
// for this device, 401 means the server no longer knows the token (revoked or
// stale device), 403 means the token belongs to another vault, any other 4xx
// means nothing is served at that base path, and 5xx means the server exists
// but failed: treated as unreachable.
export function serverCheckStatusToKind(status: number): ServerAddressCheck {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401) return "device-unknown";
  if (status === 403) return "vault-mismatch";
  if (status >= 400 && status < 500) return "no-vault";
  return "unreachable";
}
