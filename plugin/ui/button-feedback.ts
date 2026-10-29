import { ButtonComponent, Notice } from "obsidian";
import { formatUserError } from "../plumbing/errors.ts";

/** Run an action with a busy button label and a success/error notice. */
export async function runWithFeedback(
  btn: ButtonComponent,
  workingLabel: string,
  successMsg: string,
  action: () => Promise<void> | void,
): Promise<void> {
  const originalLabel = btn.buttonEl.textContent;
  btn.buttonEl.disabled = true;
  btn.buttonEl.textContent = workingLabel;
  try {
    await action();
    btn.buttonEl.textContent = originalLabel;
    new Notice(successMsg);
  } catch (e: unknown) {
    btn.buttonEl.textContent = originalLabel;
    new Notice(`Geode: ${workingLabel.slice(0, -1)} failed. ${formatUserError(e)}`, 10000);
  } finally {
    btn.buttonEl.disabled = false;
  }
}
