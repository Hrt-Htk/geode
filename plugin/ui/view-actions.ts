export interface ViewActionsCandidate {
  /** Has the `mod-raised` modifier (Obsidian applies this to phone view headers, not tablets). */
  raised: boolean;
  /** Currently laid out (offsetParent !== null). */
  visible: boolean;
}

/**
 * Choose which `.view-actions` container the mobile status shim should inject into.
 * Preference: a visible raised container (phones) → any visible container (tablets, which lack
 * `mod-raised`) → the first container. Returns -1 when there are no candidates.
 */
export function pickViewActionsIndex(candidates: ViewActionsCandidate[]): number {
  if (candidates.length === 0) return -1;
  const visibleRaised = candidates.findIndex((c) => c.visible && c.raised);
  if (visibleRaised >= 0) return visibleRaised;
  const visible = candidates.findIndex((c) => c.visible);
  if (visible >= 0) return visible;
  return 0;
}
