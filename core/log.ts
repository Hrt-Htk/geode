/** Shared logging core: pure fan-out with level gating.
 *
 * Emits `LogEntry` objects to registered sinks.  Does no formatting,
 * no console calls, no serialization: sinks decide their own output.
 */

export type Level = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** Epoch milliseconds. */
  ts: number;
  level: Level;
  msg: string;
  fields: Record<string, unknown>;
}

export type Sink = (entry: LogEntry) => void;

let sinks: Sink[] = [];
let debugEnabled = false;

/** Register a sink.  Returns an unsubscribe function that removes only that sink. */
export function addSink(sink: Sink): () => void {
  sinks.push(sink);
  return () => {
    sinks = sinks.filter((s) => s !== sink);
  };
}

/** Remove all registered sinks. */
export function clearSinks(): void {
  sinks = [];
}

/** Enable or disable debug-level emission.  Default: `false`. */
export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

/** Emit a log entry.  Debug entries are dropped when debug is disabled.
 * Each sink call is wrapped in try/catch so one throwing sink can't break others. */
export function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (level === "debug" && !debugEnabled) {
    return;
  }

  const entry: LogEntry = {
    ts: Date.now(),
    level,
    msg,
    fields: fields ?? {},
  };

  for (const sink of sinks) {
    try {
      sink(entry);
    } catch {
      // swallow: one bad sink must not break the fan-out chain
    }
  }
}
