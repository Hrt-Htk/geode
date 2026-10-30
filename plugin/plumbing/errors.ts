import { formatError } from "./log.ts";

const HTTP_FAILURE = /^(GET|POST|PUT|DELETE|HEAD)\s+\S+\s+failed:\s+(\d+)\s+(.*)/s;

/** The status + body of a raw `provisioning-client` failure
 * (`"<METHOD> <url> failed: <status> <body>"`), or null for any other error. */
function httpFailure(error: unknown): { status: number; body: string } | null {
  const match = formatError(error).match(HTTP_FAILURE);
  return match ? { status: Number(match[2]), body: match[3].trim() } : null;
}

/**
 * User-facing error formatter.
 *
 * Detects the raw HTTP error shape produced by `provisioning-client.ts` and rewrites it to a
 * clean, non-leaky message. Returns the plain message unchanged for everything else.
 */
export function formatUserError(error: unknown): string {
  const failure = httpFailure(error);
  if (!failure) return formatError(error);
  try {
    const parsed = JSON.parse(failure.body) as { error?: unknown } | null;
    if (parsed?.error && typeof parsed.error === "string") {
      return `Server error (${failure.status}): ${parsed.error}`;
    }
  } catch {
    // not JSON: fall through
  }
  return `Server error (${failure.status})`;
}

/** #677: a 401 means the server no longer accepts the cached admin token (rotated): the
 * caller drops it so the next privileged action asks again. A 429 keeps it. */
export function isAdminAuthFailure(error: unknown): boolean {
  return httpFailure(error)?.status === 401;
}
