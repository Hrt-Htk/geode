import type { Setting } from "obsidian";
import type { SettingsRow } from "./settings-legacy.ts";
import { wholeAtLeastOne } from "./settings-tree.ts";
import { TRASH_RETENTION_ROW } from "./settings-row-names.ts";
import type { TrashEntry } from "../plumbing/trash-client.ts";
import { trashCountLabel } from "./trash-format.ts";
import { type MassDeleteHold, thresholdFromInput } from "../sync/mass-delete-hold.ts";
import { holdSentence } from "./mass-delete-review.ts";

// #446: the settings Deleted files row: a live trash count (non-blocking) and
// a [View] button that opens the TrashModal. Trash is a modal, not a side panel.

export function trashSettingsRows(
  opts: {
    settings: { massDeleteMinFiles: number; massDeleteMinPercent: number };
    saveSettings: () => void;
    openTrashModal: () => void;
    /** #601: the Trash-section Review row while a mass delete is held. */
    openMassDeleteReview: () => void;
    getHold: () => MassDeleteHold | null;
    getUnlocked: () => boolean;
    trash: { list(): Promise<TrashEntry[]> };
  },
): { rows: SettingsRow[]; refreshCount: () => void; syncHold: () => void } {
  let countDesc: HTMLElement | null = null;
  let holdDesc: HTMLElement | null = null;
  const hold = () => (opts.getUnlocked() ? opts.getHold() : null);

  const refreshCount = (): void => {
    const el = countDesc;
    if (!el || !opts.getUnlocked()) return;
    el.setText(trashCountLabel({ status: "loading" }));
    opts.trash.list()
      .then((entries) => {
        el.setText(trashCountLabel({ status: "loaded", count: entries.length }));
      })
      .catch(() => el.setText(trashCountLabel({ status: "error" })));
  };
  const syncHold = (): void => {
    const held = hold();
    if (held) holdDesc?.setText(holdSentence(held.files.length));
  };

  const rows: SettingsRow[] = [{
    name: "Deleted files",
    render: (row) => {
      row.settingEl.dataset.testid = "geode-settings-trash-count";
      countDesc = row.descEl.createSpan();
      row.addButton((btn) => {
        btn.setButtonText("View");
        btn.buttonEl.dataset.testid = "geode-settings-open-trash";
        btn.onClick(() => opts.openTrashModal());
      });
      refreshCount();
    },
  }, {
    name: TRASH_RETENTION_ROW,
    desc: "Days to keep deleted files before they can be purged.",
    control: { type: "number", key: "trashRetentionDays", min: 1, validate: wholeAtLeastOne },
  }, {
    name: "Hold large deletions",
    desc: "Holds sync when this many files and this percent go missing.",
    render: (row) => renderMassDeleteThresholds(row, opts.settings, opts.saveSettings),
  }, {
    // #601: the same review is reachable from the Trash section while held; hidden otherwise.
    name: "Missing files",
    visible: () => hold() !== null,
    render: (row) => {
      row.settingEl.dataset.testid = "geode-settings-trash-hold";
      holdDesc = row.descEl.createSpan();
      row.addButton((btn) => {
        btn.setButtonText("Review");
        btn.buttonEl.dataset.testid = "geode-settings-trash-review";
        btn.onClick(() => opts.openMassDeleteReview());
      });
      syncHold();
    },
  }];
  return { rows, refreshCount, syncHold };
}

/** #601: the guard the reconciler runs, read on every pass so a change applies without a
 * restart. Always on: the two numbers are the whole setting, there is no off switch. */
function renderMassDeleteThresholds(
  trigger: Setting,
  settings: { massDeleteMinFiles: number; massDeleteMinPercent: number },
  saveSettings: () => void,
): void {
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
