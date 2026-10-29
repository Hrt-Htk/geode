import { SCHEME } from "../plumbing/scheme.ts";

/** Host (with port) of a server URL. Schemeless input (the stored form) is the
 * host already, so it is returned verbatim: new URL() would misparse
 * "host:port" as a scheme. Falls back to the raw input when unparsable. */
export function serverHost(url: string): string {
  if (!SCHEME.test(url)) return url;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
