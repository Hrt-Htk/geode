import { type ButtonComponent, requireApiVersion } from "obsidian";

/** #16: the red destructive button. `setWarning()` is deprecated since Obsidian 1.13, where it is
 * `setDestructive().setCta()`; before 1.13 it added `mod-warning`, and `setDestructive` is absent. */
export function setDestructive(btn: ButtonComponent): ButtonComponent {
  if (requireApiVersion("1.13.0")) return btn.setDestructive().setCta();
  btn.buttonEl.addClass("mod-warning");
  return btn;
}
