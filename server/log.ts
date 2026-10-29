// deno-lint-ignore-file no-console
import { addSink, emit, type LogEntry } from "../core/log.ts";

/** Serialize a LogEntry to a single flat JSON line for journalctl. */
export function formatServerLine(entry: LogEntry): string {
  const obj: Record<string, unknown> = {
    ts: new Date(entry.ts).toISOString(),
    level: entry.level,
    msg: entry.msg,
  };
  for (const [k, v] of Object.entries(entry.fields)) {
    obj[k] = v;
  }
  return JSON.stringify(obj);
}

// Register JSON-console sink at module load
addSink((entry) => {
  const line = formatServerLine(entry);
  switch (entry.level) {
    case "info":
      console.log(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
    default:
      console.log(line);
  }
});

export const log = {
  info(msg: string, ctx: Record<string, unknown> = {}) {
    emit("info", msg, ctx);
  },
  warn(msg: string, ctx: Record<string, unknown> = {}) {
    emit("warn", msg, ctx);
  },
  error(msg: string, ctx: Record<string, unknown> = {}) {
    emit("error", msg, ctx);
  },
};
