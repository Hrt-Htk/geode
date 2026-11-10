import { windowGlobal } from "./window.ts";

/** Reject when `work` has not settled within `ms`.
 *
 * The sync pipeline runs inside one version queue: an await that never settles (a dead
 * mobile FS bridge, a socket that stops answering) would hold that queue forever, which is
 * a stalled sync with no error to retry. Every such await gets a bound, so it fails into
 * the existing retry instead. */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = windowGlobal.setTimeout(
      () => reject(new Error(`${what} timed out after ${ms}ms`)),
      ms,
    );
    work.then(
      (value) => {
        windowGlobal.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        windowGlobal.clearTimeout(timer);
        // eslint wants an Error instance; anything else is stringified rather than dropped.
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
