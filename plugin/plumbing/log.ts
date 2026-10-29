// deno-lint-ignore-file no-console
import { addSink, emit, type LogEntry, setDebugEnabled } from "../../core/log.ts";

export type { Level, LogEntry } from "../../core/log.ts";

const RING_SIZE = 2000;
const ring: LogEntry[] = [];
let ringHead = 0;
let consoleEnabled = false;
const listeners = new Set<(entry: LogEntry) => void>();

// Ring + subscriber sink: registered at module load
addSink((entry) => {
  if (ring.length < RING_SIZE) {
    ring.push(entry);
  } else {
    ring[ringHead] = entry;
    ringHead = (ringHead + 1) % RING_SIZE;
  }
  for (const l of listeners) {
    try {
      l(entry);
    } catch {
      // swallow listener errors
    }
  }
});

// Console sink for DevTools visibility: gated on debugLogging
addSink((entry) => {
  if (!consoleEnabled) return;
  const fields = Object.keys(entry.fields).length > 0 ? ` ${JSON.stringify(entry.fields)}` : "";
  const line = `[geode] [${entry.level}] ${entry.msg}${fields}`;
  switch (entry.level) {
    case "debug":
      console.debug(line);
      break;
    case "info":
      console.info(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
  }
});

export const log = {
  debug(msg: string, fields?: Record<string, unknown>): void {
    emit("debug", msg, fields);
  },
  info(msg: string, fields?: Record<string, unknown>): void {
    emit("info", msg, fields);
  },
  warn(msg: string, fields?: Record<string, unknown>): void {
    emit("warn", msg, fields);
  },
  error(msg: string, fields?: Record<string, unknown>): void {
    emit("error", msg, fields);
  },
};

export function setDebugLogging(enabled: boolean): void {
  setDebugEnabled(enabled);
  consoleEnabled = enabled;
}

export function getRecentLog(): LogEntry[] {
  if (ring.length < RING_SIZE) return [...ring];
  return [...ring.slice(ringHead), ...ring.slice(0, ringHead)];
}

export function subscribeLog(fn: (entry: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
