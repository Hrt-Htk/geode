import { setIcon, Setting } from "obsidian";

/** Collapsible settings-section heading (mockup #134): chevron + click toggle. */
export type CollapsibleSection = {
  /** The whole section (heading + fields): hide/show this to hide a section. */
  sectionEl: HTMLElement;
  headingEl: HTMLElement;
  fieldsEl: HTMLElement;
};

export function createCollapsibleSection(
  container: HTMLElement,
  name: string,
  opts: { open: boolean; onToggle: (open: boolean) => void },
): CollapsibleSection {
  const sectionEl = container.createDiv({ cls: "geode-section" });
  const heading = new Setting(sectionEl).setHeading().setName(name);
  heading.settingEl.addClass("geode-collapsible-heading");
  const chevron = heading.nameEl.createSpan({ cls: "geode-section-chevron" });
  setIcon(chevron, "chevron-right");
  const fieldsEl = sectionEl.createDiv({ cls: "geode-section-fields" });
  const setOpen = (open: boolean) => {
    fieldsEl.classList.toggle("geode-collapsed", !open);
    chevron.classList.toggle("geode-chevron-rotated", open);
  };
  heading.settingEl.addEventListener("click", () => {
    const open = fieldsEl.classList.contains("geode-collapsed");
    opts.onToggle(open);
    setOpen(open);
  });
  setOpen(opts.open);
  return { sectionEl, headingEl: heading.settingEl, fieldsEl };
}
