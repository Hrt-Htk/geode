// #571: logs the estimate's listing step (file list, trash, one history
// request per file) with counts and timings, never paths or hashes, so a
// copied log explains where the estimate's time goes.
import { log } from "../plumbing/log.ts";
import type { RekeyClient } from "../sync/rekey-run.ts";

const PROGRESS_STEP = 0.1;

/** Runs `call` and logs `fields` of its result with how long it took. */
export async function logTimed<T>(
  step: string,
  call: () => Promise<T>,
  fields: (value: T) => Record<string, unknown>,
): Promise<T> {
  const start = performance.now();
  const value = await call();
  log.info(`rekey estimate: ${step}`, {
    ...fields(value),
    ms: Math.round(performance.now() - start),
  });
  return value;
}

/** The listing calls of `client`, timed and counted into the log. */
export function traceListing(client: RekeyClient): RekeyClient {
  let files = 0;
  let done = 0;
  let nextReport = PROGRESS_STEP;
  let listStart = 0;
  let requestMs = 0;
  let slowestMs = 0;
  return {
    ...client,
    async heads() {
      const heads = await logTimed("file list", () => client.heads(), (v) => ({ files: v.length }));
      files = heads.length;
      listStart = performance.now();
      return heads;
    },
    trash: () => logTimed("trash", () => client.trash(), (v) => ({ entries: v.length })),
    async versionChain(pathHash) {
      const start = performance.now();
      const value = await client.versionChain(pathHash);
      const ms = performance.now() - start;
      done++;
      requestMs += ms;
      slowestMs = Math.max(slowestMs, ms);
      const elapsed = Math.round(performance.now() - listStart);
      if (done === files) {
        log.info("rekey estimate: file histories done", {
          files,
          wall_ms: elapsed,
          avg_request_ms: Math.round(requestMs / done),
          slowest_request_ms: Math.round(slowestMs),
        });
      } else if (done >= files * nextReport) {
        log.info("rekey estimate: file histories", { done, files, elapsed_ms: elapsed });
        while (done >= files * nextReport) nextReport += PROGRESS_STEP;
      }
      return value;
    },
  };
}
