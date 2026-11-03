/** #16: the settings tab as one tree of sections, obsidian-free. Obsidian 1.13+ renders it
 * from definitionsOf(); older versions render the same sections in display(). */

export type TreeSection<Row> = {
  id: string;
  /** "" renders no heading on either path. */
  heading: string;
  /** lead: headless on 1.13+ (headed in display()); group: headed; page: a sub-page on 1.13+. */
  kind: "lead" | "group" | "page";
  rows: Row[];
  visible?: () => boolean;
};

type TreePage<Row> = { type: "page"; name: string; items: Row[]; visible?: () => boolean };

type TreeGroup<Row> = {
  type: "group";
  heading?: string;
  items: (Row | TreePage<Row>)[];
  visible?: () => boolean;
};

export function definitionsOf<Row>(sections: TreeSection<Row>[]): TreeGroup<Row>[] {
  const groups: TreeGroup<Row>[] = [];
  const pages: TreePage<Row>[] = [];
  for (const s of sections) {
    if (s.kind === "page") {
      pages.push({ type: "page", name: s.heading, items: s.rows, visible: s.visible });
    } else if (s.kind === "group") {
      groups.push({ type: "group", heading: s.heading, items: s.rows, visible: s.visible });
    } else {
      groups.push({ type: "group", items: s.rows, visible: s.visible });
    }
  }
  if (pages.length > 0) groups.push({ type: "group", items: pages });
  return groups;
}

/** The number controls (auto lock hours, trash retention days): a rejected value is not saved. */
export function wholeAtLeastOne(value: number): string | undefined {
  return Number.isInteger(value) && value >= 1 ? undefined : "Enter a whole number, 1 or more.";
}
