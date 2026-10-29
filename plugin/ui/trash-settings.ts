import { Setting } from "obsidian";
import type { TrashEntry } from "../plumbing/trash-client.ts";
import { trashCountLabel } from "./trash-format.ts";
import { type MassDeleteHold, thresholdFromInput } from "../sync/mass-delete-hold.ts";
import { holdSentence } from "./mass-delete-review.ts";

// #446: the settings Deleted-files row: a live trash count (non-blocking) and
// a [View] button that opens the TrashModal. Trash is a modal, not a side panel.

export function renderTrashSettings(
  container: HTMLElement,
  opts: {
    settings: {
      trashRetentionDays: number;
      massDeleteMinFiles: number;
      massDeleteMinPercent: number;
    };
    saveSettings: () => void;
    openTrashModal: () => void;
    /** #601: the Trash-section Review row while a mass delete is held. */
    openMassDeleteReview: () => void;
    getHold: () => MassDeleteHold | null;
    getUnlocked: () => boolean;
    trash: { list(): Promise<TrashEntry[]> };
  },
): { refreshCount: () => void; syncHold: () => void } {
  const deletedRow = new Setting(container).setName("Deleted files");
  deletedRow.settingEl.dataset.testid = "geode-settings-trash-count";
  const countDesc = deletedRow.descEl.createSpan();
  deletedRow.addButton((btn) => {
    btn.setButtonText("View");
    btn.buttonEl.dataset.testid = "geode-settings-open-trash";
    btn.onClick(() => opts.openTrashModal());
  });

  new Setting(container)
    .setName("Trash retention (days)")
    .setDesc("Days to keep deleted files before they can be purged.")
    .addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.min = "1";
      t.inputEl.dataset.testid = "geode-settings-retention";
      t.inputEl.value = String(opts.settings.trashRetentionDays);
      t.inputEl.addEventListener("change", () => {
        const v = parseInt(t.inputEl.value, 10);
        if (!isNaN(v) && v > 0) {
          opts.settings.trashRetentionDays = v;
          opts.saveSettings();
        }
      });
    });

  renderMassDeleteThresholds(container, opts.settings, opts.saveSettings);

  const refreshCount = (): void => {
    if (!opts.getUnlocked()) return;
    countDesc.setText(trashCountLabel({ status: "loading" }));
    opts.trash.list()
      .then((entries) => {
        countDesc.setText(trashCountLabel({ status: "loaded", count: entries.length }));
      })
      .catch(() => countDesc.setText(trashCountLabel({ status: "error" })));
  };
  refreshCount();

  // #601: the same review is reachable from the Trash section while held; hidden otherwise.
  const holdRow = new Setting(container)
    .setName("Missing files")
    .setClass("geode-hidden");
  holdRow.settingEl.dataset.testid = "geode-settings-trash-hold";
  const holdDesc = holdRow.descEl.createSpan();
  holdRow.addButton((btn) => {
    btn.setButtonText("Review");
    btn.buttonEl.dataset.testid = "geode-settings-trash-review";
    btn.onClick(() => opts.openMassDeleteReview());
  });
  const syncHold = (): void => {
    const hold = opts.getUnlocked() ? opts.getHold() : null;
    holdRow.settingEl.toggleClass("geode-hidden", !hold);
    if (hold) holdDesc.setText(holdSentence(hold.files.length));
  };
  syncHold();
  return { refreshCount, syncHold };
}

/** #601: the guard the reconciler runs, read on every pass so a change applies without a
 * restart. Always on: the two numbers are the whole setting, there is no off switch. */
function renderMassDeleteThresholds(
  container: HTMLElement,
  settings: { massDeleteMinFiles: number; massDeleteMinPercent: number },
  saveSettings: () => void,
): void {
  const trigger = new Setting(container)
    .setName("Hold large deletions")
    .setDesc("Holds sync when this many files and this percent go missing.");
  trigger.settingEl.dataset.testid = "geode-settings-mass-delete";
  trigger.addText((t) => {
    t.inputEl.type = "number";
    t.inputEl.min = "1";
    t.inputEl.addClass("geode-threshold-input");
    t.inputEl.dataset.testid = "geode-settings-mass-delete-files";
    t.inputEl.value = String(settings.massDeleteMinFiles);
    t.inputEl.addEventListener("change", () => {
      // An invalid entry keeps the last valid value and snaps the field back to it.
      const next = thresholdFromInput(
        t.inputEl.value,
        settings.massDeleteMinFiles,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      settings.massDeleteMinFiles = next;
      t.inputEl.value = String(next);
      saveSettings();
    });
  });
  trigger.controlEl.createSpan({ cls: "geode-threshold-unit", text: "files" });
  trigger.addText((t) => {
    t.inputEl.type = "number";
    t.inputEl.min = "1";
    t.inputEl.max = "100";
    t.inputEl.addClass("geode-threshold-input");
    t.inputEl.dataset.testid = "geode-settings-mass-delete-percent";
    t.inputEl.value = String(settings.massDeleteMinPercent);
    t.inputEl.addEventListener("change", () => {
      const next = thresholdFromInput(t.inputEl.value, settings.massDeleteMinPercent, 1, 100);
      settings.massDeleteMinPercent = next;
      t.inputEl.value = String(next);
      saveSettings();
    });
  });
  trigger.controlEl.createSpan({ cls: "geode-threshold-unit", text: "%" });
}
