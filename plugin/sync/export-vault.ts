import { Notice } from "obsidian";
import { VaultKeys } from "../../core/crypto.ts";
import { formatUserError } from "../plumbing/errors.ts";
import { Transport } from "./transport.ts";
import { exportDecryptedVault } from "./recovery.ts";

type ExportVaultHost = {
  keys: VaultKeys | null;
  transport: Transport | null;
};

export async function exportVaultFlow(host: ExportVaultHost, targetDir: string): Promise<void> {
  if (!host.keys || !host.transport) throw new Error("vault must be unlocked before export");
  const normalizedTarget = targetDir.trim();
  if (!normalizedTarget) throw new Error("target directory is required");
  new Notice("Geode: export started");
  try {
    const result = await exportDecryptedVault(normalizedTarget, {
      transport: host.transport,
      keys: host.keys,
    });
    new Notice(`Geode: exported ${result.exportedFiles} files`);
  } catch (error) {
    new Notice(`Geode: export failed. ${formatUserError(error)}`);
    throw error;
  }
}
