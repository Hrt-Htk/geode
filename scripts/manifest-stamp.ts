/**
 * #22: the release asset must carry the released version while the root
 * manifest.json keeps the last promoted one, because the community directory
 * reads the root manifest at HEAD of main.
 */
export function stampManifest(manifest: string, version: string): string {
  return JSON.stringify({ ...JSON.parse(manifest), version }, null, 2) + "\n";
}
