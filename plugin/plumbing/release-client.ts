/** #93: startup check against GitHub's latest final release + raw versions.json on main.
 * Rides provisioning-client's rawRequest (requestUrl on desktop, fetch on mobile) and never
 * fetches a release asset. Obsidian-free (unit-testable via setHttpImpl). */
import { compareSemVer, parseSemVer } from "../../core/version.ts";
import { HttpStatusError, rawRequest } from "./provisioning-client.ts";
import { windowGlobal } from "./window.ts";

export const GEODE_LATEST_RELEASE_URL =
  "https://api.github.com/repos/Hrt-Htk/geode/releases/latest";
export const GEODE_VERSIONS_URL =
  "https://raw.githubusercontent.com/Hrt-Htk/geode/main/versions.json";

type ReleaseCheckUrls = { latest: string; versions: string };

/** True when `version` is a final X.Y.Z release (not a beta or unparseable string). */
export function isFinalVersion(version: string): boolean {
  const parsed = parseSemVer(version);
  return parsed !== null && parsed.beta === undefined;
}

/** Pick the highest final version compatible with this Obsidian API version. */
export function getLatestCompatibleVersion(
  latestVersion: string,
  versionsPayload: unknown,
  canRunMinAppVersion: (minAppVersion: string) => boolean,
): string | null {
  const manifest = versionsPayload !== null && typeof versionsPayload === "object" &&
      !Array.isArray(versionsPayload)
    ? (versionsPayload as Record<string, unknown>)
    : {};
  const latestMin = manifest[latestVersion];
  if (typeof latestMin !== "string" || !latestMin || canRunMinAppVersion(latestMin)) {
    return latestVersion;
  }

  const compatible = Object.entries(manifest)
    .filter(([v, min]) => isFinalVersion(v) && typeof min === "string" && canRunMinAppVersion(min))
    .map(([v]) => v)
    .sort((a, b) => compareSemVer(a, b));
  return compatible[compatible.length - 1] ?? null;
}

function defaultUrls(): ReleaseCheckUrls {
  const override = (windowGlobal as { __geodeReleaseUrls?: Partial<ReleaseCheckUrls> })
    .__geodeReleaseUrls;
  return {
    latest: override?.latest ?? GEODE_LATEST_RELEASE_URL,
    versions: override?.versions ?? GEODE_VERSIONS_URL,
  };
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await rawRequest({ url, method: "GET", headers });
  if (res.status < 200 || res.status >= 300) {
    throw new HttpStatusError(res.status, `GET ${url} failed: ${res.status}`);
  }
  return JSON.parse(res.text);
}

/** Query the latest compatible final release version for this Obsidian install. */
export async function fetchAvailableReleaseVersion(opts: {
  currentVersion: string;
  canRunMinAppVersion: (minAppVersion: string) => boolean;
}): Promise<string | null> {
  const urls = defaultUrls();
  const latestPayload = await getJson(urls.latest, { Accept: "application/vnd.github+json" });
  const rawTag = latestPayload !== null && typeof latestPayload === "object" &&
      !Array.isArray(latestPayload)
    ? (latestPayload as Record<string, unknown>).tag_name
    : null;
  const latest = typeof rawTag === "string" ? rawTag.trim() : "";
  if (!isFinalVersion(latest)) throw new Error(`invalid latest release tag: ${String(rawTag)}`);
  if (compareSemVer(latest, opts.currentVersion) <= 0) return latest;

  const versionsPayload = await getJson(urls.versions, {});
  return getLatestCompatibleVersion(latest, versionsPayload, opts.canRunMinAppVersion);
}
