// #624: `consoleErrors()` is a spec gate (`expect(await x.consoleErrors()).toEqual([])`), but the
// renderer also reports Obsidian's and Capacitor's own errors. Keep only errors that came from
// Geode; unknown noise is not a Geode failure.

export type ConsoleErrorEntry = {
  /** Console message text, or an uncaught error's message. */
  text: string;
  /** `Error.stack` when the source was a pageerror. */
  stack?: string | undefined;
};

// Obsidian loads a plugin's main.js with the sourceURL `plugin:<id>`, so every Geode frame reads
// `plugin:geode:<line>:<col>`: verified on desktop and on Android.
const GEODE_FRAME = "plugin:geode";
// Geode's own console sink prefixes every line (plugin/plumbing/log.ts, debug logging on).
const GEODE_LOG_PREFIX = "[geode]";

export function isGeodeConsoleError(entry: ConsoleErrorEntry): boolean {
  const haystack = `${entry.text}\n${entry.stack ?? ""}`;
  return haystack.includes(GEODE_FRAME) || haystack.includes(GEODE_LOG_PREFIX);
}
