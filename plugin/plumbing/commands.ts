import { type App, type Command, Platform } from "obsidian";
import { ExportModal } from "../ui/export-modal.ts";
import { HISTORY_ENTRY_TITLE } from "../ui/history-view.ts";
import { formatError, log } from "./log.ts";

type PluginInstance = {
  app: App;
  addCommand(opts: Command): void;
  reconcileNow(): void;
  pushNow(): void;
  lockVault(): void;
  unlockVault(passphrase: string): Promise<void>;
  openPassphraseModal: () => void;
  resyncFromScratch(): Promise<void>;
  exportDecryptedVault(targetDir: string): Promise<void>;
  openTrashModal(): void;
  openFileHistory(path: string): void;
  isUnlockedCheck(): boolean;
  pauseSync(): Promise<void>;
  resumeSync(): Promise<void>;
};

export function registerCommands(plugin: PluginInstance): void {
  plugin.addCommand({
    id: "pause-sync",
    name: "Pause sync",
    callback: () => {
      void plugin.pauseSync();
    },
  });
  plugin.addCommand({
    id: "resume-sync",
    name: "Resume sync",
    callback: () => {
      void plugin.resumeSync();
    },
  });
  plugin.addCommand({
    id: "push-now",
    name: "Push now",
    callback: () => plugin.pushNow(),
  });
  plugin.addCommand({
    id: "reconcile-now",
    name: "Reconcile now",
    callback: () => plugin.reconcileNow(),
  });
  plugin.addCommand({
    id: "unlock",
    name: "Unlock vault",
    callback: () => plugin.openPassphraseModal(),
  });
  plugin.addCommand({
    id: "lock",
    name: "Lock vault",
    callback: () => plugin.lockVault(),
  });
  plugin.addCommand({
    id: "resync",
    name: "Resync from scratch",
    callback: () => {
      void plugin.resyncFromScratch().catch((error) => {
        log.error("resync command failed", { error: formatError(error) });
      });
    },
  });
  // Desktop only: the export writes outside the vault through Node's filesystem (#15),
  // so the command is not offered on mobile at all.
  plugin.addCommand({
    id: "export-decrypted-vault",
    name: "Export decrypted vault to folder...",
    checkCallback: (checking) => {
      if (!Platform.isDesktop) return false;
      if (!checking) {
        new ExportModal(
          plugin.app,
          (dir) => plugin.exportDecryptedVault(dir),
        ).open();
      }
      return true;
    },
  });
  plugin.addCommand({
    id: "open-trash",
    name: "Open trash",
    callback: () => plugin.openTrashModal(),
  });
  // #464: history for the file in the active leaf; greyed out with none open.
  plugin.addCommand({
    id: "show-file-history",
    name: HISTORY_ENTRY_TITLE,
    checkCallback: (checking) => {
      const path = plugin.app.workspace.getActiveFile()?.path;
      if (!path || !plugin.isUnlockedCheck()) return false;
      if (!checking) plugin.openFileHistory(path);
      return true;
    },
  });
}
