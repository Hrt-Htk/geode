import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { arraysEqual } from "../../helpers/bytes.ts";

export async function collectRelativeFiles(
  rootDir: string,
  opts?: { excludeDirs?: string[] },
): Promise<string[]> {
  const relativeFiles: string[] = [];
  const excluded = new Set(opts?.excludeDirs ?? []);

  await walk(rootDir, "");
  return relativeFiles.sort();

  async function walk(currentDir: string, relativeDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (excluded.has(relativePath) || excluded.has(entry.name)) {
          continue;
        }
        await walk(path.join(currentDir, entry.name), relativePath);
        continue;
      }
      relativeFiles.push(relativePath.replaceAll("\\", "/"));
    }
  }
}

export async function readRelativeFileBytes(
  rootDir: string,
  relativePath: string,
): Promise<Uint8Array> {
  const filePath = path.join(rootDir, ...relativePath.split("/"));
  return new Uint8Array(await readFile(filePath));
}

export async function treesMatchBytes(
  leftRoot: string,
  rightRoot: string,
  relativePaths: string[],
): Promise<boolean> {
  const comparisons = await Promise.all(relativePaths.map(async (relativePath) => {
    const [leftBytes, rightBytes] = await Promise.all([
      readRelativeFileBytes(leftRoot, relativePath),
      readRelativeFileBytes(rightRoot, relativePath),
    ]);
    return arraysEqual(leftBytes, rightBytes);
  }));
  return comparisons.every(Boolean);
}
