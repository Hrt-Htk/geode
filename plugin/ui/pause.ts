/** Pure pause-state copy + colour: no obsidian import (safe for deno unit tests). */
export type PauseColor = "grey" | "orange" | "red";

const MIN = 60_000;

// Age bands (#443): grey 0-10 min, orange 10-30 min, red >30: shared by the
// banner name, the settings dot and the status-bar pause-circle icon.
export function pauseAgeColor(pausedAt: number, now: number): PauseColor {
  const age = now - pausedAt;
  if (age < 10 * MIN) return "grey";
  if (age < 30 * MIN) return "orange";
  return "red";
}

export function pauseAgeLabel(pausedAt: number, now: number): string {
  const age = now - pausedAt;
  if (age < MIN) return "paused just now";
  const mins = Math.floor(age / MIN);
  if (mins < 60) return `paused ${mins} min ago`;
  return `paused ${Math.floor(mins / 60)} h ago`;
}

export function pauseTooltip(pausedAt: number, now: number): string {
  const label = pauseAgeLabel(pausedAt, now);
  return `Sync paused. ${label.charAt(0).toUpperCase()}${label.slice(1)}.`;
}

export function describePauseBanner(
  pausedAt: number,
  now: number,
): { desc: string; color: PauseColor } | null {
  if (pausedAt <= 0) return null;
  return { desc: pauseAgeLabel(pausedAt, now), color: pauseAgeColor(pausedAt, now) };
}
