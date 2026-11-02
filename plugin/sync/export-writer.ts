import { Platform } from "obsidian";

/** Writes one exported file outside the vault, creating its folder. This is the plugin's one
 * Node user: Node's modules do not exist on mobile, and the community scanner forbids a Node
 * import that runs at load, so they load inside this `Platform.isDesktop` guard (#15). The
 * guard has to sit in the same function as the import for `obsidianmd/no-nodejs-modules`;
 * the command that reaches this path is registered desktop only. */
export async function writeExportedFile(destination: string, bytes: Uint8Array): Promise<void> {
  if (!Platform.isDesktop) throw new Error("export needs the desktop app");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}
