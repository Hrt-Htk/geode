export function makeTempDataDir(): string {
  return Deno.makeTempDirSync();
}

export function removeTempDir(dir: string): void {
  try {
    Deno.removeSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
}
