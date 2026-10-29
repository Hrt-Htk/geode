// Semver helpers: pure, dependency-free (stdlib only).
// Used by both server (version gate) and client (peer comparison).

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a "MAJOR.MINOR.PATCH" string into a SemVer object.
 * Returns null for any non-matching input (prerelease tags, "v" prefix, etc.).
 */
export function parseSemVer(v: string): SemVer | null {
  const m = SEMVER_RE.exec(v);
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
  };
}

/**
 * Compare two semver strings.
 * Returns -1, 0, or 1.
 * Unparseable versions are treated as "below" any valid version.
 * Two unparseable versions compare as equal (0).
 */
export function compareSemVer(a: string, b: string): -1 | 0 | 1 {
  const pa = parseSemVer(a);
  const pb = parseSemVer(b);

  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  return 0;
}

/**
 * Check whether `version` meets or exceeds `minimum`.
 *
 * - A valid version >= minimum returns true.
 * - An unparseable version fails any non-zero minimum, but passes "0.0.0"
 *   (the inert default that effectively disables the gate).
 */
export function meetsMinimum(version: string, minimum: string): boolean {
  if (compareSemVer(minimum, "0.0.0") === 0) return true;
  return compareSemVer(version, minimum) >= 0;
}
