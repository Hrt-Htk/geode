import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// #44: the host update job's own files, written by the test into the folder the throwaway
// server reads as GEODE_UPDATE_STATUS_DIR. server.md §11 defines both formats.

export const epochNow = (): number => Math.floor(Date.now() / 1000);

/** A fresh state folder: a heartbeat can make the job "installed", its absence "no job". */
export function statusDir(): string {
  return mkdtempSync(path.join(tmpdir(), "geode-update-status-"));
}

/** The heartbeat the job writes on every run: fresh means installed, old means gone. */
export function writeHeartbeat(dir: string, ageSeconds = 0): void {
  writeFileSync(`${dir}/heartbeat`, `${epochNow() - ageSeconds}\n`);
}

/** One run's result, dated now so it answers the request the plugin just left. */
export function writeResult(dir: string, word: string): void {
  writeFileSync(`${dir}/result`, `${word} ${epochNow()}\n`);
}
