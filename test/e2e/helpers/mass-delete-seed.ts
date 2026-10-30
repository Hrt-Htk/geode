// #601: the review window's approved shots use the mockup's exact missing-file sets, so the
// screenshot spec seeds the same paths (and the same last-known edit times) into a real vault.
// The set is generated here, not copied from the mockup plugin: the class names and the copy are
// the contract, the numbers are these two seeds.

import { expect } from "@playwright/test";
import { type GeodeSettings, launchObsidian, type ObsidianInstance } from "../fixtures/obsidian";
import { waitForUnlocked } from "./geode";
import type { Evaluatable } from "./device-abstraction";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NOTE_STEMS = [
  "Budget review",
  "Roadmap",
  "Vendor call",
  "Hiring loop",
  "Customer notes",
  "Release notes",
];
const MEETING_STEMS = ["Weekly sync", "Board deck", "Client call", "Planning", "Retro"];
const SCRATCH_STEMS = ["Draft intro", "Todo", "Ideas", "Scratchpad", "Snippet", "Reading list"];
const OLD_STEMS = ["Legacy roadmap", "Retreat notes", "Vendor list"];

export type SeedFile = { path: string; edited: number };

export type MockupSet = {
  /** Files the hold reports missing, with their last known edit time. */
  held: SeedFile[];
  /** Files that stay on disk: held.length + rest = the tracked total. */
  rest: SeedFile[];
};

function spreadNotes(
  folder: string,
  stems: string[],
  count: number,
  from: number,
  spanDays: number,
): SeedFile[] {
  const out: SeedFile[] = [];
  for (let i = 0; i < count; i++) {
    const at = from + Math.round((i * spanDays) / count) * DAY_MS;
    const d = new Date(at);
    out.push({
      path: `${folder}${stems[i % stems.length]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}.md`,
      edited: at + (9 + (i % 6)) * 3_600_000,
    });
  }
  return out;
}

function dailyNotes(count: number): SeedFile[] {
  const out: SeedFile[] = [];
  const end = Date.UTC(2026, 9, 8);
  for (let i = 0; i < count; i++) {
    const at = end - i * DAY_MS;
    const d = new Date(at);
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    out.push({ path: `Daily/${d.getUTCFullYear()}-${mm}-${dd}.md`, edited: at + 20 * 3_600_000 });
  }
  return out;
}

const SETS: Record<"large" | "small", SeedFile[]> = {
  // 1,850 of 2,400 tracked: an archive folder holding most of it.
  large: [
    ...spreadNotes("Archive/2023/Q1/", NOTE_STEMS, 400, Date.UTC(2023, 0, 3), 90),
    ...spreadNotes("Archive/2023/Q2/", NOTE_STEMS, 430, Date.UTC(2023, 3, 3), 90),
    ...spreadNotes("Archive/2023/Q3/", NOTE_STEMS, 420, Date.UTC(2023, 6, 3), 90),
    ...spreadNotes("Archive/2023/Q4/", NOTE_STEMS, 450, Date.UTC(2023, 9, 2), 90),
    ...spreadNotes("Archive/2023/Meetings/", MEETING_STEMS, 100, Date.UTC(2023, 0, 4), 360),
    ...dailyNotes(40),
    ...spreadNotes("Projects/Old/", OLD_STEMS, 10, Date.UTC(2022, 2, 7), 240),
  ],
  // Below the 25 % trigger's noise: 22 of 60 tracked, one folder.
  small: spreadNotes("Scratch/", SCRATCH_STEMS, 22, Date.UTC(2026, 6, 30), 70),
};

/** The tracked files that stay: `tracked` minus the held set, in their own folder. */
function withRest(held: SeedFile[], tracked: number): MockupSet {
  const count = tracked - held.length;
  const rest: SeedFile[] = [];
  for (let i = 0; i < count; i++) {
    rest.push({
      path: `Notes/note ${String(i).padStart(3, "0")}.md`,
      edited: Date.UTC(2025, 0, 1) + i * 3_600_000,
    });
  }
  return { held, rest };
}

export function mockupSet(name: "large" | "small"): MockupSet {
  return withRest(SETS[name], name === "large" ? 2_400 : 60);
}

/** Write every seeded file into a vault dir before Obsidian launches, keeping the edit times
 * (the held row's mtime is the last synced one, so the Recent list must see them at seed time). */
export async function writeSeedVault(
  vaultDir: string,
  files: SeedFile[],
  content: (file: SeedFile) => string,
): Promise<void> {
  const folders = new Set(files.map((f) => path.dirname(f.path)).filter((d) => d !== "."));
  for (const folder of folders) {
    await mkdir(path.join(vaultDir, ...folder.split("/")), { recursive: true });
  }
  for (const file of files) {
    const full = path.join(vaultDir, ...file.path.split("/"));
    await writeFile(full, content(file));
    const at = new Date(file.edited);
    await utimes(full, at, at);
  }
}

/** Delete a seeded set from disk behind the app's back (the app is closed or never saw them). */
export async function deleteSeedFiles(vaultDir: string, files: SeedFile[]): Promise<void> {
  for (const file of files) {
    await rm(path.join(vaultDir, ...file.path.split("/")), { force: true });
  }
}

/** Wait until the instance holds exactly `count` missing files (the reconciler tripped). */
export async function waitForHold(
  instance: Evaluatable,
  count: number,
  timeoutMs = 120_000,
): Promise<void> {
  await expect
    .poll(
      () =>
        instance.eval<number | null>(
          "app.plugins.plugins.geode.settings.massDeleteHold?.files.length ?? null",
        ),
      { timeout: timeoutMs },
    )
    .toBe(count);
}

/** Close the app, delete the held files from disk behind its back, relaunch and unlock: the
 * first reconciler pass trips the guard. `extraArgs` carries launch switches the first instance had
 * (e.g. a host-resolver rule). Returns the relaunched instance. */
export async function restartHeld(
  o: ObsidianInstance,
  held: { path: string }[],
  count: number,
  passphrase: string,
  extraArgs?: string[],
): Promise<ObsidianInstance> {
  const vaultDir = o.vaultDir;
  const settings: GeodeSettings = o.settings;
  await o.close();
  await deleteSeedFiles(vaultDir, held);
  const again = await launchObsidian({
    geodeSettings: settings,
    unlockPassphrase: passphrase,
    vaultDir,
    extraArgs,
  });
  await waitForUnlocked(again);
  await waitForHold(again, count);
  return again;
}
